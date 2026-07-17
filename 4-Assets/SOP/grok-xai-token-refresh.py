#!/usr/bin/env python3
"""Grok Build (~/.grok/auth.json) xAI OAuth keep-warm 刷新

背景：
  SuperGrok / Grok Build 的 access token 约 6h 过期；refresh_token 每次刷新会轮换
  （旧 token 立即作废）。仅依赖 grok 进程内 on-use 刷新时，若机器闲置过久或刷新失败，
  登录态会丢，需重新 device-auth。

本脚本：
  只读写 ~/.grok/auth.json（不碰 omp）。定时 keep-warm，access 将过期时主动 refresh，
  把轮换后的 access/refresh/expires_at 原子写回，避免登录态丢失。

逻辑对齐：4-Assets/SOP/omp-xai-token-refresh.py（OIDC refresh_token grant）。
全程不打印 token 明文。

用法：
  grok-xai-token-refresh.py                 # 强制刷新一次
  grok-xai-token-refresh.py --check         # 只读报告
  grok-xai-token-refresh.py --if-expiring 14400  # 仅当 4h 内过期才刷新
  grok-xai-token-refresh.py --quiet         # cron/systemd 用

退出码：
  0 = 有效 / 已刷新 / 跳过（仍有效）
  3 = refresh_token 已作废（需重新 grok login --device-auth）
  4 = 网络/其他错误
  5 = 凭据缺失
  6 = 未能获取文件锁（另一实例在跑）

环境：
  XAI_REFRESH_PROXY / HTTPS_PROXY / https_proxy — 境外 OIDC 必走代理
  默认 http://127.0.0.1:10808；dev198 请设 http://10.9.1.57:10808（mini xray）
"""
from __future__ import annotations

import argparse
import base64
import datetime
import fcntl
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

HOME = os.path.expanduser("~")
GROK_AUTH = os.environ.get("GROK_AUTH_PATH", os.path.join(HOME, ".grok", "auth.json"))
STATUS_PATH = os.environ.get(
    "GROK_REFRESH_STATUS", os.path.join(HOME, ".grok", "xai-refresh-status.json")
)
LOCK_PATH = os.environ.get(
    "GROK_REFRESH_LOCK", os.path.join(HOME, ".grok", "xai-refresh.lock")
)

XAI_ISSUER = "https://auth.x.ai"
XAI_DISCOVERY_URL = f"{XAI_ISSUER}/.well-known/openid-configuration"
XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
ACCESS_TOKEN_CLIENT_SKEW_MS = 60_000
TIMEOUT = 30

PROXY = (
    os.environ.get("XAI_REFRESH_PROXY")
    or os.environ.get("HTTPS_PROXY")
    or os.environ.get("https_proxy")
    or os.environ.get("http_proxy")
    or "http://127.0.0.1:10808"
)


def log(msg: str, quiet: bool = False, force: bool = False) -> None:
    if not quiet or force:
        print(msg, flush=True)


def now_ms() -> int:
    return int(datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000)


def jwt_exp_ms(access_token: str | None) -> int | None:
    if not access_token:
        return None
    try:
        payload_b64 = access_token.split(".")[1]
        payload_b64 += "=" * (-len(payload_b64) % 4)
        payload = json.loads(base64.urlsafe_b64decode(payload_b64))
        return int(payload["exp"]) * 1000
    except Exception:
        return None


def parse_expires_at_ms(iso: str | None) -> int | None:
    if not iso:
        return None
    try:
        return int(
            datetime.datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000
        )
    except Exception:
        return None


def fmt_remaining(exp_ms: int | None) -> str:
    if not exp_ms:
        return "未知"
    mins = (exp_ms - now_ms()) / 60000
    state = "已过期" if mins < 0 else "有效"
    ts = datetime.datetime.fromtimestamp(exp_ms / 1000, datetime.timezone.utc).isoformat(
        timespec="seconds"
    )
    return f"{state}, 剩余 {round(mins, 1)} 分钟 (过期 {ts})"


def write_status(payload: dict) -> None:
    try:
        os.makedirs(os.path.dirname(STATUS_PATH) or ".", exist_ok=True)
        tmp = STATUS_PATH + ".tmp"
        data = dict(payload)
        data["ts"] = datetime.datetime.now(datetime.timezone.utc).isoformat().replace(
            "+00:00", "Z"
        )
        data["proxy"] = PROXY
        # never store tokens
        for k in list(data.keys()):
            if "token" in k.lower() or k in ("key", "access", "refresh"):
                del data[k]
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.chmod(tmp, 0o600)
        os.replace(tmp, STATUS_PATH)
    except Exception:
        pass


def _opener():
    handler = urllib.request.ProxyHandler({"http": PROXY, "https": PROXY})
    return urllib.request.build_opener(handler)


def _http(method: str, url: str, data=None, headers=None):
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    with _opener().open(req, timeout=TIMEOUT) as resp:
        return resp.status, resp.read().decode("utf-8", "replace")


def load_grok():
    """返回 (src_dict, top_key, inner) 或 None。"""
    if not os.path.exists(GROK_AUTH):
        return None
    try:
        with open(GROK_AUTH, encoding="utf-8") as f:
            src = json.load(f)
        if not isinstance(src, dict) or not src:
            return None
        top_key = next(iter(src))
        inner = src[top_key]
        if not isinstance(inner, dict):
            return None
        return src, top_key, inner
    except Exception:
        return None


def discover_token_endpoint() -> str:
    status, body = _http("GET", XAI_DISCOVERY_URL, headers={"Accept": "application/json"})
    if status != 200:
        raise RuntimeError(f"OIDC discovery 失败 HTTP {status}")
    ep = json.loads(body).get("token_endpoint", "")
    if not ep.startswith(f"{XAI_ISSUER}/"):
        raise RuntimeError(f"token_endpoint 非法: {ep}")
    return ep


def do_refresh(token_endpoint: str, refresh_token: str):
    body = urllib.parse.urlencode(
        {
            "grant_type": "refresh_token",
            "client_id": XAI_CLIENT_ID,
            "refresh_token": refresh_token,
        }
    ).encode()
    try:
        status, text = _http(
            "POST",
            token_endpoint,
            data=body,
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "Accept": "application/json",
            },
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
    exp_ms = now_ms() + int(data["expires_in"]) * 1000 - ACCESS_TOKEN_CLIENT_SKEW_MS
    return (
        "ok",
        {
            "access": data["access_token"],
            "refresh": new_refresh,
            "expires": exp_ms,
        },
    )


def store_grok(src: dict, top_key: str, inner: dict, creds: dict) -> None:
    inner = dict(inner)
    inner["key"] = creds["access"]
    inner["refresh_token"] = creds["refresh"]
    exp_dt = datetime.datetime.fromtimestamp(creds["expires"] / 1000, datetime.timezone.utc)
    inner["expires_at"] = exp_dt.isoformat().replace("+00:00", "Z")
    # 不覆盖 create_time（首次登录时间）；仅更新 token 相关
    src = dict(src)
    src[top_key] = inner
    os.makedirs(os.path.dirname(GROK_AUTH) or ".", exist_ok=True)
    tmp = GROK_AUTH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(src, f, indent=2)
        f.write("\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, GROK_AUTH)


def acquire_lock():
    os.makedirs(os.path.dirname(LOCK_PATH) or ".", exist_ok=True)
    fd = open(LOCK_PATH, "a+", encoding="utf-8")
    try:
        fcntl.flock(fd.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        fd.close()
        return None
    return fd


def main() -> int:
    ap = argparse.ArgumentParser(description="Grok Build xAI OAuth keep-warm")
    ap.add_argument("--check", action="store_true", help="只读报告，不联网不写")
    ap.add_argument(
        "--if-expiring",
        type=int,
        metavar="SEC",
        default=None,
        help="仅当 access token 在 SEC 秒内过期才刷新",
    )
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()
    q = args.quiet

    loaded = load_grok()
    if not loaded:
        log(f"❌ 缺少 {GROK_AUTH}，先跑: grok login --device-auth", q, force=True)
        write_status({"ok": False, "action": "missing_auth", "exit": 5})
        return 5

    src, top_key, inner = loaded
    access = inner.get("key") or ""
    refresh = inner.get("refresh_token") or ""
    exp_ms = parse_expires_at_ms(inner.get("expires_at")) or jwt_exp_ms(access)
    email = inner.get("email") or ""

    log(f"[当前] grok auth email={email or '?'} access: {fmt_remaining(exp_ms)}", q)
    log(f"[代理] {PROXY}", q)

    if args.check:
        ok = bool(exp_ms and exp_ms > now_ms() and refresh)
        write_status(
            {
                "ok": ok,
                "action": "check",
                "email": email,
                "expires_at": inner.get("expires_at"),
                "remaining_min": round((exp_ms - now_ms()) / 60000, 1) if exp_ms else None,
                "exit": 0 if ok else 3,
            }
        )
        return 0 if ok else 3

    if not refresh:
        log("❌ auth.json 无 refresh_token，需重新登录", q, force=True)
        write_status({"ok": False, "action": "missing_refresh", "email": email, "exit": 5})
        return 5

    if args.if_expiring is not None and exp_ms and (exp_ms - now_ms()) > args.if_expiring * 1000:
        log(f"✅ access token 仍有效(>{args.if_expiring}s)，跳过刷新", q)
        write_status(
            {
                "ok": True,
                "action": "skipped_still_valid",
                "email": email,
                "expires_at": inner.get("expires_at"),
                "remaining_min": round((exp_ms - now_ms()) / 60000, 1),
                "exit": 0,
            }
        )
        return 0

    lock_fd = acquire_lock()
    if lock_fd is None:
        log("⚠️ 另一实例正在刷新，跳过", q, force=True)
        write_status({"ok": True, "action": "lock_busy", "exit": 6})
        return 6

    try:
        try:
            token_endpoint = discover_token_endpoint()
        except Exception as e:
            log(f"❌ discovery 失败(检查代理 {PROXY}): {e}", q, force=True)
            write_status({"ok": False, "action": "discovery_fail", "error": str(e), "exit": 4})
            return 4

        kind, payload = do_refresh(token_endpoint, refresh)
        if kind == "ok":
            store_grok(src, top_key, inner, payload)
            log("✅ 刷新成功，已写回 ~/.grok/auth.json", q, force=True)
            log(f"   新 access token: {fmt_remaining(payload['expires'])}", q, force=True)
            exp_iso = (
                datetime.datetime.fromtimestamp(payload["expires"] / 1000, datetime.timezone.utc)
                .isoformat()
                .replace("+00:00", "Z")
            )
            write_status(
                {
                    "ok": True,
                    "action": "refreshed",
                    "email": email,
                    "expires_at": exp_iso,
                    "remaining_min": round((payload["expires"] - now_ms()) / 60000, 1),
                    "exit": 0,
                }
            )
            return 0

        if kind == "revoked":
            log(f"❌ refresh_token 已作废: {payload}", q, force=True)
            log("   恢复: grok login --device-auth", q, force=True)
            write_status(
                {
                    "ok": False,
                    "action": "revoked",
                    "email": email,
                    "error": str(payload)[:200],
                    "exit": 3,
                }
            )
            return 3

        log(f"❌ 刷新失败: {payload}", q, force=True)
        write_status(
            {
                "ok": False,
                "action": "refresh_error",
                "email": email,
                "error": str(payload)[:200],
                "exit": 4,
            }
        )
        return 4
    finally:
        try:
            fcntl.flock(lock_fd.fileno(), fcntl.LOCK_UN)
        except Exception:
            pass
        lock_fd.close()


if __name__ == "__main__":
    sys.exit(main())
