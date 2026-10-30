#!/system/bin/sh
# Independent of the proxy transaction; never block Magisk service.d.
umask 077
PATH=/system/bin:/system/xbin
export PATH
/data/adb/magisk/busybox sh /data/adb/tv-network-status/watch.sh </dev/null >/dev/null 2>&1 &
exit 0
