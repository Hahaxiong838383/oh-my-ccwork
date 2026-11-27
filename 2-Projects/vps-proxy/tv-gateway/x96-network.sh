#!/system/bin/sh
# Installed in /data/adb/dsh-gateway. Both Magisk stages use the same rules.
set -u
state=/data/adb/dsh-gateway
receipt_dir=/data/misc/x96-boot-status
transport=/data/adb/service.d/98-smarttube-transport.sh
uptime_file=/proc/uptime
boot_id=$(cat /proc/sys/kernel/random/boot_id) || exit 1

read_uptime() {
  IFS=' ' read -r elapsed unused <"$uptime_file" || return 1
  seconds=${elapsed%%.*}
  case "$seconds" in ''|*[!0-9]*) return 1 ;; esac
}

write_receipt() (
  case "$1" in early|late|verified) ;; *) exit 2 ;; esac
  file=$receipt_dir/$1
  if [ "$1" != verified ] && [ -f "$file" ] &&
     IFS=' ' read -r saved stamp <"$file" && [ "$saved" = "$boot_id" ]; then
    case "$stamp" in ''|*[!0-9]*) ;; *) exit 0 ;; esac
  fi
  read_uptime || exit 1
  umask 077
  temp=$(mktemp "$receipt_dir/.$1.XXXXXX") || exit 1
  trap 'rm -f "$temp"' EXIT
  printf '%s %s\n' "$boot_id" "$seconds" >"$temp" &&
    chmod 0644 "$temp" && mv -f "$temp" "$file"
)

ensure_rule() {
  tool=$1 table=$2 chain=$3
  shift 3
  "$tool" -t "$table" -C "$chain" "$@" 2>/dev/null && return 0
  [ "$operation" = ensure ] || return 1
  "$tool" -t "$table" -I "$chain" 1 "$@" &&
    "$tool" -t "$table" -C "$chain" "$@"
}

ensure_rules() (
  operation=${1:-ensure}
  exec 8>"$state/x96-network-rules.lock" || exit 1
  # Android mksh opens script descriptors close-on-exec. Explicitly pass this
  # descriptor to flock; the parent shell retains the same open description.
  flock -n 8 8>&8 || exit 1
  failed=0

  # No global address loss: IpClient keeps ownership of eth0 provisioning.
  ensure_rule ip6tables filter INPUT -i eth0 -p ipv6-icmp \
    --icmpv6-type router-advertisement -j DROP || failed=1

  # The two ranges cover all nonlocal unicast destinations except ::/::1.
  # fe80::/10 and ff00::/8 remain usable for link-local traffic and NDP.
  for destinations in ::2-fe7f:ffff:ffff:ffff:ffff:ffff:ffff:ffff fec0::-feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff; do
    ensure_rule ip6tables filter OUTPUT -o eth0 -m iprange \
      --dst-range "$destinations" -j REJECT --reject-with icmp6-no-route || failed=1
  done
  for protocol in udp tcp; do
    # A router may advertise its link-local IPv6 address as a DNS server.
    ensure_rule ip6tables filter OUTPUT -o eth0 -p "$protocol" \
      --dport 53 -j REJECT --reject-with icmp6-port-unreachable || failed=1
    # HA owns the first IPv4 DNS jump after Ethernet is ready. Its monitor
    # checks/repairs the selected target; never put primary DNAT ahead of it.
    if iptables -t nat -C OUTPUT -p "$protocol" --dport 53 -j X96_GW_DNS 2>/dev/null; then
      continue
    fi
    ensure_rule iptables nat OUTPUT -p "$protocol" --dport 53 \
      -j DNAT --to-destination 192.168.1.19:53 || failed=1
  done
  exit "$failed"
)

report_ready() {
  log -t X96Network "ready boot=$boot_id phase=$1" || :
}

check_transport() {
  sh "$transport" --ensure && ensure_rules check && write_receipt verified
}

ensure_with_retry() {
  attempt=0
  until ensure_rules; do
    attempt=$((attempt + 1))
    [ "$attempt" -ne 3 ] || log -t X96Network 'Firewall setup still pending'
    sleep 3
  done
}

watch_network() {
  exec 9>"$state/x96-network-monitor.lock" || exit 1
  flock -n 9 9>&9 || exit 0
  fifo="$state/x96-network-events.fifo"
  [ -p "$fifo" ] || mkfifo "$fifo" || exit 1
  monitor_pid=''
  trap '[ -z "$monitor_pid" ] || kill "$monitor_pid" 2>/dev/null; rm -f "$fifo"' EXIT
  trap 'exit 0' TERM INT
  late_ready=0
  # Only future checkpoints are needed; start with a live check even if this
  # process is first installed hours after boot. Once the queue is empty and
  # Android has booted, the monitor blocks indefinitely on netlink.
  set -- 30 60 120 240 300
  read_uptime || exit 1
  while [ "$#" -gt 0 ] && [ "$1" -le "$seconds" ]; do shift; done
  while :; do
    ip monitor link address route dev eth0 9>&- >"$fifo" &
    monitor_pid=$!
    exec 7<"$fifo"
    ensure_with_retry
    check_transport || :
    while :; do
      if [ "$late_ready" -eq 0 ] && [ "$(getprop sys.boot_completed)" = 1 ]; then
        ensure_with_retry
        if ensure_rules check && write_receipt late; then
          report_ready late
          late_ready=1
          check_transport || :
        fi
      fi
      read_uptime || exit 1
      if [ "$#" -gt 0 ] && [ "$1" -le "$seconds" ]; then
        while [ "$#" -gt 0 ] && [ "$1" -le "$seconds" ]; do shift; done
        ensure_with_retry
        check_transport || :
        continue
      fi
      timeout=0
      if [ "$#" -gt 0 ]; then timeout=$(($1 - seconds)); fi
      if [ "$late_ready" -eq 0 ] && { [ "$timeout" -eq 0 ] || [ "$timeout" -gt 2 ]; }; then
        timeout=2
      fi
      if [ "$timeout" -eq 0 ]; then
        IFS= read -r event <&7 || break
      elif ! IFS= read -r -t "$timeout" event <&7; then
        kill -0 "$monitor_pid" 2>/dev/null || break
        continue
      fi
      # Debounce a burst; a busy interface still gets a check after 16 events.
      n=1
      while [ "$n" -lt 16 ] && IFS= read -r -t 1 event <&7; do n=$((n + 1)); done
      ensure_with_retry
      check_transport || :
    done
    exec 7<&-
    wait "$monitor_pid"
    monitor_pid=''
    # Handles an interface which has not appeared yet or a lost subscription.
    sleep 5
  done
}

case "${1:-}" in
  --ensure) ensure_rules && ensure_rules check && report_ready ensure ;;
  --early) ensure_rules && ensure_rules check && write_receipt early && report_ready early ;;
  --watch) watch_network ;;
  *) exit 2 ;;
esac
