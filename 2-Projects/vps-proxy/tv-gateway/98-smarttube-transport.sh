#!/system/bin/sh
# Keep SmartTube on HTTPS over TCP. Match new flows so a live session
# can finish using the transport it already negotiated.
(
  pkg=org.smarttube.beta
  for attempt in $(seq 1 45); do
    app_uid=$(cmd package list packages --user 0 -U "$pkg" 2>/dev/null |
      awk -v pkg="package:$pkg" '$1 == pkg && $2 ~ /^uid:[0-9]+$/ { sub(/^uid:/, "", $2); print $2 }')
    if [ -n "$app_uid" ] && [ "$app_uid" -ge 10000 ] 2>/dev/null; then
      set -- -p udp --dport 443 -m owner --uid-owner "$app_uid" \
        -m conntrack --ctstate NEW -j REJECT --reject-with icmp-port-unreachable
      iptables -w 2 -C OUTPUT "$@" 2>/dev/null && exit 0
      iptables -w 2 -I OUTPUT 1 "$@" && exit 0
    fi
    sleep 2
  done
  log -t SmartTubeTransport "Unable to install the IPv4 transport rule for $pkg"
) </dev/null >/dev/null 2>&1 &
