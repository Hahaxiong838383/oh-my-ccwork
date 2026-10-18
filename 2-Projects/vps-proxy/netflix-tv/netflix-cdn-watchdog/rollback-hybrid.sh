#!/system/bin/sh
D=/data/adb/video-proxy
B=$D/backup-20261018-hybrid
touch "$D/watchdog-disabled"
if [ -f "$D/watchdog.pid" ]; then
 p=$(cat "$D/watchdog.pid")
 case "$p" in *[!0-9]*|'') ;; *)
  if tr '\000' ' ' < /proc/$p/cmdline 2>/dev/null | grep -q NetflixCdnWatchdog; then kill "$p"; fi ;;
 esac
fi
rm -f "$D/hybrid-pending"
cp "$B/config.json" "$D/config.json"
cp "$B/video-proxy.sh" /data/adb/service.d/video-proxy.sh
chmod 600 "$D/config.json"
chmod 700 /data/adb/service.d/video-proxy.sh
sh /data/adb/service.d/video-proxy.sh
