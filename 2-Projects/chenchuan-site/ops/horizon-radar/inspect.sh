#!/usr/bin/env bash
set -euo pipefail

STATE_DIR="${HORIZON_STATE_DIR:-/var/lib/horizon-radar}"
STATE_FILE="$STATE_DIR/state.json"
HEALTH_FILE="${RADAR_HORIZON_HEALTH_FILE:-/var/www/chenchuan-site/data/radar-horizon-health.json}"

printf '{"timer":'
systemctl is-active --quiet horizon-radar.timer && printf '"active"' || printf '"inactive"'
printf ',"state":'
[[ -f "$STATE_FILE" ]] && jq -c '{checkedAt,ok,mode,date,itemCount,totalFetched,sourceCount,realtimeDuplicateCount,relevanceFilteredCount,runId,horizonCommit,error}' "$STATE_FILE" || printf 'null'
printf ',"siteHealth":'
[[ -f "$HEALTH_FILE" ]] && jq -c '{checkedAt,ok,mode,date,itemCount,totalFetched,sourceCount,realtimeDuplicateCount,relevanceFilteredCount,runId,lastSuccessAt,lastPublishedAt,error}' "$HEALTH_FILE" || printf 'null'
printf '}\n'
