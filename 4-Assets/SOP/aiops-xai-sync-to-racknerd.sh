#!/usr/bin/env bash
# 用途：本机统一刷新 xAI/Grok OAuth，并脱敏同步到 RackNerd ops-terminal，避免远端/本机 refresh token 轮换冲突。
set -euo pipefail

REFRESH="$HOME/mycc/4-Assets/SOP/omp-xai-token-refresh.py"
REMOTE="${AI_OPS_REMOTE:-racknerd}"
REMOTE_DIR="${AI_OPS_REMOTE_DIR:-/opt/ai-ops-cockpit/terminal}"
IF_EXPIRING_SECONDS="${XAI_SYNC_IF_EXPIRING_SECONDS:-14400}"
TMP_LOCAL="$(mktemp -t aiops-xai-auth.XXXXXX.json)"
TMP_REMOTE="$REMOTE_DIR/.xai-auth-import.json"

cleanup() {
  rm -f "$TMP_LOCAL"
  ssh "$REMOTE" "rm -f '$TMP_REMOTE'" >/dev/null 2>&1 || true
}
trap cleanup EXIT

python3 "$REFRESH" --if-expiring "$IF_EXPIRING_SECONDS" --quiet
python3 - "$HOME/.grok/auth.json" "$TMP_LOCAL" <<'PY'
import json, os, sys
src = json.load(open(sys.argv[1]))
inner = next(iter(src.values()))
required = ["key", "refresh_token", "expires_at"]
missing = [key for key in required if not inner.get(key)]
if missing:
    raise SystemExit(f"missing fields: {missing}")
out = {next(iter(src)): {
    "key": inner["key"],
    "refresh_token": inner["refresh_token"],
    "expires_at": inner["expires_at"],
    "email": inner.get("email", ""),
    "user_id": inner.get("user_id", ""),
}}
with open(sys.argv[2], "w") as handle:
    json.dump(out, handle)
os.chmod(sys.argv[2], 0o600)
print("prepared_local_auth_json_without_printing_tokens")
PY

scp -q "$TMP_LOCAL" "$REMOTE:$TMP_REMOTE"
rsync -az "$REFRESH" "$REMOTE:$REMOTE_DIR/omp-xai-token-refresh.py"
ssh "$REMOTE" "docker cp '$REMOTE_DIR/omp-xai-token-refresh.py' ops-terminal:/tmp/omp-xai-token-refresh.py && docker cp '$TMP_REMOTE' ops-terminal:/tmp/xai-auth-import.json && docker exec ops-terminal bash -lc 'sudo chown ops:ops /tmp/xai-auth-import.json /tmp/omp-xai-token-refresh.py && mkdir -p ~/.grok && mv /tmp/xai-auth-import.json ~/.grok/auth.json && chmod 600 ~/.grok/auth.json && python3 /tmp/omp-xai-token-refresh.py --import-from-grok --quiet'"
echo "remote_import_done_without_printing_tokens"
