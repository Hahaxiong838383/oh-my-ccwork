#!/usr/bin/env bash
# Radar health v3: monitor the rendered archive and each upstream separately.
set -uo pipefail

THRESHOLD="${RADAR_PAGE_THRESHOLD:-300}"
LOG="${RADAR_HEALTH_LOG:-/var/log/radar-health.log}"
STATE="${RADAR_HEALTH_STATE:-/opt/radar-health.state}"
SITE_ENV="${RADAR_SITE_ENV:-/var/www/chenchuan-site/.env.local}"
AIHOT_URL='https://aihot.virxact.com/api/public/items?mode=all&take=1'
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
TS=$(date '+%F %T')

page_count=$(curl -sS --max-time 30 http://127.0.0.1:3000/radar 2>/dev/null | grep -o publishedAt | wc -l)
[[ "$page_count" -ge "$THRESHOLD" ]] && page_state=OK || page_state=CRIT

aihot_body=$(mktemp)
aihot_code=$(curl --http1.1 -sS --max-time 10 \
  -A "$UA" \
  -H 'Accept: application/json, text/plain, */*' \
  -e 'https://aihot.virxact.com/' \
  -o "$aihot_body" \
  -w '%{http_code}' \
  "$AIHOT_URL" 2>/dev/null || true)
aihot_count=$(jq -r 'if (.items | type) == "array" then (.items | length) else 0 end' "$aihot_body" 2>/dev/null || echo 0)
aihot_count=${aihot_count:-0}
rm -f "$aihot_body"
[[ "$aihot_code" == 200 && "$aihot_count" -gt 0 ]] && aihot_state=OK || aihot_state=CRIT

prev_page=OK
prev_aihot=OK
if [[ -f "$STATE" ]]; then
  if grep -q '=' "$STATE"; then
    prev_page=$(awk -F= '$1 == "PAGE" { print $2 }' "$STATE")
    prev_aihot=$(awk -F= '$1 == "AIHOT" { print $2 }' "$STATE")
    prev_page=${prev_page:-OK}
    prev_aihot=${prev_aihot:-OK}
  else
    prev_page=$(cat "$STATE" 2>/dev/null || echo OK)
  fi
fi
printf 'PAGE=%s\nAIHOT=%s\n' "$page_state" "$aihot_state" > "$STATE"
echo "$TS page=$page_state count=$page_count(prev=$prev_page) aihot=$aihot_state http=$aihot_code count=$aihot_count(prev=$prev_aihot)" >> "$LOG"

send_card() {
  local template="$1" title="$2" content="$3" webhook
  webhook=$(grep '^FEISHU_CHAT_ALERT_WEBHOOK=' "$SITE_ENV" 2>/dev/null | cut -d= -f2-)
  [[ -z "$webhook" ]] && return 0
  jq -n \
    --arg template "$template" \
    --arg title "$title" \
    --arg content "$content" \
    '{msg_type:"interactive",card:{config:{wide_screen_mode:true},header:{template:$template,title:{tag:"plain_text",content:$title}},elements:[{tag:"div",text:{tag:"lark_md",content:$content}}]}}' \
    | curl -sS -X POST "$webhook" -H 'content-type: application/json' -d @- >/dev/null 2>&1
}

if [[ "$page_state" != "$prev_page" ]]; then
  if [[ "$page_state" == CRIT ]]; then
    send_card orange '📡 雷达页面健康检查：异常' "线上 /radar 资讯条数 **$page_count** 条（阈值 $THRESHOLD）。\n- **时间**: $TS\n- **服务器**: aliyun-kr（韩国）"
  else
    send_card green '✅ 雷达页面健康检查：已恢复' "线上 /radar 资讯条数回到 **$page_count** 条。\n- **时间**: $TS"
  fi
fi

if [[ "$aihot_state" != "$prev_aihot" ]]; then
  if [[ "$aihot_state" == CRIT ]]; then
    resolved=$(getent ahostsv4 aihot.virxact.com 2>/dev/null | awk '{print $1}' | sort -u | paste -sd ',' -)
    send_card orange '📡 aihot 主源健康检查：异常' "aihot 实时接口不可用，已由本地归档 + yuweiwan 兜底。\n- **HTTP**: $aihot_code\n- **条数**: $aihot_count\n- **解析节点**: ${resolved:-none}\n- **时间**: $TS\n- **说明**: 持续异常期间不重复告警，恢复后另发通知"
  else
    send_card green '✅ aihot 主源：已恢复' "aihot 实时接口恢复，HTTP **$aihot_code**，本次 **$aihot_count** 条。\n- **时间**: $TS"
  fi
fi

tail -n 500 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
