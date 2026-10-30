#!/system/bin/sh
umask 077
PATH=/system/bin:/system/xbin
export PATH
D=/data/adb/tv-network-status
BB=/data/adb/magisk/busybox
if [ "${1:-}" != --locked ]; then
  exec "$BB" flock -n "$D/watch.lock" "$BB" sh "$D/watch.sh" --locked
fi
. "$D/state.sh"
boot=$(cat /proc/sys/kernel/random/boot_id) || exit 1
[ -n "$boot" ] || exit 1
[ "$(cat "$D/done-boot-id" 2>/dev/null)" != "$boot" ] || exit 0
log() { printf 'boot=%s uptime=%s %s\n' "$boot" "$(cut -d ' ' -f 1 /proc/uptime)" "$*" >> "$D/status.log"; }
ms() { awk '{printf "%.0f\n", $1*1000}' /proc/uptime; }
log watcher_started
while [ "$(getprop sys.boot_completed)" != 1 ]; do "$BB" sleep 1; done
# Consume actual ActivityTaskManager resume events instead of frequent full dumps.
# This ROM's wm_set_resumed_activity tag was observed before using this path.
event_pid=''
cleanup() {
  if [ -n "$event_pid" ]; then
    kill "$event_pid" 2>/dev/null || true
    wait "$event_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 0' INT TERM
snapshot() {
  home=$(/system/bin/dumpsys -t 1 activity activities 2>/dev/null | status_home)
  snapshot_at=$(ms)
}
start_events() {
  cleanup
  /system/bin/logcat -b events -v brief -T 1 -s wm_set_resumed_activity:I > "$D/foreground-events.log" 2>/dev/null &
  event_pid=$!
  "$BB" sleep 0.1
  last_event=$(tail -n 1 "$D/foreground-events.log" 2>/dev/null)
  snapshot
}
start_events
previous=''; sent=0; ready_since=0; active=false
complete() {
  printf '%s\n' "$boot" > "$D/done-boot-id"
  log watcher_completed
  exit 0
}
while :; do
  phase=$(status_phase "$boot" /data/adb/video-proxy/boot-ready-boot-id /data/adb/video-proxy/boot-start.log)
  if ! kill -0 "$event_pid" 2>/dev/null; then home=false; start_events; fi
  event=$(tail -n 1 "$D/foreground-events.log" 2>/dev/null)
  if [ "$event" != "$last_event" ]; then
    home=$(status_event_home "$event"); last_event=$event
  fi
  ready=false; [ "$phase" != ready ] || ready=true
  now=$(ms)
  # A low-frequency consistency check bounds even a missed/overflowed event.
  if [ $((now-snapshot_at)) -ge 15000 ]; then snapshot; fi
  if [ "$ready" = true ]; then
    if [ "$active" = false ]; then complete; fi
    [ "$ready_since" -ne 0 ] || ready_since=$now
    if [ $((now-ready_since)) -ge 2500 ]; then complete; fi
  else ready_since=0
  fi
  state="$phase/$home"
  if { [ "$home" = true ] || [ "$active" = true ]; } &&
     { [ "$state" != "$previous" ] || [ $((now-sent)) -ge 1200 ]; }; then
    # Explicit component, non-sensitive extras, root caller; no Activity is opened.
    output=$(/system/bin/am start-foreground-service --user 0 \
      -n cn.hahaxiong.tvnetstatus/.StatusService \
      --es boot "$boot" --es phase "$phase" --ez home "$home" --ez ready "$ready" --el seq "$now" 2>&1)
    case "$output" in
      *Error*|*Exception*) log service_delivery_failed; "$BB" sleep 2; continue ;;
    esac
    if [ "$state" != "$previous" ]; then log "state=$state"; fi
    sent=$now; previous=$state; active=$home
  fi
  if [ "$ready" = true ] && [ "$home" = false ]; then complete; fi
  # Events are local non-sensitive metadata, kept bounded during prolonged failure.
  if [ "$(wc -c < "$D/foreground-events.log")" -gt 131072 ]; then start_events; fi
  "$BB" sleep 0.5
done
