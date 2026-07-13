#!/usr/bin/env bash
# Resolve aihot CDN candidates through independent DoH resolvers, probe with
# the real TLS hostname, and keep /etc/hosts pinned only to a currently healthy edge.
set -uo pipefail

HOST="${AIHOT_HOST:-aihot.virxact.com}"
HOSTS_FILE="${HOSTS_FILE:-/etc/hosts}"
LOCK_FILE="${LOCK_FILE:-/run/lock/aihot-endpoint-refresh.lock}"
LOG_FILE="${LOG_FILE:-/var/log/aihot-endpoint-refresh.log}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/chenchuan-site/aihot-endpoint}"
MARKER="# managed-by=aihot-endpoint-refresh"
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
PROBE_PATH='/api/public/items?mode=all&take=1'

mkdir -p "$(dirname "$LOCK_FILE")" "$BACKUP_DIR"
exec 9>"$LOCK_FILE"
flock -n 9 || exit 0

log() {
  local line
  line="$(date '+%F %T') $*"
  echo "$line" >> "$LOG_FILE"
  tail -n 500 "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
  logger -t aihot-endpoint-refresh -- "$*" 2>/dev/null || true
}

valid_ipv4() {
  [[ "$1" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]
}

resolve_candidates() {
  local resolver payload
  for resolver in \
    "https://dns.alidns.com/resolve?name=${HOST}&type=A" \
    "https://cloudflare-dns.com/dns-query?name=${HOST}&type=A"
  do
    payload=$(curl -fsS --max-time 8 -H 'accept: application/dns-json' "$resolver" 2>/dev/null) || continue
    jq -r '.Answer[]? | select(.type == 1) | .data' <<< "$payload" 2>/dev/null || true
  done | awk '!seen[$0]++'
}

probe_ip() {
  local ip="$1" body
  body=$(mktemp)
  if curl --http1.1 -fsS --max-time 8 \
    --resolve "${HOST}:443:${ip}" \
    -A "$UA" \
    -H 'Accept: application/json, text/plain, */*' \
    -e "https://${HOST}/" \
    -o "$body" \
    "https://${HOST}${PROBE_PATH}" \
    && jq -e '.items | type == "array" and length > 0' "$body" >/dev/null 2>&1
  then
    rm -f "$body"
    return 0
  fi
  rm -f "$body"
  return 1
}

current=$(awk -v host="$HOST" '$2 == host { print $1; exit }' "$HOSTS_FILE" 2>/dev/null || true)
mapfile -t candidates < <(resolve_candidates)

healthy=""
for ip in "${candidates[@]}"; do
  valid_ipv4 "$ip" || continue
  if probe_ip "$ip"; then
    if [[ "$ip" == "$current" ]]; then
      healthy="$ip"
      break
    fi
    [[ -n "$healthy" ]] || healthy="$ip"
  fi
done

if [[ -z "$healthy" ]]; then
  log "status=failed reason=no_healthy_candidate candidates=${candidates[*]:-none} current=${current:-none}"
  exit 1
fi

if [[ "$healthy" == "$current" ]] && grep -Fq "$MARKER" "$HOSTS_FILE"; then
  log "status=healthy ip=$healthy action=keep"
  exit 0
fi

timestamp=$(date '+%Y%m%d-%H%M%S')
backup="$BACKUP_DIR/hosts.$timestamp"
tmp=$(mktemp "${HOSTS_FILE}.aihot.XXXXXX")
cp -p "$HOSTS_FILE" "$backup"
awk -v host="$HOST" -v marker="$MARKER" '$2 != host && index($0, marker) == 0 { print }' "$HOSTS_FILE" > "$tmp"
echo "$healthy $HOST $MARKER" >> "$tmp"
chmod --reference="$HOSTS_FILE" "$tmp"
chown --reference="$HOSTS_FILE" "$tmp"
mv "$tmp" "$HOSTS_FILE"
log "status=switched from=${current:-dns} to=$healthy backup=$backup"

# Trigger one SWR refresh. The request returns cached content immediately while
# the application updates its source-health file in the background.
curl -fsS --max-time 30 http://127.0.0.1:3000/radar >/dev/null 2>&1 || true
