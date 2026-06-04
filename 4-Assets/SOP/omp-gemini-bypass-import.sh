#!/usr/bin/env bash
# 用途：把 ~/.gemini/oauth_creds.json 的 Google Code Assist 订阅旁路导入 omp
# 适用：装好 omp 后想用 gemini CLI OAuth 调 google-gemini-cli/gemini-3-* 等模型
# 前提：~/.gemini/oauth_creds.json + ~/.gemini/google_accounts.json 存在
#       (gemini CLI 已登录过 Google 账户)
# 增量(vs SuperGrok / ChatGPT): Google CLI OAuth 必须有 projectId 字段才能 refresh,
#       否则 omp 调用必报 "Google Cloud credentials missing projectId"。
#       脚本会自动从 Code Assist API loadCodeAssist 端点 discover projectId
#       (用 omp 内 hardcoded 的 OAuth client_id/secret refresh 后调用)
# 沉淀：2026-06-04 cc 首次走通,见 RECENT_EVENTS / project_omp_grok43.md

set -euo pipefail

# 1. 检查前提
if [ ! -f "$HOME/.gemini/oauth_creds.json" ]; then
  echo "❌ ~/.gemini/oauth_creds.json 不存在,先跑 gemini CLI 登录"
  exit 1
fi
if [ ! -f "$HOME/.gemini/google_accounts.json" ]; then
  echo "❌ ~/.gemini/google_accounts.json 不存在"
  exit 1
fi
if ! command -v omp >/dev/null 2>&1; then
  echo "❌ omp 未安装,先 bun install -g @oh-my-pi/pi-coding-agent"
  exit 1
fi

# 2. 旁路 import 第一步: 把 oauth_creds.json 转 omp CliProxy 格式
TMP=$(mktemp -t omp_gemini_creds_XXXX.json)
trap "rm -f $TMP" EXIT

python3 - "$HOME/.gemini/oauth_creds.json" "$HOME/.gemini/google_accounts.json" "$TMP" <<'PY'
import json, sys, datetime
src = json.load(open(sys.argv[1]))
accounts = json.load(open(sys.argv[2]))
exp_unix = src["expiry_date"] / 1000  # epoch ms → s
expired = datetime.datetime.utcfromtimestamp(exp_unix).isoformat() + "Z"
out = {
    "type": "gemini",  # omp CLIPROXY_TYPE_TO_PROVIDER 内置 gemini→google-gemini-cli
    "access_token": src["access_token"],
    "refresh_token": src["refresh_token"],
    "id_token": src.get("id_token"),
    "expired": expired,
    "email": accounts.get("active", ""),
    "account_id": accounts.get("active", ""),
    "last_refresh": "",
}
open(sys.argv[3], "w").write(json.dumps(out, indent=2))
print(f"✅ 转换完: email={out['email']}, expired={expired}")
PY

# 3. dry-run + 正式 import
echo ""
echo "===== dry-run ====="
omp auth-broker import "$TMP" --provider=google-gemini-cli --dry-run
echo ""
echo "===== 正式 import ====="
omp auth-broker import "$TMP" --provider=google-gemini-cli

# 4. ★ 关键步骤: discover projectId 并写回 SQLite
# omp import 路径不调 discoverProject,但 refresh 时必须有 projectId,所以这里补上
echo ""
echo "===== discover Code Assist projectId 并更新 SQLite ====="
python3 <<'PY'
import json, base64, urllib.request, urllib.parse, sqlite3, pathlib, datetime, sys

# omp/google-gemini-cli.ts hardcoded client_id/secret (base64 encoded)
CLIENT_ID = base64.b64decode("NjgxMjU1ODA5Mzk1LW9vOGZ0Mm9wcmRybnA5ZTNhcWY2YXYzaG1kaWIxMzVqLmFwcHMuZ29vZ2xldXNlcmNvbnRlbnQuY29t").decode()
CLIENT_SECRET = base64.b64decode("R09DU1BYLTR1SGdNUG0tMW83U2stZ2VWNkN1NWNsWEZzeGw=").decode()

# ① Refresh token (~/.gemini 的 access_token 大概率已过期)
creds = json.loads(pathlib.Path.home().joinpath('.gemini/oauth_creds.json').read_text())
token_req = urllib.parse.urlencode({
    "client_id": CLIENT_ID,
    "client_secret": CLIENT_SECRET,
    "refresh_token": creds["refresh_token"],
    "grant_type": "refresh_token",
}).encode()
req = urllib.request.Request(
    "https://oauth2.googleapis.com/token",
    data=token_req,
    headers={"Content-Type": "application/x-www-form-urlencoded"},
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=30) as r:
        token_resp = json.loads(r.read())
    access_token = token_resp["access_token"]
    expires_in = token_resp.get("expires_in", 3600)
    new_expires_ms = int((datetime.datetime.utcnow().timestamp() + expires_in) * 1000)
    print(f"✅ refresh OK, expires_in={expires_in}s")
except Exception as e:
    print(f"❌ refresh failed: {e}")
    print("   常见原因: refresh_token 过期,先跑 gemini 重新登录刷新 ~/.gemini/oauth_creds.json")
    sys.exit(1)

# ② Discover projectId via Code Assist loadCodeAssist API
body = json.dumps({
    "cloudaicompanionProject": None,
    "metadata": {"ideType": "IDE_UNSPECIFIED", "platform": "PLATFORM_UNSPECIFIED", "pluginType": "GEMINI"},
}).encode()
req = urllib.request.Request(
    "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
    data=body,
    headers={"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"},
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=30) as r:
        load_resp = json.loads(r.read())
    project_id = load_resp.get("cloudaicompanionProject")
    tier = load_resp.get("currentTier", {}).get("id")
    print(f"✅ discover OK: projectId={project_id}, tier={tier}")
    if not project_id:
        print("⚠️ 未拿到 projectId, 可能需要先到 console.cloud.google.com 创建一个 GCP 项目")
        sys.exit(1)
except urllib.error.HTTPError as e:
    print(f"❌ loadCodeAssist failed {e.code}: {e.read().decode()[:200]}")
    sys.exit(1)

# ③ UPDATE SQLite: 加 projectId + 写入新 access_token + 新 expires
db_path = pathlib.Path.home().joinpath('.omp/agent/agent.db')
conn = sqlite3.connect(str(db_path))
cur = conn.cursor()
cur.execute("SELECT id, data FROM auth_credentials WHERE provider='google-gemini-cli';")
row = cur.fetchone()
if not row:
    print("❌ google-gemini-cli row 不在 SQLite,上一步 import 失败")
    sys.exit(1)
data = json.loads(row[1])
data["projectId"] = project_id
data["access"] = access_token
data["expires"] = new_expires_ms
cur.execute("UPDATE auth_credentials SET data=?, updated_at=strftime('%s','now') WHERE id=?",
            (json.dumps(data), row[0]))
conn.commit()
conn.close()
print(f"✅ SQLite 更新 (id={row[0]})")
PY

# 5. 实测
echo ""
echo "===== 实测 gemini-3-flash-preview ====="
omp -p --model google-gemini-cli/gemini-3-flash-preview --thinking minimal --auto-approve --no-tools \
  --no-extensions --no-skills --no-rules \
  "用一句话报告:你能回应吗?今天日期?"
RC=$?

echo ""
if [ $RC -eq 0 ]; then
  echo "🎉 完成。常用模型:"
  echo "  - gemini-3-flash-preview (1M context, 低延迟)"
  echo "  - gemini-3.1-flash-lite-preview (1M, 更快)"
  echo "  - gemini-3-pro-preview / gemini-3.1-pro-preview (1M, 高质量)"
  echo "  - gemini-2.5-flash / gemini-2.5-pro (1M, 兜底)"
  echo ""
  echo "调用模板:"
  echo '  omp -p --model google-gemini-cli/gemini-3-flash-preview "你的 prompt"'
else
  echo "❌ 实测失败 (RC=$RC)"
fi
exit $RC
