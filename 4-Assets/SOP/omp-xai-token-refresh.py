#!/usr/bin/env python3
"""omp xai-oauth(SuperGrok / grok-4.3) token 自动刷新 + 固化

背景：team 模式 review-3send/4send 的 grok lane 走 `omp --model xai-oauth/grok-4.3`，
凭据存 ~/.omp/agent/agent.db 的 auth_credentials(provider=xai-oauth)。
xAI 的 refresh_token **每次刷新都会轮换**(旧的立即作废)，且 grok-build CLI(~/.grok/auth.json)
与 omp 共用同一 OAuth 身份(client_id b1a00492-…)，两边谁先刷新就把对方那份作废成
"Refresh token has been revoked" → 这是 team 模式 grok 反复挂的根因。

本脚本的固化策略(keep-warm)：定时(< access token 6h 有效期)主动刷新一次，把轮换后的
新 token 同时写回 omp agent.db 与 grok auth.json，使两边 access token 始终有效 →
omp/grok 调用时不会再触发各自的 on-use 刷新 → 杜绝 rotation war。

逻辑严格对齐 omp 源码 packages/ai/src/utils/oauth/xai-oauth.ts:refreshXAIOAuthToken。
全程不打印 token 明文。

用法：
  omp-xai-token-refresh.py              # 强制刷新一次并固化(cron / 手动恢复用)
  omp-xai-token-refresh.py --check      # 只读报告当前过期状态，不联网不写
  omp-xai-token-refresh.py --if-expiring 5400   # 仅当 access token 90min 内过期才刷新(team 预检用)
  omp-xai-token-refresh.py --quiet      # 精简输出(cron 用)

退出码：0=有效/已刷新  3=refresh_token 已作废(需重新登录)  4=网络/其他错误  5=凭据缺失
"""
import argparse
import base64
import datetime
import hashlib
import json
import os
import sqlite3
import sys
import urllib.request
import urllib.error
import urllib.parse

HOME = os.path.expanduser("~")
AGENT_DB = os.path.join(HOME, ".omp/agent/agent.db")
GROK_AUTH = os.path.join(HOME, ".grok/auth.json")

XAI_ISSUER = "https://auth.x.ai"
XAI_DISCOVERY_URL = f"{XAI_ISSUER}/.well-known/openid-configuration"
XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
ACCESS_TOKEN_CLIENT_SKEW_MS = 60_000  # 对齐 omp，提前 60s 视为过期
TIMEOUT = 30

# 境外 endpoint 必走代理；launchd/cron 无 shell env 时用默认值，可用 XAI_REFRESH_PROXY 覆盖
PROXY = (
    os.environ.get("XAI_REFRESH_PROXY")
    or os.environ.get("HTTPS_PROXY")
    or os.environ.get("https_proxy")
    or "http://127.0.0.1:10808"
)


def log(msg, quiet=False, force=False):
    if not quiet or force:
        print(msg, flush=True)


def _opener():
    handler = urllib.request.ProxyHandler({"http": PROXY, "https": PROXY})
    return urllib.request.build_opener(handler)


def _http(method, url, data=None, headers=None):
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    with _opener().open(req, timeout=TIMEOUT) as resp:
        return resp.status, resp.read().decode("utf-8", "replace")


def now_ms():
    return int(datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000)


def jwt_exp_ms(access_token):
    """从 access_token(JWT) 解 exp claim(秒)→ms；解不出返回 None。不打印内容。"""
    try:
        payload_b64 = access_token.split(".")[1]
        payload_b64 += "=" * (-len(payload_b64) % 4)
        payload = json.loads(base64.urlsafe_b64decode(payload_b64))
        return int(payload["exp"]) * 1000
    except Exception:
        return None


def fmt_remaining(exp_ms):
    if not exp_ms:
        return "未知"
    mins = (exp_ms - now_ms()) / 60000
    state = "已过期" if mins < 0 else "有效"
    return f"{state}, 剩余 {round(mins, 1)} 分钟 (过期 {datetime.datetime.fromtimestamp(exp_ms/1000).astimezone().isoformat(timespec='seconds')})"


def load_omp_cred():
    if not os.path.exists(AGENT_DB):
        return None
    db = sqlite3.connect(AGENT_DB, timeout=15)
    try:
        db.execute("PRAGMA busy_timeout=15000")
        row = db.execute(
            "SELECT id, data, disabled_cause FROM auth_credentials WHERE provider='xai-oauth' ORDER BY updated_at DESC LIMIT 1"
        ).fetchone()
    finally:
        db.close()
    if not row:
        return None
    cid, data, disabled = row
    d = json.loads(data)
    return {"id": cid, "data": d, "disabled": disabled}


def load_grok_refresh():
    """返回 (inner_dict, top_key, refresh_token) 或 None。"""
    if not os.path.exists(GROK_AUTH):
        return None
    try:
        src = json.load(open(GROK_AUTH))
        top_key = next(iter(src))
        inner = src[top_key]
        return (src, top_key, inner.get("refresh_token"))
    except Exception:
        return None


def discover_token_endpoint():
    status, body = _http("GET", XAI_DISCOVERY_URL, headers={"Accept": "application/json"})
    if status != 200:
        raise RuntimeError(f"OIDC discovery 失败 HTTP {status}")
    ep = json.loads(body).get("token_endpoint", "")
    if not ep.startswith(f"{XAI_ISSUER}/"):
        raise RuntimeError(f"token_endpoint 非法: {ep}")
    return ep


def do_refresh(token_endpoint, refresh_token):
    """返回 ('ok', {access,refresh,expires}) | ('revoked', detail) | ('error', detail)。"""
    body = urllib.parse.urlencode(
        {"grant_type": "refresh_token", "client_id": XAI_CLIENT_ID, "refresh_token": refresh_token}
    ).encode()
    try:
        status, text = _http(
            "POST",
            token_endpoint,
            data=body,
            headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"},
        )
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8", "replace")
        except Exception:
            pass
        if e.code == 400 and ("invalid_grant" in detail or "revoked" in detail):
            return ("revoked", f"{e.code} {detail.strip()}")
        return ("error", f"HTTP {e.code} {detail.strip()}")
    except Exception as e:
        return ("error", str(e))
    if status != 200:
        return ("error", f"HTTP {status}")
    data = json.loads(text)
    if not data.get("access_token") or not isinstance(data.get("expires_in"), (int, float)):
        return ("error", "响应缺 access_token/expires_in")
    new_refresh = data.get("refresh_token") or refresh_token
    return (
        "ok",
        {
            "access": data["access_token"],
            "refresh": new_refresh,
            "expires": now_ms() + int(data["expires_in"]) * 1000 - ACCESS_TOKEN_CLIENT_SKEW_MS,
        },
    )


def store_omp(cid, old_data, creds):
    d = dict(old_data)
    d["access"] = creds["access"]
    d["refresh"] = creds["refresh"]
    d["expires"] = creds["expires"]
    db = sqlite3.connect(AGENT_DB, timeout=15)
    try:
        db.execute("PRAGMA busy_timeout=15000")
        db.execute(
            "UPDATE auth_credentials SET data=?, disabled_cause=NULL, updated_at=CAST(strftime('%s','now') AS INTEGER) WHERE id=?",
            (json.dumps(d), cid),
        )
        db.commit()
    finally:
        db.close()


def insert_omp(full_data):
    db = sqlite3.connect(AGENT_DB, timeout=15)
    try:
        db.execute("PRAGMA busy_timeout=15000")
        db.execute(
            "INSERT INTO auth_credentials (provider, credential_type, data, identity_key) VALUES ('xai-oauth','oauth',?,?)",
            (json.dumps(full_data), full_data.get("accountId")),
        )
        db.commit()
    finally:
        db.close()


def import_from_grok():
    """重登后:把 ~/.grok/auth.json 的新鲜 token 固化进 omp agent.db。
    返回 creds 或 None(grok auth.json 缺/字段不全)。"""
    g = load_grok_refresh()
    if not g:
        return None
    src, top_key, _ = g
    inner = src[top_key]
    access = inner.get("key")
    refresh = inner.get("refresh_token")
    exp_iso = inner.get("expires_at")
    if not (access and refresh and exp_iso):
        return None
    try:
        exp_ms = int(datetime.datetime.fromisoformat(exp_iso.replace("Z", "+00:00")).timestamp() * 1000)
    except Exception:
        return None
    creds = {"access": access, "refresh": refresh, "expires": exp_ms}
    cred = load_omp_cred()
    if cred:
        d = dict(cred["data"])
        d.update(creds)
        if inner.get("email"):
            d["email"] = inner["email"]
        if inner.get("user_id"):
            d["accountId"] = inner["user_id"]
        store_omp(cred["id"], cred["data"], creds)
    else:
        insert_omp({
            "access": access, "refresh": refresh, "expires": exp_ms,
            "email": inner.get("email", ""), "accountId": inner.get("user_id", ""),
        })
    return creds


def store_grok(creds):
    """把轮换后的 token 同步进 grok auth.json，保持两边一致(减少 on-use 刷新冲突)。"""
    g = load_grok_refresh()
    if not g:
        return False
    src, top_key, _ = g
    inner = src[top_key]
    inner["key"] = creds["access"]
    inner["refresh_token"] = creds["refresh"]
    exp_dt = datetime.datetime.fromtimestamp(creds["expires"] / 1000, datetime.timezone.utc)
    inner["expires_at"] = exp_dt.isoformat().replace("+00:00", "Z")
    inner["create_time"] = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    tmp = GROK_AUTH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(src, f, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, GROK_AUTH)
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="只读报告，不联网不写")
    ap.add_argument("--if-expiring", type=int, metavar="SEC", default=None,
                    help="仅当 access token 在 SEC 秒内过期才刷新")
    ap.add_argument("--import-from-grok", action="store_true",
                    help="重登后:把 ~/.grok/auth.json 新鲜 token 固化进 omp agent.db")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()
    q = args.quiet

    if args.import_from_grok:
        creds = import_from_grok()
        if not creds:
            log("❌ ~/.grok/auth.json 缺失或字段不全,先在真终端跑 `~/.grok/bin/grok login` 重新登录", q, force=True)
            return 5
        log(f"✅ 已从 grok auth.json 固化进 omp agent.db；access token: {fmt_remaining(creds['expires'])}", q, force=True)
        return 0

    cred = load_omp_cred()
    if not cred:
        log("❌ omp agent.db 无 xai-oauth 凭据，先跑 omp-supergrok-bypass-import.sh 导入", q, force=True)
        return 5

    exp_ms = cred["data"].get("expires") or jwt_exp_ms(cred["data"].get("access", ""))
    log(f"[当前] omp xai-oauth access token: {fmt_remaining(exp_ms)}", q)
    if cred["disabled"]:
        log(f"[当前] disabled_cause: {cred['disabled']}", q)

    if args.check:
        return 0 if (exp_ms and exp_ms > now_ms()) else 3

    if args.if_expiring is not None and exp_ms and (exp_ms - now_ms()) > args.if_expiring * 1000:
        log(f"✅ access token 仍有效(>{args.if_expiring}s)，跳过刷新", q)
        return 0

    # 联网刷新
    try:
        token_endpoint = discover_token_endpoint()
    except Exception as e:
        log(f"❌ discovery 失败(检查代理 {PROXY}): {e}", q, force=True)
        return 4

    # 候选 refresh token：omp 优先(team 真值)，其次 grok auth.json(可能更新)。去重。
    candidates = []
    omp_rt = cred["data"].get("refresh")
    if omp_rt:
        candidates.append(("omp", omp_rt))
    g = load_grok_refresh()
    if g and g[2] and g[2] != omp_rt:
        candidates.append(("grok", g[2]))

    last_detail = ""
    for src_name, rt in candidates:
        kind, payload = do_refresh(token_endpoint, rt)
        if kind == "ok":
            store_omp(cred["id"], cred["data"], payload)
            synced = store_grok(payload)
            log(f"✅ 刷新成功(用 {src_name} 的 refresh token)；已写回 omp agent.db"
                f"{' + grok auth.json' if synced else ''}", q, force=True)
            log(f"   新 access token: {fmt_remaining(payload['expires'])}", q, force=True)
            return 0
        last_detail = f"[{src_name}] {payload}"
        if kind == "revoked":
            log(f"   {src_name} 的 refresh token 已作废: {payload}", q)

    log(f"❌ 所有 refresh token 均失效 → 需重新登录。最后错误: {last_detail}", q, force=True)
    log("   恢复(川哥真终端一键): bash ~/mycc/4-Assets/SOP/omp-xai-relogin.sh", q, force=True)
    return 3


if __name__ == "__main__":
    sys.exit(main())
