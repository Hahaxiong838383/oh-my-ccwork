#!/system/bin/sh
# Both gateways are on-link. The decision runs on the TV and survives either
# gateway going offline. Probe traffic is exempt from TV DNS redirection.
set -u
base=/data/adb/dsh-gateway
receipt=/data/misc/x96-boot-status/gateway
primary=192.168.1.19
standby=192.168.1.254
boot=$(cat /proc/sys/kernel/random/boot_id) || exit 1
exec 9>"$base/x96-gateway-watch.lock" || exit 1
flock -n 9 9>&9 || exit 0

active_gateway() {
    if read -r id ip extra < "$receipt" 2>/dev/null &&
       [ "$id" = "$boot" ] && [ -z "$extra" ] && [ "$ip" = "$standby" ]; then
        echo "$standby"
    else
        echo "$primary"
    fi
}
route_ctl() { /system/bin/sh "$base/x96-gateway-route.sh" "$@"; }
healthy() { "$base/x96-gw-probe" "$1" >/dev/null 2>&1; }
local_tv_flow() {
    ss -tnip 2>/dev/null | awk '
        /^ESTAB/ { localtv=($5=="192.168.1.211:4022" && /"player.diyp2020"/); sock=$4 }
        localtv && /bytes_received:/ {
            for (i=1;i<=NF;i++) if ($i ~ /^bytes_received:/) { sub(/^bytes_received:/,"",$i); print sock, $i; exit }
        }'
}
safe_to_return() {
    # Prefer making the return while the active stream stays on the LAN.
    # External streams can retain the backup public IP until playback ends.
    resumed=$(dumpsys activity activities | grep 'mResumedActivity:' | head -1)
    case "$resumed" in
        *' com.player.diyp2020/'*)
            first=$(local_tv_flow)
            if [ -n "$first" ]; then
                sleep 1
                second=$(local_tv_flow)
                if [ "${first% *}" = "${second% *}" ] &&
                   awk -v a="${first##* }" -v b="${second##* }" 'BEGIN {exit !(b+0 > a+0)}'; then return 0; fi
            fi
            ;;
        '') return 1 ;;
    esac
    # A software decoder may still be playing even when hardware is idle.
    grep -Eq '^No vdec\.[[:space:]]*$' /sys/class/vdec/vdec_status || return 1
    sessions=$(dumpsys media_session) || return 1
    echo "$sessions" | grep -q 'Sessions Stack - have' || return 1
    ! echo "$sessions" | grep -Eq 'state=PlaybackState \{state=(3|4|5|6|8|9|10|11),'
}

bad=0
good=0
tick=0
held=0
while :; do
    if [ "$(getprop sys.boot_completed)" != 1 ] ||
       [ "$(cat /sys/class/net/eth0/carrier 2>/dev/null)" != 1 ] ||
       ! ip -4 addr show dev eth0 | grep -Fq 'inet 192.168.1.144/24 '; then
        bad=0; good=0; tick=0
        sleep 5
        continue
    fi
    active=$(active_gateway)
    if [ "$tick" -eq 0 ] && ! route_ctl check "$active" &&
       ! route_ctl apply "$active"; then
        log -t X96Gateway "reconcile failed for $active"
        sleep 10
        continue
    fi
    tick=$(((tick + 1) % 5))
    next=$active
    if healthy "$primary"; then
        bad=0
        [ "$good" -ge 3 ] || good=$((good + 1))
        if [ "$active" = "$standby" ] && [ "$good" -ge 3 ]; then
            if safe_to_return || ! healthy "$standby"; then
                next=$primary
            elif [ "$held" -eq 0 ]; then
                log -t X96Gateway 'primary ready; preserving playback on healthy standby'
                held=1
            fi
        fi
    else
        good=0; held=0
        [ "$bad" -ge 2 ] || bad=$((bad + 1))
        if [ "$active" = "$primary" ] && [ "$bad" -ge 2 ] && healthy "$standby"; then
            next=$standby
        fi
    fi
    if [ "$active" != "$next" ]; then
        if route_ctl apply "$next"; then
            log -t X96Gateway "switched $active -> $next"
            bad=0; good=0; tick=0; held=0
        else
            log -t X96Gateway "could not switch $active -> $next"
        fi
    fi
    sleep 10
done
