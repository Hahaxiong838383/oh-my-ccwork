#!/bin/bash
# Confirm an outage on the production SOCKS path. Recovery uses tiny requests
# so a background timer cannot start a competing throughput sweep.
set -u
API=http://127.0.0.1:9090
STATE="$(dirname -- "$0")/dsh-media-state.sh"
RUNDIR=${RUNTIME_DIRECTORY:-/run}
FAILS="$RUNDIR/dsh-watch.fails"
MAP=${DSH_PROBE_MAP:-/var/lib/dsh/probe-map.json}
exec 9>"$RUNDIR/dsh-media-exit.lock" || exit 1
flock -n 9 || exit 0

now_exit() {
    curl -fsS --max-time 4 "$API/proxies/proxy" |
        python3 -c 'import json,sys; print(json.load(sys.stdin)["now"])'
}
online() {
    local port=$1 host code
    for host in www.youtube.com www.google.com; do
        code=$(curl -s --max-time 5 --socks5-hostname "127.0.0.1:$port" \
            -o /dev/null -w '%{http_code}' "https://$host/generate_204")
        [ "$code" = 204 ] && return 0
    done
    return 1
}
cur=$(now_exit) || exit 1
[ -n "$cur" ] || exit 1
if online 1080; then
    echo 0 > "$FAILS"
    exit 0
fi

previous= count=0
if [ -r "$FAILS" ]; then read -r previous count < "$FAILS"; fi
[[ "$previous" = "$cur" && "$count" =~ ^[0-9]+$ ]] || count=0
((count < 2)) && count=$((count+1))
echo "$cur $count" > "$FAILS"
[ "$count" -ge 2 ] || exit 0
"$STATE" can-recover || exit 0

mapfile -t exits < <(python3 -c 'import json,sys; print("\n".join(json.load(open(sys.argv[1]))))' "$MAP")
for i in "${!exits[@]}"; do
    candidate=${exits[i]}
    [[ "$candidate" =~ ^[[:alnum:]_-]+$ && "$candidate" != "$cur" ]] || continue
    online "$((19201+i))" || continue
    # Other operators may change the selection while the probe is in flight.
    [ "$(now_exit)" = "$cur" ] || exit 0
    if online 1080; then echo 0 > "$FAILS"; exit 0; fi
    "$STATE" can-recover || exit 0
    if curl -fsS --max-time 4 -X PUT "$API/proxies/proxy" -d "{\"name\":\"$candidate\"}" >/dev/null &&
       [ "$(now_exit)" = "$candidate" ]; then
        echo 0 > "$FAILS"
        logger -t dsh-watch "new connections moved from $cur to $candidate after repeated outage"
        exit 0
    fi
    logger -t dsh-watch "selector change to $candidate was not confirmed"
    exit 1
done
logger -t dsh-watch "no reachable backup during outage on $cur"
