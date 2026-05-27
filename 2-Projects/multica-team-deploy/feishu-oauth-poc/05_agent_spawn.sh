#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="${MULTICA_USER_HOMES_DIR:-$HOME/multica-user-homes}"
MAPPING_FILE="${MULTICA_USER_MAPPING_FILE:-$HOME/multica-user-homes/user_mapping.json}"

err() {
  echo "$*" >&2
}

emit_json() {
  local payload="$1"
  echo "$payload" | jq -e . >/dev/null
  printf '%s\n' "$payload"
}

if [ "${1:-}" = "" ] || [ "${2:-}" = "" ]; then
  err "用法：$0 <multica_user_id> <lark-cli-cmd...>"
  exit 1
fi

USER_ID="$1"
shift

if ! printf '%s' "$USER_ID" | grep -Eq '^[A-Za-z0-9._-]+$'; then
  err "multica_user_id 格式非法：仅允许字母数字._-"
  exit 1
fi

USER_HOME="${BASE_DIR}/mc-user-${USER_ID}"
if [ ! -d "$USER_HOME" ]; then
  payload="$(jq -n --arg uid "$USER_ID" '{ok:false,error:"home_not_found",multica_user_id:$uid}')"
  emit_json "$payload"
  exit 1
fi

if [ ! -f "$MAPPING_FILE" ] || ! jq -e . "$MAPPING_FILE" >/dev/null 2>&1; then
  payload="$(jq -n '{ok:false,error:"mapping_missing_or_invalid"}')"
  emit_json "$payload"
  exit 1
fi

if ! jq -e --arg uid "$USER_ID" 'map(select(.multica_user_id == $uid)) | length > 0' "$MAPPING_FILE" >/dev/null; then
  payload="$(jq -n --arg uid "$USER_ID" '{ok:false,error:"binding_not_found",multica_user_id:$uid,hint:"user must complete oauth"}')"
  emit_json "$payload"
  exit 1
fi

status_raw="$(HOME="$USER_HOME" lark-cli auth status --json 2>/dev/null || HOME="$USER_HOME" lark-cli auth status 2>/dev/null || true)"
if [ -z "$status_raw" ]; then
  payload="$(jq -n '{ok:false,error:"token_invalid",hint:"user must re-auth"}')"
  emit_json "$payload"
  exit 1
fi

status_lc="$(printf '%s' "$status_raw" | tr '[:upper:]' '[:lower:]')"
if printf '%s' "$status_lc" | grep -Eq 'no_token|failed|invalid|expired'; then
  payload="$(jq -n '{ok:false,error:"token_invalid",hint:"user must re-auth"}')"
  emit_json "$payload"
  exit 1
fi

exec env HOME="$USER_HOME" lark-cli "$@"
