#!/system/bin/sh
# Local next-boot transaction only: no network, service start, or process kill.
# transaction.tsv is immutable after staging. All secret bytes stay on device.
set -u
umask 077
P=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
D=${VIDEO_DNS_ROOT:-$(dirname "$P")}
BB=${VIDEO_DNS_BUSYBOX:-/data/adb/magisk/busybox}
BOOT_FILE=${VIDEO_DNS_BOOT_ID_FILE:-/proc/sys/kernel/random/boot_id}
PROC=${VIDEO_DNS_PROC_ROOT:-/proc}
action=${1:---apply}
locked=${2:-}
case "$action" in --verify|--apply|--rollback) ;; *) echo dns_upgrade_invalid_action; exit 2 ;; esac
[ "$#" -le 2 ] && { [ -z "$locked" ] || {
  [ "$locked" = --locked ] && [ "$action" != --verify ] &&
    [ "${VIDEO_DNS_TRANSACTION_LOCKED:-}" = "$P/transaction.lock" ];
}; } || { echo dns_upgrade_invalid_arguments; exit 2; }
fail() { echo "dns_upgrade_refused reason=$1"; exit 1; }
digest() { "$BB" sha256sum "$1" 2>/dev/null | "$BB" awk '{print $1}'; }
regular() { [ -f "$1" ] && [ ! -L "$1" ]; }
hexhash() { [ "${#1}" -eq 64 ] && case "$1" in *[!0-9a-f]*) return 1;; esac; }
safe_parents() {
  for parent in "$D" "$D/youtube-failover" "$P" "$P/payload" "$P/backup" \
    "$P/payload/youtube-failover" "$P/backup/youtube-failover"; do
    [ -d "$parent" ] && [ ! -L "$parent" ] || return 1
  done
}
allowed() {
  case "$1" in
    config.json|video-boot-start.sh|youtube-failover/main-config.json|youtube-failover/active-main.sha256|youtube-failover/release-id|youtube-failover/enabled|youtube-failover/manifest.json|youtube-failover/service.sh|youtube-failover/video-boot-start.next.sh) return 0 ;;
    *) return 1 ;;
  esac
}
running() {
  for proc in "$PROC"/[0-9]*; do
    [ -r "$proc/cmdline" ] || continue
    cmd=$("$BB" tr '\000' '\n' < "$proc/cmdline" 2>/dev/null) || {
      [ -d "$proc" ] && return 0
      continue
    }
    if [ "$(readlink "$proc/exe" 2>/dev/null)" = "$D/sing-box" ] &&
       [ "$cmd" = "$(printf '%s\nrun\n-c\n%s' "$D/sing-box" "$D/config.json")" ]; then
      return 0
    fi
    # Workers are allowed; a live guardian or its supervisor is not.
    case "$cmd" in
      *"$(printf 'YoutubeFailover\n%s' "$D/youtube-failover/guard-config.json")"|*"$D/youtube-failover/guard-run.sh") return 0 ;;
    esac
  done
  return 1
}
anchors() {
  dir=$1
  regular "$dir/config.json" && regular "$dir/youtube-failover/active-main.sha256" &&
    regular "$dir/youtube-failover/release-id" && regular "$dir/youtube-failover/enabled" || return 1
  [ "$(digest "$dir/config.json")" = "$(cat "$dir/youtube-failover/active-main.sha256")" ] || return 1
  release=$(cat "$dir/youtube-failover/release-id") || return 1
  case "$release" in ''|*[!A-Za-z0-9._-]*) return 1 ;; esac
  [ "${#release}" -le 128 ] && [ "$release" = "$(cat "$dir/youtube-failover/enabled")" ]
}
preflight() {
  safe_parents && regular "$P/transaction.tsv" || return 1
  seen='|'; count=0
  while IFS="$(printf '\t')" read -r path old new mode extra || [ -n "$path" ]; do
    allowed "$path" && hexhash "$old" && hexhash "$new" && [ -z "$extra" ] || return 1
    case "$mode" in 600|700) ;; *) return 1 ;; esac
    case "$seen" in *"|$path|"*) return 1 ;; esac
    seen="$seen$path|"; count=$((count+1))
    for base in "$D" "$P/backup" "$P/payload"; do regular "$base/$path" || return 1; done
    [ "$(digest "$P/backup/$path")" = "$old" ] && [ "$(digest "$P/payload/$path")" = "$new" ] || return 1
    current=$(digest "$D/$path")
    [ "$current" = "$old" ] || [ "$current" = "$new" ] || return 1
    # A malformed mode must not accidentally make configuration executable.
    case "$path:$mode" in *.sh:700|*.json:600|*.sha256:600|*/release-id:600|*/enabled:600) ;; *) return 1 ;; esac
  done < "$P/transaction.tsv"
  [ "$count" -eq 9 ] && anchors "$P/backup" && anchors "$P/payload"
}
verify_set() {
  which=$1
  while IFS="$(printf '\t')" read -r path old new mode extra || [ -n "$path" ]; do
    expected=$new; [ "$which" = backup ] && expected=$old
    regular "$D/$path" && [ "$(digest "$D/$path")" = "$expected" ] &&
      [ "$("$BB" stat -c %a "$D/$path")" = "$mode" ] || return 1
  done < "$P/transaction.tsv"
  anchors "$D"
}
replace_set() {
  source=$1
  while IFS="$(printf '\t')" read -r path old new mode extra || [ -n "$path" ]; do
    expected=$new; [ "$source" = backup ] && expected=$old
    # Never overwrite a concurrent, unknown edit, including during recovery.
    regular "$D/$path" || return 1
    current=$(digest "$D/$path")
    [ "$current" = "$old" ] || [ "$current" = "$new" ] || return 1
    if [ "$current" = "$expected" ] && [ "$("$BB" stat -c %a "$D/$path")" = "$mode" ]; then continue; fi
    temp="$D/$path.dns-upgrade-$$"
    [ ! -e "$temp" ] && [ ! -L "$temp" ] || return 1
    (set -C; cat "$P/$source/$path" > "$temp") || return 1
    chmod "$mode" "$temp" && [ "$(digest "$temp")" = "$expected" ] || { rm -f "$temp"; return 1; }
    mv -f "$temp" "$D/$path" || { rm -f "$temp"; return 1; }
    [ "$(digest "$D/$path")" = "$expected" ] || return 1
  done < "$P/transaction.tsv"
  verify_set "$source"
}
write_marker() {
  name=$1
  temp="$P/$name.new-$$"
  [ ! -e "$temp" ] && [ ! -L "$temp" ] || return 1
  (set -C; printf '%s\n' "$boot" > "$temp") && chmod 600 "$temp" && mv -f "$temp" "$P/$name"
}
rollback_failure() {
  trap - HUP INT TERM
  if replace_set backup; then
    rm -f "$P/applied-boot-id"
    write_marker rolled-back-boot-id || :
    echo dns_upgrade_failed_backup_restored
  else
    echo dns_upgrade_failed_recovery_incomplete
  fi
  exit 1
}

regular "$P/installed-boot-id" && regular "$BOOT_FILE" || fail boot_identity_absent
boot=$(cat "$BOOT_FILE"); installed=$(cat "$P/installed-boot-id")
case "$boot:$installed" in *[!A-Za-z0-9_.:-]*|:*|*:) fail boot_identity_invalid ;; esac
if [ "$action" != --verify ] && [ "$boot" = "$installed" ]; then
  echo dns_upgrade_deferred_same_boot; exit 0
fi
preflight || fail preflight
if [ "$action" = --verify ]; then echo dns_upgrade_verified_read_only; exit 0; fi
running && fail production_process_running
# Magisk BusyBox supports pathname+command flock, not numeric descriptors or
# -w. Only successful preflight may create this separate 0600 lock file.
if [ -z "$locked" ]; then
  [ ! -L "$P/transaction.lock" ] && { [ ! -e "$P/transaction.lock" ] || regular "$P/transaction.lock"; } || fail invalid_lock
  export VIDEO_DNS_TRANSACTION_LOCKED="$P/transaction.lock"
  exec "$BB" flock -n "$P/transaction.lock" sh "$0" "$action" --locked
fi
[ "$(cat "$BOOT_FILE")" = "$boot" ] || fail boot_changed
if [ "$action" = --apply ] && regular "$P/rolled-back-boot-id"; then
  # Explicit rollback / failed activation must remain stable on retries.
  verify_set backup || fail rolled_back_state_changed
  echo dns_upgrade_rolled_back_preserved; exit 0
fi
trap rollback_failure HUP INT TERM
if [ "$action" = --rollback ]; then
  replace_set backup || rollback_failure
  write_marker rolled-back-boot-id || rollback_failure
  rm -f "$P/applied-boot-id"
  trap - HUP INT TERM
  echo dns_upgrade_rolled_back
  exit 0
fi
replace_set payload || rollback_failure
write_marker applied-boot-id || rollback_failure
trap - HUP INT TERM
echo dns_upgrade_applied
