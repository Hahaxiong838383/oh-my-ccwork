#!/system/bin/sh
# Explicit maintenance-window activation. Never called automatically at boot.
# Caller has verified foreground playback bypasses the proxy, the staged release and
# credentials. A whole-release rollback is performed if validation fails.
set -u
umask 077
D=/data/adb/video-proxy
R=$D/youtube-failover
P=${0%/*}
BB=/data/adb/magisk/busybox
boot=$(cat /proc/sys/kernel/random/boot_id) || exit 1
[ "$(cat "$P/transaction-profile")" = rack-dualstack-v1 ] || exit 2
[ "$(cat "$P/authorized-current-boot-id")" = "$boot" ] || exit 3
[ "$("$BB" stat -c %a "$P/authorized-current-boot-id")" = 600 ] || exit 4
if [ "${1:-}" != --locked ]; then
  export RACK_ACTIVATION_LOCKED="$P:$boot"
  exec "$BB" flock -n "$D/rack-activation.lock" sh "$0" --locked
fi
[ "${RACK_ACTIVATION_LOCKED:-}" = "$P:$boot" ] || exit 5

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) rack_activation $*"; }
digest() { "$BB" sha256sum "$1" | "$BB" awk '{print $1}'; }
foreground_allowed() {
  [ -f "$P/authorized-foreground-component" ] && [ ! -L "$P/authorized-foreground-component" ] || return 1
  [ "$("$BB" stat -c %a "$P/authorized-foreground-component")" = 600 ] || return 1
  [ "$1" = "$(cat "$P/authorized-foreground-component")" ] || return 1
  # These two players were verified outside the TUN at their activation windows.
  # The caller must recheck the current UID/rules; the allowlist alone is not proof.
  case "$1" in
    com.zentraedi.zspace.tv/*VideoPlayerActivity|com.player.diyp2020/com.player.activity.PlayerActivity) return 0 ;;
    *) return 1 ;;
  esac
}
startticks() { "$BB" awk '{sub(/^.*\) /, ""); split($0,a," "); print a[20]}' "/proc/$1/stat"; }
args() { "$BB" tr '\000' ' ' < "/proc/$1/cmdline" 2>/dev/null; }
without_activation_lock() {
  # A daemon must not inherit the maintenance mutex beyond this transaction.
  for fdpath in /proc/$$/fd/*; do
    [ "$(readlink "$fdpath" 2>/dev/null)" = "$D/rack-activation.lock" ] || continue
    fd=${fdpath##*/}
    case "$fd" in ''|*[!0-9]*) return 1 ;; esac
    eval "exec $fd>&-"
  done
  exec "$@"
}
inherited_boot_lock_only() {
  # This deployment preserves the existing ZGO worker. Its inherited boot lock
  # keeps boot-start excluded while a separate mutex serializes maintenance.
  # Refuse an actual boot worker or any unknown holder; never unlink the lock.
  holders=$("$BB" ls -l /proc/[0-9]*/fd/* 2>/dev/null | "$BB" awk -v lock="$D/boot-start.lock" '$NF == lock {split($(NF-2),a,"/"); print a[3]}' | "$BB" sort -u)
  [ -n "$holders" ] || return 1
  zgo_holder=no
  for pid in $holders; do
    case "$(args "$pid")" in
      "$D/sing-box run -c $R/workers/zgo/config.json ") zgo_holder=yes ;;
      "$D/sing-box run -c $R/workers/rack/config.json ") ;;
      *) is_main "$pid" || guard_process "$pid" || return 1 ;;
    esac
  done
  [ "$zgo_holder" = yes ] || return 1
  # An open descriptor alone does not prove a lock is held.
  if "$BB" flock -n "$D/boot-start.lock" true; then return 1; fi
  log inherited_boot_lock_verified
}
applied=0
is_main() {
  [ "$(readlink "/proc/$1/exe" 2>/dev/null)" = "$D/sing-box" ] || return 1
  [ "$(args "$1")" = "$D/sing-box run -c $D/config.json " ]
}
main_pid() {
  found=
  for proc in /proc/[0-9]*; do
    pid=${proc##*/}
    if is_main "$pid"; then [ -z "$found" ] || return 1; found=$pid; fi
  done
  [ -n "$found" ] || return 1
  echo "$found"
}
stop_main() {
  pid=$(main_pid) || return 0
  ticks=$(startticks "$pid") || return 1
  is_main "$pid" && [ "$(startticks "$pid")" = "$ticks" ] || return 1
  kill -TERM "$pid" || return 1
  i=0
  while is_main "$pid"; do i=$((i+1)); [ "$i" -le 10 ] || return 1; sleep 1; done
  log main_stopped
}
guard_process() {
  cmd=$(args "$1")
  case "$cmd" in
    "app_process /system/bin YoutubeFailover $R/guard-config.json "|"/system/bin/app_process /system/bin YoutubeFailover $R/guard-config.json "|"sh $R/guard-run.sh "|"/system/bin/sh $R/guard-run.sh "|"$BB flock -n $R/guard.lock sh $R/guard-run.sh ") return 0 ;;
    *) return 1 ;;
  esac
}
stop_guard() {
  # Closing authorization makes a surviving supervisor exit without respawn.
  if [ -f "$R/authorized-boot-id" ]; then
    [ ! -L "$R/authorized-boot-id" ] || return 1
    rm "$R/authorized-boot-id" || return 1
  fi
  for proc in /proc/[0-9]*; do
    pid=${proc##*/}
    if guard_process "$pid"; then
      ticks=$(startticks "$pid") || continue
      guard_process "$pid" && [ "$(startticks "$pid")" = "$ticks" ] && kill -TERM "$pid"
    fi
  done
  i=0
  while :; do
    live=no
    for proc in /proc/[0-9]*; do guard_process "${proc##*/}" && live=yes; done
    [ "$live" = no ] && break
    i=$((i+1)); [ "$i" -le 10 ] || return 1; sleep 1
  done
  log guardian_stopped
}
stop_owned_rack() {
  # Only reached after the original worker-safe gate succeeded. During
  # rollback the management API may be down, so verify the worker's persisted
  # boot/starttime/executable/argv/config digest directly, never a name match.
  W="$R/workers/rack"
  found=
  for proc in /proc/[0-9]*; do
    pid=${proc##*/}
    if [ "$(readlink "$proc/exe" 2>/dev/null)" = "$D/sing-box" ] &&
       [ "$(args "$pid")" = "$D/sing-box run -c $W/config.json " ]; then
      [ -z "$found" ] || return 1; found=$pid
    fi
  done
  [ -n "$found" ] || return 0
  IFS='|' read -r sb sp st se sc sd < "$W/worker.pid" || return 1
  [ "$sb" = "$boot" ] && [ "$sp" = "$found" ] && [ "$st" = "$(startticks "$found")" ] &&
    [ "$se" = "$D/sing-box" ] && [ "$sc" = "$W/config.json" ] && [ "$sd" = "$(digest "$W/config.json")" ] || return 1
  kill -TERM "$found" || return 1
  i=0
  while [ "$(args "$found")" = "$D/sing-box run -c $W/config.json " ]; do
    i=$((i+1)); [ "$i" -le 10 ] || return 1; sleep 1
  done
}
restore_selections() {
  # In particular, old on-disk defaults can point at the failed pre-migration
  # address. Restore the actual pre-activation selections on rollback too.
  [ -f "$P/initial-selections.tsv" ] && [ ! -L "$P/initial-selections.tsv" ] || return 1
  token=$(cat "$R/api-secret") || return 1
  [ -n "$token" ] || return 1
  count=0
  while IFS="$(printf '\t')" read -r selector target extra; do
    [ -z "$extra" ] || return 1
    case "$selector:$target" in
      youtube-video:yt-rack-hy2|youtube-video:yt-rack-reality|youtube-video:yt-zgo-reality|youtube-video:yt-zgo-hy2|dns-uplink:dns-rack-reality|dns-uplink:dns-zgo-reality|zgo-video:zgo-hy2|zgo-video:zgo-netflix) ;;
      *) return 1 ;;
    esac
    body=$(printf '{"name":"%s"}' "$target")
    count=$((count+1)); good=no; i=0
    while [ "$i" -lt 5 ]; do
      i=$((i+1))
      # printf is a shell builtin: the token never enters external argv.
      response=$(printf 'PUT /proxies/%s HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer %s\r\nContent-Type: application/json\r\nContent-Length: %s\r\nConnection: close\r\n\r\n%s' "$selector" "$token" "${#body}" "$body" | "$BB" timeout 4 "$BB" nc 127.0.0.1 19090) || response=
      case "$response" in 'HTTP/1.1 204 '*) good=yes; break ;; esac
      sleep 1
    done
    [ "$good" = yes ] || return 1
    response=$(printf 'GET /proxies/%s HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer %s\r\nConnection: close\r\n\r\n' "$selector" "$token" | "$BB" timeout 4 "$BB" nc 127.0.0.1 19090) || return 1
    printf '%s\n' "$response" | "$BB" grep -qE '"now"[[:space:]]*:[[:space:]]*"'"$target"'"' || return 1
  done < "$P/initial-selections.tsv"
  unset token
  [ "$count" = 3 ]
}
start_release() {
  "$D/sing-box" check -c "$D/config.json" || return 1
  main_pid >/dev/null 2>&1 && return 1
  without_activation_lock "$BB" nohup "$D/sing-box" run -c "$D/config.json" >> "$D/run.log" 2>&1 </dev/null &
  own=$!
  i=0
  while ! is_main "$own"; do i=$((i+1)); [ "$i" -le 5 ] || return 1; sleep 1; done
  restore_selections || return 1
  (without_activation_lock sh "$R/service.sh" boot-start) || return 1
  sh "$D/video-dns-guard.sh" --verify || return 1
  i=0
  while [ "$i" -lt 6 ]; do
    i=$((i+1))
    if "$D/video-boot-net" dns www.youtube.com 127.0.0.1 5354 &&
       "$D/video-boot-net" dns ntp3.aliyun.com 127.0.0.1 5354; then
      log "ready main=$own"; return 0
    fi
    sleep 1
  done
  return 1
}
matches_set() {
  expected_set=$1; except_entry=${2:-no}
  while IFS="$(printf '\t')" read -r path old new mode extra; do
    if [ "$except_entry" = yes ] && [ "$path" = video-dns-service-start.sh ]; then continue; fi
    expected=$new; [ "$expected_set" = backup ] && expected=$old
    [ -f "$D/$path" ] && [ ! -L "$D/$path" ] &&
      [ "$(digest "$D/$path")" = "$expected" ] &&
      [ "$("$BB" stat -c %a "$D/$path")" = "$mode" ] || return 1
  done < "$P/transaction.tsv"
}
restore_boot_entry() {
  current=$(digest "$D/video-dns-service-start.sh") || return 1
  [ "$current" = "$(digest "$P/backup/video-dns-service-start.sh")" ] ||
    [ "$current" = "$(digest "$P/payload/video-dns-service-start.sh")" ] || return 1
  cp "$P/backup/video-dns-service-start.sh" "$D/video-dns-service-start.sh.rack-restore" &&
    chmod 700 "$D/video-dns-service-start.sh.rack-restore" &&
    mv "$D/video-dns-service-start.sh.rack-restore" "$D/video-dns-service-start.sh" && sync &&
    [ "$(digest "$D/video-dns-service-start.sh")" = "$(digest "$P/backup/video-dns-service-start.sh")" ]
}
failed() {
  trap - HUP INT TERM
  if [ "$applied" = 0 ] && matches_set backup yes; then
    # No new release is active: retire the newly wired entry even if a stop
    # failed. Do not manufacture a rollback marker for a never-applied release.
    restore_boot_entry || { log boot_entry_restore_failed; exit 1; }
    if main_pid >/dev/null 2>&1; then
      (without_activation_lock sh "$R/service.sh" boot-start) && log old_runtime_restored || log old_runtime_recovery_incomplete
    else
      start_release && log old_runtime_restored || log old_runtime_recovery_incomplete
    fi
    exit 1
  fi
  log rolling_back
  stop_guard && stop_owned_rack && stop_main || { log rollback_stop_failed; exit 1; }
  sh "$P/dns-upgrade-apply.sh" --rollback-authorized || { log rollback_transaction_failed; exit 1; }
  if start_release; then log old_release_restored; else log old_release_restart_failed; fi
  exit 1
}

sh "$P/dns-upgrade-apply.sh" --verify || exit 10
[ ! -e "$P/rolled-back-boot-id" ] || { log rolled_back_release_requires_new_stage; exit 18; }
"$D/sing-box" check -c "$P/payload/config.json" || exit 11
"$D/sing-box" check -c "$P/payload/youtube-failover/workers/rack/config.json" || exit 12
CLASSPATH="$P/payload/youtube-failover/guard.dex" app_process /system/bin YoutubeFailover --check-config "$P/payload/youtube-failover/guard-observe.json" || exit 13
# No changing app identity between the caller's preflight and this mutation.
foreground=$(dumpsys activity activities | "$BB" sed -n 's/.*mResumedActivity:.* u0 \([^ ]*\/[^ ]*\) .*/\1/p')
foreground_allowed "$foreground" || { log foreground_changed_no_activation; exit 14; }
[ "$(cat /proc/sys/kernel/random/boot_id)" = "$boot" ] || exit 15
inherited_boot_lock_only || { log boot_lock_owner_not_verified; exit 19; }
# Retire the old nine-file boot entry before changing its managed files. This
# file is itself in the new rollback set. A power loss now runs the new replay.
entry="$D/video-dns-service-start.sh"
[ "$(digest "$entry")" = "$(digest "$P/backup/video-dns-service-start.sh")" ] || exit 16
cp "$P/payload/video-dns-service-start.sh" "$entry.rack-next" && chmod 700 "$entry.rack-next" && sync && mv "$entry.rack-next" "$entry" && sync || exit 17
trap failed HUP INT TERM
# Rack worker is currently unselected and flow-free, verified by its existing
# independent API safety checker. Keep the ZGO worker and foreground app alive.
sh "$R/workerctl.sh" stop rack || failed
stop_guard || failed
stop_main || failed
result=$(sh "$P/dns-upgrade-apply.sh" --apply-authorized) || failed
[ "$result" = dns_upgrade_applied ] || failed
applied=1
start_release || failed
sh "$P/dns-upgrade-apply.sh" --verify || failed
matches_set payload || failed
sync
trap - HUP INT TERM
log completed
