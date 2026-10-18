#!/system/bin/sh
# No deployment action is performed by installing this file.
set -eu
umask 077
R=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
D=$(dirname "$R")
BB=${VIDEO_PROXY_BUSYBOX:-/data/adb/magisk/busybox}
action=${1:-check}
release=$(cat "$R/release-id" 2>/dev/null || :)
activated() {
  [ -n "$release" ] || return 1
  for file in enabled release-id; do
    [ -f "$R/$file" ] && [ ! -L "$R/$file" ] && [ "$("$BB" stat -c %a "$R/$file")" = 600 ] || return 1
  done
  [ "$(cat "$R/enabled" 2>/dev/null)" = "$release" ]
}
main_matches() {
  expected=$(cat "$R/active-main.sha256" 2>/dev/null || :)
  [ -n "$expected" ] && [ "$(sha256sum "$D/config.json" | cut -d ' ' -f 1)" = "$expected" ]
}
guard_running() {
  p=$(cat "$R/guard.pid" 2>/dev/null || :)
  case "$p" in ''|*[!0-9]*) return 1;; esac
  [ -r "/proc/$p/cmdline" ] || return 1
  cmd=$(tr '\000' ' ' < "/proc/$p/cmdline")
  case "$cmd" in *" YoutubeFailover $R/guard-config.json ") return 0;; *) return 1;; esac
}
case "$action" in
  check)
    [ -r "$R/guard.dex" ] && [ -r "$R/guard-config.json" ] && [ -x "$R/workerctl.sh" ]
    sh "$R/workerctl.sh" check rack
    sh "$R/workerctl.sh" check zgo
    echo service_files_checked
    ;;
  status)
    if guard_running; then echo "guard_running pid=$p"; else echo guard_stopped; fi
    ;;
  boot-start)
    activated || { echo release_inactive; exit 20; }
    main_matches || { echo main_config_mismatch; exit 21; }
    boot=$(cat /proc/sys/kernel/random/boot_id)
    [ -n "$boot" ] || exit 22
    printf '%s\n' "$boot" > "$R/authorized-boot-id.new"
    mv "$R/authorized-boot-id.new" "$R/authorized-boot-id"
    # DNS recovery begins before waiting on either HY2 worker.
    if ! guard_running; then
      "$BB" nohup "$BB" flock -n "$R/guard.lock" sh "$R/guard-run.sh" >> "$R/guard-console.log" 2>&1 </dev/null &
    fi
    i=0
    while [ "$i" -lt 10 ]; do
      i=$((i+1))
      if guard_running; then
        sh "$R/workerctl.sh" start rack || echo rack_worker_start_deferred
        sh "$R/workerctl.sh" start zgo || echo zgo_worker_start_deferred
        echo "guard_started pid=$p"; exit 0
      fi
      sleep 1
    done
    echo guard_start_failed; exit 23
    ;;
  *) echo 'usage: service.sh check|status|boot-start' >&2; exit 2;;
esac
