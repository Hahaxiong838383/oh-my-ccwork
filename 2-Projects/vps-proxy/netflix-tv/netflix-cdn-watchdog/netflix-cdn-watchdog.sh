#!/system/bin/sh
D=/data/adb/video-proxy
[ -f "$D/watchdog-disabled" ] && exit 0
/data/adb/magisk/busybox nohup /data/adb/magisk/busybox flock -n "$D/watchdog.lock" sh "$D/watchdog-run.sh" >> "$D/watchdog.log" 2>&1 </dev/null &
