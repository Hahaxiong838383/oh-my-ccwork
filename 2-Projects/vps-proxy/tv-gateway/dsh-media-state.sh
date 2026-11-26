#!/bin/bash
# Return success only on a positively observed safe condition.
set -u
TV_IP=192.168.1.144
TV="$TV_IP:5555"
tv() { timeout 5 adb -s "$TV" shell "$1"; }

# ADB alone cannot distinguish boot, playback or power-off. Require a working
# on-link route and router, a failed ARP resolution for the TV, and zero live
# forwarded TV flows. The LAN check also protects an early boot before adbd.
offline() {
    local state route iface router reply flows
    state=$(timeout 3 adb -s "$TV" get-state 2>/dev/null) && [ "$state" = device ] && return 1
    route=$(ip -4 route get "$TV_IP") || return 1
    read -r dest dev iface _ <<< "$route"
    [[ "$dest" = "$TV_IP" && "$dev" = dev && -n "$iface" ]] || return 1
    router=$(ip -4 route show table main default dev "$iface" | awk '$1=="default" && $2=="via" {print $3; exit}')
    [ -n "$router" ] && ping -n -I "$iface" -c 1 -W 2 "$router" >/dev/null 2>&1 || return 1
    ping -n -I "$iface" -c 1 -W 4 "$TV_IP" >/dev/null 2>&1
    reply=$?
    [ "$reply" -eq 1 ] || return 1
    ip -4 neigh show to "$TV_IP" dev "$iface" | grep -Eq '(^| )FAILED$' || return 1
    flows=$(curl -fsS --max-time 3 http://127.0.0.1:9090/connections) || return 1
    python3 -c 'import json,sys
connections=json.load(sys.stdin)["connections"]
assert isinstance(connections,list)
sys.exit(any(c["metadata"]["sourceIP"] == sys.argv[1] for c in connections))' "$TV_IP" <<< "$flows"
}

snapshot() {
    tv 'dumpsys activity activities | grep mResumedActivity; dumpsys media_session'
}
idle() {
    local view="$1"
    grep -q 'mResumedActivity:.* com\.dangbei\.tvlauncher/' <<< "$view" &&
    grep -q 'Sessions Stack - have [0-9][0-9]* sessions:' <<< "$view" &&
    ! grep -Eq 'state=PlaybackState \{state=(3|4|5|6|8|9|10|11),' <<< "$view"
}
sample() {
    local raw
    raw=$(tv 'cat /sys/class/vdec/vdec_status') || return 1
    raw=${raw//$'\r'/}
    if grep -Eiq '^[[:space:]]*No vdec\.[[:space:]]*$' <<< "$raw"; then
        echo none
    else
        awk '$1=="frame" && $2=="count" && $3==":" && $4~/^[0-9]+$/ {print $4; found=1} END{exit !found}' <<< "$raw"
    fi
}

case "${1:-}" in
idle)
    if view=$(snapshot 2>/dev/null) && [ -n "$view" ]; then idle "$view"; else offline; fi
    ;;
can-recover)
    before=$(sample 2>/dev/null) || { offline; exit $?; }
    sleep 2
    after=$(sample 2>/dev/null) || exit 1
    [[ "$before" == "$after" ]] || exit 1
    if [ "$after" = none ]; then
        view=$(snapshot) || exit 1
        idle "$view" && exit 0
        # Without a hardware decoder a software player could be progressing.
        # Allow a stalled SmartTube session only with both foreground and
        # package-specific buffering evidence.
        grep -q 'mResumedActivity:.* org\.smarttube\.beta/' <<< "$view" || exit 1
        awk '/^[[:space:]]*package=/ {st=($1=="package=org.smarttube.beta")}
             st && /state=PlaybackState \{state=6,/ {found=1} END {exit !found}' <<< "$view"
    fi
    ;;
*) exit 2 ;;
esac
