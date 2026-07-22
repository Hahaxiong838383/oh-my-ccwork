#!/usr/bin/env bash
# Radar health v4: monitor the rendered archive, upstreams, and optional Horizon digest separately.
set -uo pipefail

THRESHOLD="${RADAR_PAGE_THRESHOLD:-300}"
FRESHNESS_THRESHOLD="${RADAR_FRESHNESS_THRESHOLD_SECONDS:-1200}"
LOG="${RADAR_HEALTH_LOG:-/var/log/radar-health.log}"
STATE="${RADAR_HEALTH_STATE:-/opt/radar-health.state}"
SITE_ENV="${RADAR_SITE_ENV:-/var/www/chenchuan-site/.env.local}"
SOURCE_HEALTH="${RADAR_SOURCE_HEALTH_FILE:-/var/www/chenchuan-site/data/radar-source-health.json}"
HORIZON_HEALTH="${RADAR_HORIZON_HEALTH_FILE:-/var/www/chenchuan-site/data/radar-horizon-health.json}"
HORIZON_FRESHNESS_THRESHOLD="${RADAR_HORIZON_FRESHNESS_THRESHOLD_SECONDS:-129600}"
ENDPOINT_REFRESH="${AIHOT_ENDPOINT_REFRESH_SCRIPT:-/opt/aihot-endpoint-refresh.sh}"
AIHOT_RETRIES="${AIHOT_HEALTH_RETRIES:-3}"
AIHOT_RETRY_DELAY="${AIHOT_HEALTH_RETRY_DELAY_SECONDS:-2}"
AIHOT_URL='https://aihot.virxact.com/api/public/items?mode=all&take=1'
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
TS=$(date '+%F %T')

page_count=$(curl -sS --max-time 30 http://127.0.0.1:3000/radar 2>/dev/null | grep -o publishedAt | wc -l)
[[ "$page_count" -ge "$THRESHOLD" ]] && page_state=OK || page_state=CRIT

aihot_code=000
aihot_count=0
aihot_attempt=0
while [[ "$aihot_attempt" -lt "$AIHOT_RETRIES" ]]; do
  aihot_attempt=$((aihot_attempt + 1))
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
  [[ "$aihot_code" == 200 && "$aihot_count" -gt 0 ]] && break
  if [[ "$aihot_attempt" -eq 1 && -x "$ENDPOINT_REFRESH" ]]; then
    "$ENDPOINT_REFRESH" >/dev/null 2>&1 || true
  fi
  [[ "$aihot_attempt" -lt "$AIHOT_RETRIES" ]] && sleep "$AIHOT_RETRY_DELAY"
done
[[ "$aihot_code" == 200 && "$aihot_count" -gt 0 ]] && aihot_state=OK || aihot_state=CRIT

# /radar uses SWR, so the page request above starts a background refresh. Give it time to
# advance source-health before declaring the application feed stale.
freshness_state=CRIT
freshness_age=-1
freshness_checked=none
for _ in $(seq 1 15); do
  freshness_checked=$(jq -r '.checkedAt // empty' "$SOURCE_HEALTH" 2>/dev/null || true)
  if [[ -n "$freshness_checked" ]]; then
    checked_epoch=$(date -d "$freshness_checked" +%s 2>/dev/null || echo 0)
    freshness_age=$(( $(date +%s) - checked_epoch ))
    if [[ "$checked_epoch" -gt 0 && "$freshness_age" -le "$FRESHNESS_THRESHOLD" ]]; then
      freshness_state=OK
      break
    fi
  fi
  sleep 2
done

# Horizon is an optional complementary digest. Its health never changes the existing
# PAGE/AIHOT/FRESHNESS verdicts, but it has its own transition-based alert.
horizon_state=UNKNOWN
horizon_age=-1
horizon_checked=none
horizon_mode=none
horizon_count=0
horizon_error=none
if [[ -f "$HORIZON_HEALTH" ]]; then
  horizon_checked=$(jq -r '.checkedAt // empty' "$HORIZON_HEALTH" 2>/dev/null || true)
  horizon_mode=$(jq -r '.mode // "none"' "$HORIZON_HEALTH" 2>/dev/null || echo none)
  horizon_count=$(jq -r '.itemCount // 0' "$HORIZON_HEALTH" 2>/dev/null || echo 0)
  horizon_error=$(jq -r '.error // "none"' "$HORIZON_HEALTH" 2>/dev/null || echo none)
  horizon_ok=$(jq -r '.ok // false' "$HORIZON_HEALTH" 2>/dev/null || echo false)
  horizon_checked_epoch=$(date -d "$horizon_checked" +%s 2>/dev/null || echo 0)
  if [[ "$horizon_checked_epoch" -gt 0 ]]; then
    horizon_age=$(( $(date +%s) - horizon_checked_epoch ))
  fi
  if [[ "$horizon_ok" == true && "$horizon_age" -ge 0 && "$horizon_age" -le "$HORIZON_FRESHNESS_THRESHOLD" ]]; then
    horizon_state=OK
  else
    horizon_state=CRIT
  fi
fi

prev_page=OK
prev_aihot=OK
prev_freshness=OK
prev_horizon=UNKNOWN
if [[ -f "$STATE" ]]; then
  if grep -q '=' "$STATE"; then
    prev_page=$(awk -F= '$1 == "PAGE" { print $2 }' "$STATE")
    prev_aihot=$(awk -F= '$1 == "AIHOT" { print $2 }' "$STATE")
    prev_freshness=$(awk -F= '$1 == "FRESHNESS" { print $2 }' "$STATE")
    prev_horizon=$(awk -F= '$1 == "HORIZON" { print $2 }' "$STATE")
    prev_page=${prev_page:-OK}
    prev_aihot=${prev_aihot:-OK}
    prev_freshness=${prev_freshness:-OK}
    prev_horizon=${prev_horizon:-UNKNOWN}
  else
    prev_page=$(cat "$STATE" 2>/dev/null || echo OK)
  fi
fi
printf 'PAGE=%s\nAIHOT=%s\nFRESHNESS=%s\nHORIZON=%s\n' "$page_state" "$aihot_state" "$freshness_state" "$horizon_state" > "$STATE"
echo "$TS page=$page_state count=$page_count(prev=$prev_page) aihot=$aihot_state http=$aihot_code count=$aihot_count attempts=$aihot_attempt(prev=$prev_aihot) freshness=$freshness_state age=${freshness_age}s checkedAt=$freshness_checked(prev=$prev_freshness) horizon=$horizon_state mode=$horizon_mode count=$horizon_count age=${horizon_age}s checkedAt=$horizon_checked(prev=$prev_horizon)" >> "$LOG"

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

if [[ "$freshness_state" != "$prev_freshness" ]]; then
  if [[ "$freshness_state" == CRIT ]]; then
    send_card orange '📡 雷达资讯刷新：停滞' "页面归档仍可用，但实时聚合缓存没有按期更新。\n- **缓存年龄**: ${freshness_age} 秒\n- **最后检查**: $freshness_checked\n- **时间**: $TS\n- **说明**: 可能是刷新锁卡住或双上游超时，页面继续使用本地归档"
  else
    send_card green '✅ 雷达资讯刷新：已恢复' "实时聚合缓存重新推进。\n- **缓存年龄**: ${freshness_age} 秒\n- **最后检查**: $freshness_checked\n- **时间**: $TS"
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

if [[ "$horizon_state" == CRIT && "$prev_horizon" != CRIT ]]; then
  send_card orange '📡 每日 AI 精选：异常' "Horizon 精选任务未按期完成，实时资讯和理论雷达不受影响。\n- **模式**: $horizon_mode\n- **精选条数**: $horizon_count\n- **最后检查**: $horizon_checked\n- **缓存年龄**: ${horizon_age} 秒\n- **错误**: ${horizon_error:0:240}\n- **时间**: $TS"
elif [[ "$horizon_state" == OK && "$prev_horizon" == CRIT ]]; then
  send_card green '✅ 每日 AI 精选：已恢复' "Horizon 精选任务恢复。\n- **模式**: $horizon_mode\n- **精选条数**: $horizon_count\n- **最后检查**: $horizon_checked\n- **时间**: $TS"
fi

tail -n 500 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
