#!/system/bin/sh
# Magisk post-fs-data runs before Zygote. Never wait for Android or the network.
umask 077
D=/data/adb/video-proxy
BB=/data/adb/magisk/busybox
boot=$("$BB" cat /proc/sys/kernel/random/boot_id 2>/dev/null)
installed=$("$BB" cat "$D/dns-guard-installed-boot-id" 2>/dev/null)
if [ -z "$boot" ] || [ -z "$installed" ] || [ "$boot" = "$installed" ]; then
  echo 'video-dns-post-fs-data: deferred until next boot'
  exit 0
fi
# Protection is independent of the config transaction: an interrupted upgrade
# must never restore an unprotected cleartext DNS path.
"$BB" sh "$D/video-dns-guard.sh" --install >> "$D/dns-guard-console.log" 2>&1
"$BB" nohup "$BB" sh "$D/video-dns-guard.sh" --watch >> "$D/dns-guard-console.log" 2>&1 </dev/null &
