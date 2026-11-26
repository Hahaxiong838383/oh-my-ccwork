#!/bin/bash
# The Android static Ethernet configuration owns table eth0. Use table 100
# only for sustained drift on a provisioned box, never while IpClient starts.
set -eu
tv=192.168.1.144:5555
gw=192.168.1.19
streak=${RUNTIME_DIRECTORY:-/run}/dsh-tv-guard.drift
adb_tv() { timeout 5 adb -s "$tv" "$@"; }
log() { logger -t dsh-tv-guard "$*"; }

if ! adb_tv get-state 2>/dev/null | grep -qx device; then
    rm -f "$streak"
    timeout 3 adb connect "$tv" >/dev/null 2>&1 || :
    exit 0
fi

# A complete record distinguishes "no default route" from ADB going away.
if ! sample=$(adb_tv shell '
    boot=$(cat /proc/sys/kernel/random/boot_id) &&
    read uptime _ < /proc/uptime &&
    carrier=$(cat /sys/class/net/eth0/carrier) &&
    addrs=$(ip -o -4 addr show dev eth0) &&
    routes=$(ip -4 route show table eth0) &&
    rules=$(ip -4 rule show) || exit 1
    addr=$(echo "$addrs" | awk "{print \$4; exit}")
    gw=$(echo "$routes" | awk "/^default via /{print \$3; exit}")
    owned=$(echo "$rules" | grep -Ec "^9000:[[:space:]]+from all lookup 100[[:space:]]*$")
    echo "$boot ${uptime%%.*} $(getprop sys.boot_completed) $carrier ${addr:--} ${gw:--} $owned"
' 2>/dev/null); then
    rm -f "$streak"
    exit 0
fi
read -r boot uptime complete carrier address actual owned <<< "${sample//$'\r'/}"
if ! [[ $boot =~ ^[a-f0-9-]{36}$ && $uptime =~ ^[0-9]+$ && $complete == 1 && $carrier == 1 && $address == 192.168.1.144/24 ]]; then
    rm -f "$streak"
    exit 0
fi
if [[ $actual == "$gw" && $owned == 0 ]]; then
    rm -f "$streak"
    exit 0
fi
if (( uptime < 60 )); then
    rm -f "$streak"
    exit 0
fi

# Include the boot ID and observed gateway. A single transient late in one
# boot cannot combine with an early empty table in the next boot.
key="$boot $actual"
if [[ $(cat "$streak" 2>/dev/null || :) != "$key" ]]; then
    echo "$key" > "$streak"
    exit 0
fi
if [[ $(adb_tv shell id -u | tr -d '\r') != 0 ]]; then
    # Previous builds of the box bring adbd up as shell. Promote it once
    # a real repair is required. Healthy playback never enters this path.
    adb_tv root >/dev/null 2>&1 || :
    exit 0
fi
if [[ $actual == "$gw" ]]; then
    adb_tv shell 'ip -4 rule del pref 9000 from all table 100 &&
        { ip -4 route del default via 192.168.1.19 dev eth0 table 100 2>/dev/null || :; } &&
        { ip -4 route del 192.168.1.0/24 dev eth0 table 100 2>/dev/null || :; }'
    log 'static route recovered; removed emergency rule'
    exit 0
fi

adb_tv shell '
    rules=$(ip -4 rule show) || exit 1
    # Do not reuse a foreign priority or routing table.
    if echo "$rules" | grep -Eq "^9000:|lookup 100([[:space:]]|$)"; then
        echo "$rules" | grep -Eq "^9000:[[:space:]]+from all lookup 100[[:space:]]*$" || exit 1
        if echo "$rules" | grep -E "^9000:|lookup 100([[:space:]]|$)" | grep -Evq "^9000:[[:space:]]+from all lookup 100[[:space:]]*$"; then exit 1; fi
    fi
    table=$(ip -4 route show table 100) || exit 1
    if echo "$table" | grep -Evq "^$|^default via 192\.168\.1\.19 dev eth0( |$)|^192\.168\.1\.0/24 dev eth0( |$)"; then exit 1; fi
    ip -4 route get 8.8.8.8 | grep -q "via 192.168.1.19 dev eth0 table 100 " && exit 0
    ip -4 route replace 192.168.1.0/24 dev eth0 scope link table 100 &&
        ip -4 route replace default via 192.168.1.19 dev eth0 table 100 || exit 1
    echo "$rules" | grep -Eq "^9000:[[:space:]]+from all lookup 100[[:space:]]*$" ||
        ip -4 rule add pref 9000 from all table 100 || exit 1
    ip -4 route get 8.8.8.8 | grep -q "via 192.168.1.19 dev eth0 table 100 "
'
