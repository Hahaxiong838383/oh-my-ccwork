#!/system/bin/sh
umask 077
D=/data/adb/video-proxy
[ -f "$D/watchdog-disabled" ] && exit 0
echo $$ > "$D/watchdog.pid"
export CLASSPATH="$D/watchdog.dex"
exec app_process /system/bin NetflixCdnWatchdog "$D/watchdog-config.json"
