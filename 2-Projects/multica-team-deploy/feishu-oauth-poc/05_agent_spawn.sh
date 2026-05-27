#!/usr/bin/env bash
set -euo pipefail

# 关键: 确保 PATH 含 lark-cli 安装位置 (multica daemon spawn 时 PATH 可能缺 nvm)
export PATH="$HOME/.nvm/versions/node/v22.12.0/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

BASE_DIR="${MULTICA_USER_HOMES_DIR:-/Users/rayman.chen/multica-user-homes}"
MAPPING_FILE="${MULTICA_USER_MAPPING_FILE:-/Users/rayman.chen/multica-user-homes/user_mapping.json}"
LARK_BIN="${LARK_BIN:-/Users/rayman.chen/.nvm/versions/node/v22.12.0/bin/lark-cli}"

err() { echo "$*" >&2; }
emit_json() {
  local payload="$1"
  echo "$payload" | jq -e . >/dev/null
  printf '%s\n' "$payload"
}

if [ ! -x "$LARK_BIN" ]; then
  emit_json "$(jq -n --arg p "$LARK_BIN" '{ok:false,error:"lark_cli_not_executable",hint:"check LARK_BIN path",lark_bin:$p}')"
  exit 127
fi

if [ "${1:-}" = "" ] || [ "${2:-}" = "" ]; then
  err "用法: $0 <multica_user_id> <lark-cli-cmd...>"
  exit 1
fi

USER_ID="$1"
shift

if ! printf '%s' "$USER_ID" | grep -Eq '^[A-Za-z0-9._-]+$'; then
  err "multica_user_id 格式非法: 仅允许字母数字._-"
  exit 1
fi

USER_HOME="${BASE_DIR}/mc-user-${USER_ID}"
if [ ! -d "$USER_HOME" ]; then
  emit_json "$(jq -n --arg uid "$USER_ID" '{ok:false,error:"home_not_found",multica_user_id:$uid}')"
  exit 1
fi

if [ ! -f "$MAPPING_FILE" ] || ! jq -e . "$MAPPING_FILE" >/dev/null 2>&1; then
  emit_json "$(jq -n '{ok:false,error:"mapping_missing_or_invalid"}')"
  exit 1
fi

if ! jq -e --arg uid "$USER_ID" 'map(select(.multica_user_id == $uid)) | length > 0' "$MAPPING_FILE" >/dev/null; then
  emit_json "$(jq -n --arg uid "$USER_ID" '{ok:false,error:"binding_not_found",multica_user_id:$uid,hint:"user must complete oauth"}')"
  exit 1
fi

# 关键改进: 不再做 lark-cli 输出 string match 预检查 (V1 误判源)
# 直接 exec lark-cli, 让真实 OAuth 错误码透传给上层 skill (V2) 分类
exec env HOME="$USER_HOME" "$LARK_BIN" "$@"
