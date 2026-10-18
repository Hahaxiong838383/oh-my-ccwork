#!/system/bin/sh
# flock owns one supervisor; this loop recovers only its own Java guardian.
set -eu
umask 077
R=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BB=${VIDEO_PROXY_BUSYBOX:-/data/adb/magisk/busybox}
release=$(cat "$R/release-id")
boot=$(cat /proc/sys/kernel/random/boot_id)
authorized() {
  [ -n "$release" ] && [ "$(cat "$R/enabled" 2>/dev/null)" = "$release" ] &&
  [ "$(cat "$R/release-id" 2>/dev/null)" = "$release" ] &&
  [ "$(cat "$R/authorized-boot-id" 2>/dev/null)" = "$boot" ] &&
  [ "$(cat /proc/sys/kernel/random/boot_id)" = "$boot" ]
}
export CLASSPATH="$R/guard.dex"
failures=0
while authorized; do
  app_process /system/bin YoutubeFailover "$R/guard-config.json" &
  child=$!
  printf '%s\n' "$child" > "$R/guard.pid.new"
  mv "$R/guard.pid.new" "$R/guard.pid"
  if wait "$child"; then rc=0; else rc=$?; fi
  authorized || exit 0
  failures=$((failures+1))
  case "$failures" in 1) delay=5;; 2) delay=15;; *) delay=60;; esac
  echo "guardian_exited rc=$rc retry_seconds=$delay"
  sleep "$delay"
done
exit 20
