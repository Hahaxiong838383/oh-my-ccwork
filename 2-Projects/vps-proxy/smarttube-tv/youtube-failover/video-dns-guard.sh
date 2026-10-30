#!/system/bin/sh
# Shared by post-fs-data and the late boot worker. No network waits or secrets.
umask 077
# An asynchronous post-fs-data child may outlive its launcher's PATH mounts.
# Resolve every required executable explicitly; dirname is not needed at all.
BB=${VIDEO_PROXY_BUSYBOX:-/data/adb/magisk/busybox}
IP4=${VIDEO_PROXY_IPTABLES:-/system/bin/iptables}
IP6=${VIDEO_PROXY_IP6TABLES:-/system/bin/ip6tables}
case "$0" in */*) script_dir=${0%/*} ;; *) script_dir=. ;; esac
D=$(CDPATH= cd -- "$script_dir" && pwd) || exit 1
mode=${1:---install}
boot=$("$BB" cat /proc/sys/kernel/random/boot_id 2>/dev/null)

log() {
  printf 'boot=%s uptime=%s %s\n' "$boot" "$("$BB" cut -d ' ' -f 1 /proc/uptime)" "$*" >> "$D/dns-guard.log"
}

# --verify is read-only, including during the installation boot. Every mutation
# entry, including internal locked modes, is protected by the separate barrier.
case "$mode" in
  --verify) ;;
  --install|--install-locked|--watch|--watch-locked)
    installed=$("$BB" cat "$D/dns-guard-installed-boot-id" 2>/dev/null)
    if [ -z "$boot" ] || [ -z "$installed" ] || [ "$boot" = "$installed" ]; then
      echo 'video-dns-guard: deferred until next boot'
      exit 0
    fi
    ;;
  *) echo 'usage: video-dns-guard.sh [--install|--verify|--watch]' >&2; exit 2 ;;
esac

# The IPv4 filter chain catches DNS that has escaped NAT (including a stale
# conntrack entry). Redirected packets already have dport 5354 by filter OUTPUT.
# mark 255 is the explicit, validated NTP/bootstrap bypass in both families.
verify_jump() {
  first=$("$1" -t "$2" -S OUTPUT 2>/dev/null | "$BB" awk '$1 == "-A" { print; exit }')
  [ "$first" = "-A OUTPUT -j $3" ]
}
verify_chain() {
  # -S canonicalizes decimal marks and implicit UDP/TCP matches. Normalize only
  # those representations, then compare the actual first three rules in order.
  prefix=$("$1" -t "$2" -S "$3" 2>/dev/null | "$BB" awk '
    $1 == "-A" {
      gsub(/ -m (udp|tcp) /, " ")
      gsub(/--mark 0xff(\/0xffffffff)? /, "--mark 255 ")
      gsub(/ -j REJECT --reject-with (icmp-port-unreachable|icmp6-port-unreachable)$/, " -j REJECT")
      print
      if (++n == 3) exit
    }')
  if [ "$4" = REDIRECT ]; then suffix=' -j REDIRECT --to-ports 5354'; else suffix=' -j REJECT'; fi
  expected=$(printf '%s\n' "-A $3 -m mark --mark 255 -j RETURN" \
    "-A $3 -p udp --dport 53$suffix" "-A $3 -p tcp --dport 53$suffix")
  [ "$prefix" = "$expected" ]
}
verify() {
  verify_chain "$IP4" filter VIDEO_DNS4_GUARD REJECT &&
  verify_jump "$IP4" filter VIDEO_DNS4_GUARD &&
  verify_chain "$IP6" filter VIDEO_DNS6 REJECT &&
  verify_jump "$IP6" filter VIDEO_DNS6 &&
  verify_chain "$IP4" nat VIDEO_DNS REDIRECT &&
  verify_jump "$IP4" nat VIDEO_DNS
}

ensure_chain() {
  verify_chain "$@" && return 0
  # Insert a complete ordered prefix in reverse order. Existing safety rules
  # stay live, and an old broad RETURN/ACCEPT can no longer precede the guards.
  if [ "$4" = REDIRECT ]; then
    "$1" -t "$2" -I "$3" 1 -p tcp --dport 53 -j REDIRECT --to-ports 5354 || return 1
    "$1" -t "$2" -I "$3" 1 -p udp --dport 53 -j REDIRECT --to-ports 5354 || return 1
  else
    "$1" -t "$2" -I "$3" 1 -p tcp --dport 53 -j REJECT || return 1
    "$1" -t "$2" -I "$3" 1 -p udp --dport 53 -j REJECT || return 1
  fi
  "$1" -t "$2" -I "$3" 1 -m mark --mark 255 -j RETURN
}
ensure_jump() {
  # netd may prepend an ACCEPT hook. Presence alone is insufficient: ours must
  # run first. Insert before it without removing any still-protective old jump.
  verify_jump "$1" "$2" "$3" ||
    "$1" -t "$2" -I OUTPUT 1 -j "$3"
}
install() {
  # Fully construct the rejection chains before hooking OUTPUT. Never flush or
  # unhook a live chain, even on failure: retry must not reopen cleartext DNS.
  "$IP4" -t filter -N VIDEO_DNS4_GUARD 2>/dev/null || :
  ensure_chain "$IP4" filter VIDEO_DNS4_GUARD REJECT || return 1
  ensure_jump "$IP4" filter VIDEO_DNS4_GUARD || return 1
  "$IP6" -t filter -N VIDEO_DNS6 2>/dev/null || :
  ensure_chain "$IP6" filter VIDEO_DNS6 REJECT || return 1
  ensure_jump "$IP6" filter VIDEO_DNS6 || return 1
  "$IP4" -t nat -N VIDEO_DNS 2>/dev/null || :
  ensure_chain "$IP4" nat VIDEO_DNS REDIRECT || return 1
  ensure_jump "$IP4" nat VIDEO_DNS || return 1
  verify
}

case "$mode" in
  --verify) verify ;;
  --install)
    # A busy installer is not proof of broken protection. The startup watcher
    # and boot worker call this concurrently; failing flock on already-correct
    # rules used to make the boot worker kill a healthy proxy and sleep 30s.
    # Keep the next-boot barrier above, and require the full ordered-rule check.
    if verify; then exit 0; fi
    # post-fs-data must never block Magisk on network or an xtables lock.
    "$BB" timeout 8 "$BB" flock -n "$D/dns-guard.lock" "$BB" sh "$0" --install-locked
    rc=$?
    if [ "$rc" -ne 0 ]; then
      # Another installer may have finished after our initial check. Never
      # infer success from the lock result: re-read all hooks and rule prefixes.
      if verify; then
        log "concurrent_install_verified rc=$rc"
        exit 0
      fi
      log "install_failed_unverified rc=$rc"
    fi
    exit "$rc"
    ;;
  --install-locked)
    if verify; then exit 0; fi
    if install; then log rules_installed; else log rule_install_failed_protection_retained; exit 1; fi
    ;;
  --watch)
    exec "$BB" flock -n "$D/dns-guard-watch.lock" "$BB" sh "$0" --watch-locked
    ;;
  --watch-locked)
    # Startup-only audit, launched asynchronously by post-fs-data. This catches
    # removed hooks but cannot prove that netd never creates a between-poll gap.
    # It also verifies once after ready before stopping; no permanent watchdog.
    i=0
    started=$("$BB" cut -d ' ' -f 1 /proc/uptime); started=${started%%.*}
    while :; do
      now=$("$BB" cut -d ' ' -f 1 /proc/uptime); now=${now%%.*}
      [ "$((now-started))" -lt 240 ] || break
      i=$((i+1))
      "$BB" sh "$0" --install || log "startup_repair_failed attempt=$i"
      if [ "$("$BB" cat "$D/boot-ready-boot-id" 2>/dev/null)" = "$boot" ] && verify; then
        log startup_audit_ready
        exit 0
      fi
      "$BB" sleep 2
    done
    log startup_audit_limit_protection_retained
    exit 1
    ;;
esac
