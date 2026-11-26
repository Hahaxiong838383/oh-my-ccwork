#!/bin/bash
# Keep a diagnostic count. The foreground player owns its lifecycle and cache.
set -u
TV=192.168.1.144:5555
pid=$(timeout 5 adb -s "$TV" shell pidof org.smarttube.beta 2>/dev/null | tr -d '\r') || exit 0
[[ "$pid" =~ ^[0-9]+$ ]] || exit 0
since=$(date -d '5 minutes ago' '+%m-%d %H:%M:%S.000')
count=$(timeout 8 adb -s "$TV" shell "logcat -d --pid=$pid -T '$since'" 2>/dev/null |
    grep -c 'SabrPoTokenError')
if [[ "$count" =~ ^[1-9][0-9]*$ ]]; then
    logger -t dsh-st-guard "SmartTube PoToken errors in the last 5 minutes: $count"
fi
