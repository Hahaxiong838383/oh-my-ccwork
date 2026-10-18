#!/system/bin/sh
# No secrets here. config.json is the existing, protected device configuration.
umask 077
D=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
BB=${VIDEO_PROXY_BUSYBOX:-/data/adb/magisk/busybox}
boot=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)
installed=$(cat "$D/boot-fix-installed-boot-id" 2>/dev/null)
if [ -z "$boot" ] || [ -z "$installed" ] || [ "$boot" = "$installed" ]; then
  echo 'video-proxy: deferred until next boot'
  exit 0
fi
if [ "${1:-}" != --locked ]; then
  exec "$BB" flock -n "$D/boot-start.lock" sh "$0" --locked
fi

log() {
  printf '%s boot=%s uptime=%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$boot" "$(cut -d ' ' -f 1 /proc/uptime)" "$*" >> "$D/boot-start.log"
}
fail() { log "$*"; exit 1; }
retry() {
  log "retry_later reason=$*"
  sleep 30
  # The parent busybox flock remains alive and owns the same lock across exec.
  exec sh "$0" --locked
}
if [ -f "$D/boot-start.log" ] && [ "$(wc -c < "$D/boot-start.log")" -gt 131072 ]; then
  mv "$D/boot-start.log" "$D/boot-start.log.1" || exit 1
fi
if [ "$(cat "$D/boot-ready-boot-id" 2>/dev/null)" = "$boot" ]; then
  log already_completed
  exit 0
fi
# Never kill or replace an existing service from the boot path.
if pidof sing-box >/dev/null 2>&1; then
  fail existing_proxy_preserved
fi
if [ -f "$D/hybrid-pending" ]; then
  fail pending_legacy_trial_requires_recovery
fi
[ -x "$D/video-boot-net" ] || fail missing_network_helper
[ -x "$D/sing-box" ] || fail missing_proxy_binary
[ -r "$D/video-dns-cache.dex" ] || fail missing_dns_cache_helper

# Android's early startup may replace the RTC's 1970 time with the build date.
# Wait until that phase is over before setting time ourselves.
i=0
while [ "$(getprop sys.boot_completed)" != 1 ]; do
  i=$((i+1))
  [ "$i" -lt 90 ] || retry android_boot_timeout
  sleep 2
done
log android_boot_complete

i=0
epoch=
while [ "$i" -lt 12 ]; do
  i=$((i+1))
  if ip -4 addr show dev eth0 scope global 2>/dev/null | grep -q 'inet ' &&
     ip -4 route get 223.5.5.5 oif eth0 mark 255 >/dev/null 2>&1; then
    epoch=$("$D/video-boot-net" time eth0 2>> "$D/boot-start.log")
    rc=$?
    case "$epoch" in ''|*[!0-9]*) rc=1 ;; esac
    if [ "$rc" -eq 0 ] && [ "$epoch" -ge 1767225600 ] && [ "$epoch" -lt 2082758400 ]; then
      break
    fi
  fi
  epoch=
  log "time_source_retry attempt=$i"
  [ "$i" -ge 12 ] || sleep 10
done
[ -n "$epoch" ] || retry time_sources_unavailable_no_dns_takeover

now=$(date +%s)
delta=$((now-epoch)); [ "$delta" -ge 0 ] || delta=$((-delta))
if [ "$delta" -gt 3 ]; then
  date -u "@$epoch" >> "$D/boot-start.log" 2>&1 || fail clock_set_failed
fi
now=$(date +%s)
delta=$((now-epoch)); [ "$delta" -ge 0 ] || delta=$((-delta))
[ "$delta" -le 3 ] || fail clock_readback_failed
log clock_verified

"$D/sing-box" check -c "$D/config.json" >> "$D/boot-start.log" 2>&1 || fail config_check_failed
# Recheck under the same lock immediately before creating the process.
pidof sing-box >/dev/null 2>&1 && fail proxy_appeared_preserved
if [ -f "$D/sing-box-zgo.log" ] && [ "$(wc -c < "$D/sing-box-zgo.log")" -gt 5000000 ]; then
  mv "$D/sing-box-zgo.log" "$D/sing-box-zgo.log.1" || fail log_rotation_failed
fi
"$BB" nohup "$D/sing-box" run -c "$D/config.json" >> "$D/run.log" 2>&1 </dev/null &
owned_pid=$!
stop_owned_proxy() {
  # Only a process created by this invocation, with the expected executable.
  if [ "$(readlink "/proc/$owned_pid/exe" 2>/dev/null)" = "$D/sing-box" ]; then
    kill "$owned_pid" 2>/dev/null
  fi
}

i=0
ready=0
while [ "$i" -lt 20 ]; do
  i=$((i+1))
  if "$D/video-boot-net" dns www.youtube.com 127.0.0.1 5354 >/dev/null 2>&1 &&
     "$D/video-boot-net" dns ntp3.aliyun.com 127.0.0.1 5354 >/dev/null 2>&1; then
    ready=1
    break
  fi
  log "dns_not_ready attempt=$i"
  sleep 2
done
if [ "$ready" -ne 1 ]; then
  stop_owned_proxy
  retry dns_failed_no_takeover
fi
log dns_queries_verified

undo_dns() {
  while iptables -t nat -D OUTPUT -j VIDEO_DNS 2>/dev/null; do :; done
  while ip6tables -D OUTPUT -j VIDEO_DNS6 2>/dev/null; do :; done
}
dns_failed() {
  undo_dns
  stop_owned_proxy
  fail dns_rule_install_failed
}
iptables -t nat -N VIDEO_DNS 2>/dev/null || :
iptables -t nat -F VIDEO_DNS || dns_failed
iptables -t nat -A VIDEO_DNS -m mark --mark 255 -j RETURN || dns_failed
iptables -t nat -A VIDEO_DNS -p udp --dport 53 -j REDIRECT --to-ports 5354 || dns_failed
iptables -t nat -A VIDEO_DNS -p tcp --dport 53 -j REDIRECT --to-ports 5354 || dns_failed
ip6tables -N VIDEO_DNS6 2>/dev/null || :
ip6tables -F VIDEO_DNS6 || dns_failed
ip6tables -A VIDEO_DNS6 -p udp --dport 53 -j REJECT || dns_failed
ip6tables -A VIDEO_DNS6 -p tcp --dport 53 -j REJECT || dns_failed
iptables -t nat -C OUTPUT -j VIDEO_DNS 2>/dev/null || iptables -t nat -A OUTPUT -j VIDEO_DNS || dns_failed
ip6tables -C OUTPUT -j VIDEO_DNS6 2>/dev/null || ip6tables -A OUTPUT -j VIDEO_DNS6 || dns_failed
settings put global private_dns_mode off || dns_failed
ip rule del pref 8999 2>/dev/null || :
# Validate again after activating the rules, before declaring this boot ready.
"$D/video-boot-net" dns www.youtube.com 127.0.0.1 5354 >/dev/null 2>&1 || dns_failed

flush_dns_caches() {
  # Apps may have resolved through the ISP before the proxy was ready. Derive
  # every live network ID, and use the platform interface rather than guessed
  # Binder transaction numbers. Re-read IDs on every retry (networks can change).
  resolver_state=$(dumpsys dnsresolver 2>> "$D/boot-start.log") || return 1
  net_ids=$(printf '%s\n' "$resolver_state" | "$BB" awk '
    /^[[:space:]]*NetId:[[:space:]]*/ {
      sub(/^[[:space:]]*NetId:[[:space:]]*/, "")
      sub(/[[:space:]]*$/, "")
      if ($0 !~ /^[0-9]+$/ || $0 < 1 || $0 > 65535) { bad=1; next }
      ids[$0+0]=1; found=1
    }
    END {
      if (bad || !found) exit 1
      for (id in ids) printf "%d\n", id
    }') || return 1
  [ -n "$net_ids" ] || return 1
  CLASSPATH="$D/video-dns-cache.dex:/system/framework/services.jar" \
    app_process /system/bin VideoDnsCache $net_ids >> "$D/boot-start.log" 2>&1 || return 1
  am broadcast --user all -a android.intent.action.CLEAR_DNS_CACHE >> "$D/boot-start.log" 2>&1 || return 1
  # Fresh app_process instances now exercise Android's system resolver, not the
  # helper's direct UDP socket. DNS address rotation is allowed; playback and
  # the logged returned addresses remain separate device acceptance evidence.
  for host in www.youtube.com ntp3.aliyun.com; do
    CLASSPATH="$D/video-dns-cache.dex:/system/framework/services.jar" \
      app_process /system/bin VideoDnsCache --resolve "$host" >> "$D/boot-start.log" 2>&1 || return 1
  done
  # Cache recovery may take time. Require the proxy itself still to answer both
  # names immediately before committing readiness, within this same retry loop.
  for host in www.youtube.com ntp3.aliyun.com; do
    "$D/video-boot-net" dns "$host" 127.0.0.1 5354 >/dev/null 2>&1 || return 1
  done
}
cache_attempt=0
while ! flush_dns_caches; do
  cache_attempt=$((cache_attempt+1))
  log "dns_cache_retry attempt=$cache_attempt"
  # Keep the healthy proxy and DNS rules. The earlier retry/dns_failed paths
  # would restart or stop that proxy, so cache recovery stays in this worker.
  sleep 10
done
log dns_caches_flushed
printf '%s\n' "$boot" > "$D/boot-ready-boot-id.new" || dns_failed
mv "$D/boot-ready-boot-id.new" "$D/boot-ready-boot-id" || dns_failed
log dns_takeover_ready
