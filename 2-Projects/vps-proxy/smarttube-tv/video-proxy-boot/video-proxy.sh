#!/system/bin/sh
# Magisk service.d entry. This release activates only after a new kernel boot.
D=/data/adb/video-proxy
boot=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)
installed=$(cat "$D/boot-fix-installed-boot-id" 2>/dev/null)
if [ -z "$boot" ] || [ -z "$installed" ] || [ "$boot" = "$installed" ]; then
  echo 'video-proxy: deferred until next boot'
  exit 0
fi
/data/adb/magisk/busybox nohup sh "$D/video-boot-start.sh" >> "$D/boot-start-console.log" 2>&1 </dev/null &
