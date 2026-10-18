#!/system/bin/sh
# Inactive releases are read-only. No activation, main-proxy, or network reset here.
umask 077
ROOT=${YOUTUBE_FAILOVER_ROOT:-$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)}
BB=${YOUTUBE_FAILOVER_BUSYBOX:-/data/adb/magisk/busybox}
BIN=${YOUTUBE_FAILOVER_SING_BOX:-/data/adb/video-proxy/sing-box}
BOOT_FILE=${YOUTUBE_FAILOVER_BOOT_ID_FILE:-/proc/sys/kernel/random/boot_id}
ACTION=${1:-}; NAME=${2:-}
case "$ACTION" in status|check|start|stop|restart) ;; *) echo 'usage: workerctl.sh status|check|start|stop|restart rack|zgo' >&2; exit 2 ;; esac
case "$NAME" in rack) PORT=19201 ;; zgo) PORT=19202 ;; *) echo 'invalid worker' >&2; exit 2 ;; esac
[ "$#" -eq 2 ] || exit 2
W="$ROOT/workers/$NAME"; CFG="$W/config.json"; STATE="$W/worker.pid"; LOCK="$W/control.lock"
[ -d "$ROOT" ] && [ -d "$W" ] || { echo 'worker files absent' >&2; exit 1; }
ROOT=$(readlink -f "$ROOT") || exit 1
W="$ROOT/workers/$NAME"; CFG="$W/config.json"; STATE="$W/worker.pid"; LOCK="$W/control.lock"
BIN=$(readlink -f "$BIN") || exit 1
boot=$(cat "$BOOT_FILE" 2>/dev/null)
reason=inactive
is_authorized() {
  reason=inactive
  case "$boot" in ''|*[!A-Za-z0-9_.-]*) return 1 ;; esac
  [ -n "$boot" ] && [ -r "$ROOT/enabled" ] && [ -r "$ROOT/release-id" ] && [ -r "$ROOT/authorized-boot-id" ] || return 1
  [ ! -L "$ROOT/enabled" ] && [ ! -L "$ROOT/authorized-boot-id" ] && [ ! -L "$ROOT/release-id" ] || return 1
  for marker in enabled authorized-boot-id release-id; do [ "$("$BB" stat -c %a "$ROOT/$marker")" = 600 ] || return 1; done
  release=$(cat "$ROOT/release-id" 2>/dev/null)
  [ -n "$release" ] && [ "$(cat "$ROOT/enabled" 2>/dev/null)" = "$release" ] || { reason=release_not_enabled; return 1; }
  [ "$(cat "$ROOT/authorized-boot-id" 2>/dev/null)" = "$boot" ] || { reason=boot_not_authorized; return 1; }
  reason=authorized
  return 0
}
permissions() {
  [ ! -L "$W" ] && [ ! -L "$ROOT/workers" ] && [ ! -L "$CFG" ] && [ ! -L "$W/config.sha256" ] && [ -f "$CFG" ] && [ -x "$BIN" ] || return 1
  [ "$("$BB" stat -c %a "$ROOT")" = 700 ] && [ "$("$BB" stat -c %a "$W")" = 700 ] || return 1
  [ "$("$BB" stat -c %a "$CFG")" = 600 ] && [ "$("$BB" stat -c %a "$W/config.sha256")" = 600 ] || return 1
  current_digest=$("$BB" sha256sum "$CFG" | "$BB" awk '{print $1}')
  expected_digest=$(cat "$W/config.sha256" 2>/dev/null)
  [ -n "$current_digest" ] && [ "$current_digest" = "$expected_digest" ]
}
start_time() {
  "$BB" awk '{sub(/^.*\) /, ""); split($0,a," "); print a[20]}' "/proc/$1/stat" 2>/dev/null
}
exact_process() {
  candidate=$1
  case "$candidate" in ''|*[!0-9]*) return 1 ;; esac
  [ "$candidate" -gt 1 ] || return 1
  [ "$(readlink "/proc/$candidate/exe" 2>/dev/null)" = "$BIN" ] || return 1
  expected_args=$(printf '%s\nrun\n-c\n%s' "$BIN" "$CFG")
  actual_args=$("$BB" tr '\000' '\n' < "/proc/$candidate/cmdline" 2>/dev/null) || return 1
  [ "$actual_args" = "$expected_args" ]
}
read_state_metadata() {
  [ -f "$STATE" ] && [ ! -L "$STATE" ] && [ "$("$BB" stat -c %a "$STATE")" = 600 ] || return 1
  IFS='|' read -r s_boot s_pid s_start s_exe s_cfg s_digest < "$STATE" || return 1
  [ "$s_boot" = "$boot" ] && [ "$s_exe" = "$BIN" ] && [ "$s_cfg" = "$CFG" ] && [ "$s_digest" = "$current_digest" ] || return 1
  case "$s_pid:$s_start" in *[!0-9:]*|:*|*:) return 1 ;; esac
  [ "$s_pid" -gt 1 ]
}
read_identity() {
  read_state_metadata && exact_process "$s_pid" && [ "$(start_time "$s_pid")" = "$s_start" ]
}
port_inodes() {
  hex=$(printf '%04X' "$PORT")
  "$BB" awk -v port="$hex" '$4=="0A" {split($2,a,":"); if(a[2]==port) print $10}' /proc/net/tcp /proc/net/tcp6 2>/dev/null
}
port_busy() { [ -n "$(port_inodes)" ]; }
owned_listener() {
  inodes=$(port_inodes)
  [ -n "$inodes" ] || return 1
  for fd in /proc/"$1"/fd/*; do
    target=$(readlink "$fd" 2>/dev/null)
    for inode in $inodes; do [ "$target" = "socket:[$inode]" ] && return 0; done
  done
  return 1
}
require_gate() { is_authorized || { echo "mutation refused: $reason" >&2; return 1; }; }
release_lock() {
  if [ "$lock_owned" = yes ]; then
    rm -f "$LOCK/owner"
    rmdir "$LOCK" 2>/dev/null
  fi
  if [ "$reap_owned" = yes ]; then rmdir "$REAPER" 2>/dev/null; fi
}
lock_owner_dead() {
  [ -d "$LOCK" ] && [ ! -L "$LOCK" ] && [ -f "$LOCK/owner" ] && [ ! -L "$LOCK/owner" ] || return 1
  [ "$("$BB" stat -c %a "$LOCK/owner")" = 600 ] || return 1
  IFS='|' read -r l_boot l_pid l_start < "$LOCK/owner" || return 1
  case "$l_boot" in ''|*[!A-Za-z0-9_.-]*) return 1 ;; esac
  case "$l_pid:$l_start" in *[!0-9:]*|:*|*:) return 1 ;; esac
  [ "$l_pid" -gt 1 ] || return 1
  [ "$l_boot" != "$boot" ] && return 0
  [ ! -e "/proc/$l_pid/stat" ] && return 0
  [ "$(start_time "$l_pid")" != "$l_start" ] && return 0
  # A zombie cannot still execute lock-protected operations.
  [ "$("$BB" awk '{sub(/^.*\) /, ""); print $1}' "/proc/$l_pid/stat" 2>/dev/null)" = Z ]
}
acquire_lock() {
  # Reaper is boot-scoped, so a power loss cannot make its old directory block
  # the next boot. An interrupted/unknown reaper in this boot fails closed.
  REAPER="$W/control.reap-$boot"
  trap release_lock EXIT
  trap 'exit 130' INT TERM HUP
  if ! mkdir "$LOCK" 2>/dev/null; then
    mkdir "$REAPER" 2>/dev/null || { echo 'worker lock reaper busy; no action' >&2; return 1; }
    reap_owned=yes
    if lock_owner_dead; then
      before=$(cat "$LOCK/owner")
      if lock_owner_dead && [ "$(cat "$LOCK/owner")" = "$before" ]; then
        rm -f "$LOCK/owner" && rmdir "$LOCK" || return 1
      else
        echo 'worker lock owner changed; no action' >&2; return 1
      fi
    else
      echo 'worker control lock live or unknown; no action' >&2; return 1
    fi
    rmdir "$REAPER" || return 1
    reap_owned=no
    mkdir "$LOCK" 2>/dev/null || { echo 'worker control lock acquired by another controller' >&2; return 1; }
  fi
  lock_owned=yes
  printf '%s|%s|%s\n' "$boot" "$$" "$(start_time $$)" > "$LOCK/owner"
}
any_worker_process() {
  for proc in /proc/[0-9]*; do
    candidate=${proc#/proc/}
    exact_process "$candidate" && return 0
  done
  return 1
}
clear_prior_boot_state() {
  [ -e "$STATE" ] || return 0
  [ -f "$STATE" ] && [ ! -L "$STATE" ] && [ "$("$BB" stat -c %a "$STATE")" = 600 ] || return 1
  IFS='|' read -r old_boot old_pid old_start old_exe old_cfg old_digest < "$STATE" || return 1
  [ "$old_boot" = "$boot" ] && return 0
  case "$old_boot" in ''|*[!A-Za-z0-9_.-]*) return 1 ;; esac
  case "$old_pid:$old_start" in *[!0-9:]*|:*|*:) return 1 ;; esac
  case "$old_digest" in ''|*[!a-f0-9]*) return 1 ;; esac
  [ "$old_pid" -gt 1 ] && [ "${#old_digest}" -eq 64 ] && [ "$old_exe" = "$BIN" ] && [ "$old_cfg" = "$CFG" ] || return 1
  # Old PIDs may now identify an unrelated/main process: never signal them.
  if port_busy || any_worker_process; then echo 'prior-boot state has a live matching process/listener; preserved' >&2; return 1; fi
  require_gate || return 1
  rm -f "$STATE"
  echo 'prior-boot own worker record cleared without signalling its stale PID'
}

safe_to_stop() {
  [ -x "$ROOT/worker-safe-check.sh" ] || { echo 'worker stop safety checker missing' >&2; return 1; }
  YOUTUBE_FAILOVER_ROOT="$ROOT" sh "$ROOT/worker-safe-check.sh" "$NAME" || { echo 'worker remains selected, referenced, or API safety check failed' >&2; return 1; }
  require_gate && permissions && read_identity
}
stop_worker() {
  if [ ! -f "$STATE" ]; then
    port_busy && { echo 'unmanaged port listener preserved' >&2; return 1; }
    echo "worker $NAME already stopped"; return 0
  fi
  if ! read_identity; then
    # A crashed worker leaves a valid record but no process. This branch never
    # signals anything, and refuses PID reuse or a live process with new identity.
    gone=no
    if read_state_metadata; then
      if [ ! -e "/proc/$s_pid/stat" ]; then gone=yes
      elif [ "$(start_time "$s_pid")" = "$s_start" ] && [ "$("$BB" awk '{sub(/^.*\) /, ""); print $1}' "/proc/$s_pid/stat" 2>/dev/null)" = Z ]; then gone=yes
      fi
    fi
    if [ "$gone" = yes ]; then
      require_gate || return 1
      YOUTUBE_FAILOVER_ROOT="$ROOT" sh "$ROOT/worker-safe-check.sh" "$NAME" || return 1
      rm -f "$STATE"
      echo "worker $NAME crashed; stale own record removed"; return 0
    fi
    echo 'worker identity mismatch; no signal sent' >&2; return 1
  fi
  safe_to_stop || return 1
  target_pid=$s_pid; target_start=$s_start
  # Recheck the exact process immediately before TERM, never killall/pkill.
  exact_process "$target_pid" && [ "$(start_time "$target_pid")" = "$target_start" ] || return 1
  kill -TERM "$target_pid" || return 1
  n=0
  while exact_process "$target_pid" && [ "$(start_time "$target_pid")" = "$target_start" ]; do
    n=$((n+1)); [ "$n" -le 50 ] || { echo 'worker TERM timeout; no escalation' >&2; return 1; }
    "$BB" sleep 0.1
  done
  rm -f "$STATE"
  echo "worker $NAME stopped"
}
start_worker() {
  if [ -f "$STATE" ]; then
    if read_identity && owned_listener "$s_pid"; then echo "worker $NAME already running"; return 0; fi
    echo 'worker identity/listener mismatch; existing state preserved' >&2; return 1
  fi
  port_busy && { echo 'worker port occupied; nothing started' >&2; return 1; }
  "$BIN" check -c "$CFG" >/dev/null 2>&1 || { echo 'worker config check failed' >&2; return 1; }
  require_gate && permissions || return 1
  "$BB" nohup "$BIN" run -c "$CFG" >> "$W/run.log" 2>&1 </dev/null &
  own=$!
  n=0
  while ! exact_process "$own"; do
    n=$((n+1)); [ "$n" -le 50 ] || { echo 'owned worker executable never became ready' >&2; return 1; }
    "$BB" sleep 0.1
  done
  own_start=$(start_time "$own")
  [ -n "$own_start" ] || return 1
  printf '%s|%s|%s|%s|%s|%s\n' "$boot" "$own" "$own_start" "$BIN" "$CFG" "$current_digest" > "$STATE.new" || return 1
  mv "$STATE.new" "$STATE" || return 1
  n=0
  while ! owned_listener "$own"; do
    n=$((n+1))
    if [ "$n" -gt 50 ] || ! exact_process "$own"; then
      # Stop only this freshly-created, verified process; it has never been
      # published as a healthy worker and no selector changes are made here.
      if exact_process "$own" && [ "$(start_time "$own")" = "$own_start" ]; then kill -TERM "$own"; fi
      rm -f "$STATE"
      echo 'owned worker did not listen; start failed' >&2; return 1
    fi
    "$BB" sleep 0.1
  done
  echo "worker $NAME running pid=$own"
}
if [ "$ACTION" = status ]; then
  authorized=false; is_authorized && authorized=true
  status=stopped; pid=0
  if ! permissions; then status=invalid_config
  elif read_identity; then pid=$s_pid; if owned_listener "$pid"; then status=running; else status=not_listening; fi
  elif [ -e "$STATE" ]; then status=identity_mismatch
  elif port_busy; then status=unmanaged_listener
  fi
  printf '{"worker":"%s","status":"%s","authorized":%s,"reason":"%s","pid":%s}\n' "$NAME" "$status" "$authorized" "$reason" "$pid"
  exit 0
fi
permissions || { echo 'worker file permissions or config digest invalid' >&2; exit 1; }
if [ "$ACTION" = check ]; then
  "$BIN" check -c "$CFG" >/dev/null 2>&1 || { echo 'worker config invalid' >&2; exit 1; }
  echo "worker $NAME config valid; no process started"
  exit 0
fi
require_gate || exit 1
lock_owned=no; reap_owned=no; REAPER=
acquire_lock || exit 1
require_gate && permissions && clear_prior_boot_state || exit 1
case "$ACTION" in
  start) start_worker ;;
  stop) stop_worker ;;
  restart) stop_worker && require_gate && start_worker ;;
esac
