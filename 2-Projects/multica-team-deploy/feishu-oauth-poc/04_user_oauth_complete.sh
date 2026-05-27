#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="${MULTICA_USER_HOMES_DIR:-$HOME/multica-user-homes}"
MAPPING_FILE="${MULTICA_USER_MAPPING_FILE:-$HOME/multica-user-homes/user_mapping.json}"
TIMEOUT_SECONDS=180

err() {
  echo "$*" >&2
}

emit_json() {
  local payload="$1"
  echo "$payload" | jq -e . >/dev/null
  printf '%s\n' "$payload"
}

if [ "${1:-}" = "" ] || [ "${2:-}" = "" ]; then
  err "用法：$0 <multica_user_id> <device_code>"
  exit 1
fi

USER_ID="$1"
DEVICE_CODE="$2"
if ! printf '%s' "$USER_ID" | grep -Eq '^[A-Za-z0-9._-]+$'; then
  err "multica_user_id 格式非法：仅允许字母数字._-"
  exit 1
fi

USER_HOME="${BASE_DIR}/mc-user-${USER_ID}"
if [ ! -d "$USER_HOME" ] || [ ! -f "$USER_HOME/.lark-cli/config.json" ]; then
  err "USER_HOME 未 provision，请先运行 02_user_provision.sh"
  exit 1
fi

tmp_out="$(mktemp)"
tmp_err="$(mktemp)"
cleanup() {
  rm -f "$tmp_out" "$tmp_err"
}
trap cleanup EXIT

(
  HOME="$USER_HOME" lark-cli auth login --device-code "$DEVICE_CODE" --json >"$tmp_out" 2>"$tmp_err"
) &
pid=$!

start_ts="$(date +%s)"
while kill -0 "$pid" 2>/dev/null; do
  now_ts="$(date +%s)"
  if [ $((now_ts - start_ts)) -ge "$TIMEOUT_SECONDS" ]; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    err "auth login polling 超时（${TIMEOUT_SECONDS}s）"
    exit 1
  fi
  sleep 1
done

if ! wait "$pid"; then
  cat "$tmp_err" >&2
  exit 1
fi

poll_json="$(cat "$tmp_out")"
echo "$poll_json" | jq -e . >/dev/null

scopes_json="$(echo "$poll_json" | jq -c '.scope // .scopes // []')"

status_raw="$(HOME="$USER_HOME" lark-cli auth status --json 2>/dev/null || HOME="$USER_HOME" lark-cli auth status)"

if echo "$status_raw" | jq -e . >/dev/null 2>&1; then
  lark_user_open_id="$(echo "$status_raw" | jq -r '.userOpenId // .user_open_id // .open_id // .user.open_id // empty')"
  lark_user_name="$(echo "$status_raw" | jq -r '.userName // .lark_user_name // .user_name // .name // .user.name // empty')"
else
  lark_user_open_id="$(printf '%s\n' "$status_raw" | sed -n 's/.*open[_ -]*id[[:space:]]*:[[:space:]]*//Ip' | head -n1 | tr -d '\r')"
  lark_user_name="$(printf '%s\n' "$status_raw" | sed -n 's/.*user[_ -]*name[[:space:]]*:[[:space:]]*//Ip' | head -n1 | tr -d '\r')"
fi

if [ -z "$lark_user_open_id" ] || [ -z "$lark_user_name" ]; then
  err "无法从 auth status 提取 user_open_id 或 user_name"
  exit 1
fi

mapping_dir="$(dirname "$MAPPING_FILE")"
mkdir -p "$mapping_dir"
if [ ! -f "$MAPPING_FILE" ]; then
  printf '[]\n' > "$MAPPING_FILE"
fi

if ! jq -e . "$MAPPING_FILE" >/dev/null 2>&1; then
  err "mapping 文件不是合法 JSON：$MAPPING_FILE"
  exit 1
fi

now_iso="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
tmp_map="$(mktemp "${mapping_dir}/user_mapping.json.tmp.XXXXXX")"

jq --arg uid "$USER_ID" \
   --arg openid "$lark_user_open_id" \
   --arg uname "$lark_user_name" \
   --arg home "$USER_HOME" \
   --arg now "$now_iso" \
   '
   (map(select(.multica_user_id != $uid)))
   + [
       {
         multica_user_id: $uid,
         lark_user_open_id: $openid,
         lark_user_name: $uname,
         home: $home,
         provisioned_at: $now
       }
     ]
   ' "$MAPPING_FILE" > "$tmp_map"

mv "$tmp_map" "$MAPPING_FILE"

payload="$(jq -n \
  --arg multica_user_id "$USER_ID" \
  --arg lark_user_open_id "$lark_user_open_id" \
  --arg lark_user_name "$lark_user_name" \
  --argjson scopes "$scopes_json" \
  '{ok:true,multica_user_id:$multica_user_id,lark_user_open_id:$lark_user_open_id,lark_user_name:$lark_user_name,scopes:$scopes}')"

emit_json "$payload"
