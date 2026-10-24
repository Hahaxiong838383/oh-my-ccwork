#!/system/bin/sh
# Next-boot-only replacement for the existing Magisk service.d entry.
D=/data/adb/video-proxy
boot=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)
installed=$(cat "$D/dns-guard-installed-boot-id" 2>/dev/null)
if [ -z "$boot" ] || [ -z "$installed" ] || [ "$boot" = "$installed" ]; then
  echo 'video-dns-service-entry: deferred until next boot'
  exit 0
fi
/data/adb/magisk/busybox nohup sh "$D/video-dns-service-start.sh" >> "$D/boot-start-console.log" 2>&1 </dev/null &
