#!/system/bin/sh
# Local next-boot transaction only: no network, service start, or process kill.
# transaction.tsv is immutable after staging. All secret bytes stay on device.
# No transaction-profile file keeps the original nine-file DNS transaction.
# rack-dualstack-v1 adds six paths; v2 adds the existing workerctl.sh as well.
# Same-boot changes require
# --apply-authorized or --rollback-authorized; plain actions still defer.
set -u
umask 077
P=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
D=${VIDEO_DNS_ROOT:-$(dirname "$P")}
BB=${VIDEO_DNS_BUSYBOX:-/data/adb/magisk/busybox}
BOOT_FILE=${VIDEO_DNS_BOOT_ID_FILE:-/proc/sys/kernel/random/boot_id}
PROC=${VIDEO_DNS_PROC_ROOT:-/proc}
action=${1:---apply}
locked=${2:-}
case "$action" in
  --verify|--apply|--rollback|--apply-authorized|--rollback-authorized) ;;
  *) echo dns_upgrade_invalid_action; exit 2 ;;
esac
case "$action" in
  --verify) operation=verify ;;
  --apply|--apply-authorized) operation=apply ;;
  --rollback|--rollback-authorized) operation=rollback ;;
esac
# --locked only proves this process is the flock child. It never authorizes.
[ "$#" -le 2 ] && { [ -z "$locked" ] || {
  [ "$locked" = --locked ] && [ "$action" != --verify ] &&
    [ "${VIDEO_DNS_TRANSACTION_LOCKED:-}" = "$P/transaction.lock" ];
}; } || { echo dns_upgrade_invalid_arguments; exit 2; }
fail() { echo "dns_upgrade_refused reason=$1"; exit 1; }
digest() { "$BB" sha256sum "$1" 2>/dev/null | "$BB" awk '{print $1}'; }
regular() { [ -f "$1" ] && [ ! -L "$1" ]; }
hexhash() { [ "${#1}" -eq 64 ] && case "$1" in *[!0-9a-f]*) return 1;; esac; }
load_profile() {
  # Absence is the legacy transaction. Any other file must be exactly one name.
  profile=dns9
  include_workerctl=no
  if [ ! -e "$P/transaction-profile" ] && [ ! -L "$P/transaction-profile" ]; then
    return 0
  fi
  regular "$P/transaction-profile" || return 1
  profile_name=$(cat "$P/transaction-profile" 2>/dev/null) || return 1
  case "$profile_name" in
    rack-dualstack-v1) profile=rack ;;
    rack-dualstack-v2) profile=rack; include_workerctl=yes ;;
    *) return 1 ;;
  esac
}
authorized_for_boot() {
  regular "$P/authorized-current-boot-id" || return 1
  [ "$("$BB" stat -c %a "$P/authorized-current-boot-id")" = 600 ] || return 1
  [ "$(cat "$P/authorized-current-boot-id" 2>/dev/null)" = "$boot" ]
}
require_current_authorization() {
  load_profile || fail unknown_profile
  [ "$profile" = rack ] || fail authorized_profile_rejected
  authorized_for_boot || fail authorization_invalid
}
safe_parents() {
  for parent in "$D" "$D/youtube-failover" "$P" "$P/payload" "$P/backup" \
    "$P/payload/youtube-failover" "$P/backup/youtube-failover"; do
    [ -d "$parent" ] && [ ! -L "$parent" ] || return 1
  done
  # Three roots, and both directory levels, otherwise workers can escape.
  if [ "$profile" = rack ]; then
    for base in "$D" "$P/payload" "$P/backup"; do
      for parent in "$base/youtube-failover/workers" "$base/youtube-failover/workers/rack"; do
        [ -d "$parent" ] && [ ! -L "$parent" ] || return 1
      done
    done
  fi
}
allowed() {
  case "$1" in
    youtube-failover/workerctl.sh) [ "$include_workerctl" = yes ]; return $? ;;
    config.json|video-boot-start.sh|youtube-failover/main-config.json|youtube-failover/active-main.sha256|youtube-failover/release-id|youtube-failover/enabled|youtube-failover/manifest.json|youtube-failover/service.sh|youtube-failover/video-boot-start.next.sh)
      return 0 ;;
    youtube-failover/guard.dex|youtube-failover/guard-config.json|youtube-failover/guard-observe.json|youtube-failover/workers/rack/config.json|youtube-failover/workers/rack/config.sha256|video-dns-service-start.sh)
      # video-dns-service-start.sh is a normal member, so the starter can replace itself.
      if [ "$profile" = rack ]; then return 0; fi
      return 1 ;;
    *) return 1 ;;
  esac
}
running() {
  # Stager pins this digest. Missing/corrupt/uncertain helpers retain the full
  # original predicate; only 0/1 mean a completed native decision.
  scan="$P/video-proc-scan"
  scan_sha=UNSTAGED_PROC_SCAN_SHA256
  if regular "$scan" && [ -x "$scan" ] && [ "$(digest "$scan")" = "$scan_sha" ]; then
    "$scan" "$PROC" transaction "$D" "$profile"
    scan_rc=$?
    case "$scan_rc" in 0|1) return "$scan_rc" ;; esac
  fi
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
    # ZGO may stay up. Rack blocks only the dual-stack profile.
    if [ "$profile" = rack ] && [ "$(readlink "$proc/exe" 2>/dev/null)" = "$D/sing-box" ] &&
       [ "$cmd" = "$(printf '%s\nrun\n-c\n%s' "$D/sing-box" "$D/youtube-failover/workers/rack/config.json")" ]; then
      return 0
    fi
    # A live guardian or its supervisor is never allowed.
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
  [ "${#release}" -le 128 ] && [ "$release" = "$(cat "$dir/youtube-failover/enabled")" ] || return 1
  [ "$profile" = rack ] || return 0
  regular "$dir/youtube-failover/workers/rack/config.json" &&
    regular "$dir/youtube-failover/workers/rack/config.sha256" || return 1
  [ "$(digest "$dir/youtube-failover/workers/rack/config.json")" = "$(cat "$dir/youtube-failover/workers/rack/config.sha256")" ]
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
    # guard.dex is non-executable; only that exact path may use this exception.
    case "$path:$mode" in
      *.sh:700|*.json:600|*.sha256:600|*/release-id:600|*/enabled:600|youtube-failover/guard.dex:600) ;;
      *) return 1 ;;
    esac
  done < "$P/transaction.tsv"
  need=9
  if [ "$profile" = rack ]; then need=15; fi
  if [ "$include_workerctl" = yes ]; then need=16; fi
  [ "$count" -eq "$need" ] && anchors "$P/backup" && anchors "$P/payload"
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
case "$action" in
  --apply-authorized|--rollback-authorized) require_current_authorization ;;
  *)
    if [ "$action" != --verify ] && [ "$boot" = "$installed" ]; then
      echo dns_upgrade_deferred_same_boot; exit 0
    fi
    ;;
esac
load_profile || fail unknown_profile
printf 'dns_upgrade_phase boot=%s uptime=%s preflight_start locked=%s\n' "$boot" "$(cut -d ' ' -f 1 /proc/uptime)" "$locked"
preflight || fail preflight
if [ "$action" = --verify ]; then echo dns_upgrade_verified_read_only; exit 0; fi
printf 'dns_upgrade_phase boot=%s uptime=%s scan_start locked=%s\n' "$boot" "$(cut -d ' ' -f 1 /proc/uptime)" "$locked"
running && fail production_process_running
printf 'dns_upgrade_phase boot=%s uptime=%s scan_absent locked=%s\n' "$boot" "$(cut -d ' ' -f 1 /proc/uptime)" "$locked"
# Magisk BusyBox supports pathname+command flock, not numeric descriptors or
# -w. Only successful preflight may create this separate 0600 lock file.
# The child keeps the caller's action, so --locked cannot drop authorization
# or turn a plain same-boot action into an authorized one.
if [ -z "$locked" ]; then
  [ ! -L "$P/transaction.lock" ] && { [ ! -e "$P/transaction.lock" ] || regular "$P/transaction.lock"; } || fail invalid_lock
  export VIDEO_DNS_TRANSACTION_LOCKED="$P/transaction.lock"
  exec "$BB" flock -n "$P/transaction.lock" sh "$0" "$action" --locked
fi
[ "$(cat "$BOOT_FILE")" = "$boot" ] || fail boot_changed
case "$action" in
  --apply-authorized|--rollback-authorized) require_current_authorization ;;
esac
if [ "$operation" = apply ] && regular "$P/rolled-back-boot-id"; then
  # Explicit rollback / failed activation must remain stable on retries.
  verify_set backup || fail rolled_back_state_changed
  echo dns_upgrade_rolled_back_preserved; exit 0
fi
trap rollback_failure HUP INT TERM
if [ "$operation" = rollback ]; then
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
