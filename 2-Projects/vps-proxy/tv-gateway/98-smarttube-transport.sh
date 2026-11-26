#!/system/bin/sh
# Negotiate TCP for new SmartTube HTTPS flows. Leave established flows alone.
pkg=org.smarttube.beta

ensure_transport() (
  exec 8>/data/adb/dsh-gateway/x96-transport.lock || exit 1
  flock -n 8 8>&8 || exit 1
  app_uid=$(cmd package list packages --user 0 -U "$pkg" 2>/dev/null |
    awk -v pkg="package:$pkg" '$1 == pkg && $2 ~ /^uid:[0-9]+$/ {sub(/^uid:/, "", $2); print $2}')
  [ -n "$app_uid" ] && [ "$app_uid" -ge 10000 ] 2>/dev/null || exit 1
  set -- -p udp --dport 443 -m owner --uid-owner "$app_uid" \
    -m conntrack --ctstate NEW -j REJECT --reject-with icmp-port-unreachable
  if ! iptables -w 2 -C OUTPUT "$@" 2>/dev/null; then
    iptables -w 2 -I OUTPUT 1 "$@" || exit 1
  fi
  iptables -w 2 -C OUTPUT "$@" || exit 1
  echo "$app_uid"
)

case "${1:-}" in
  --ensure) ensure_transport >/dev/null; exit $? ;;
  "") ;;
  *) exit 2 ;;
esac

(
  for attempt in $(seq 1 45); do
    if app_uid=$(ensure_transport); then
      boot=$(cat /proc/sys/kernel/random/boot_id) || exit 1
      read -r uptime _ < /proc/uptime || exit 1
      dir=/data/misc/x96-boot-status
      umask 022
      printf '%s %s\n' "$boot" "${uptime%%.*}" > "$dir/transport.new.$$" &&
        mv -f "$dir/transport.new.$$" "$dir/transport" || exit 1
      log -t SmartTubeTransport "ready boot=$boot uid=$app_uid"
      exit 0
    fi
    sleep 2
  done
  log -t SmartTubeTransport "Unable to install the IPv4 transport rule for $pkg"
) </dev/null >/dev/null 2>&1 &
