#!/bin/bash
# Run only inside an empty Docker --network none namespace (see x96-install.md).
set -euo pipefail
[[ -f /.dockerenv && $(ip -o link show | wc -l) -eq 1 && -d /fixture ]] || exit 2
ip link show lo >/dev/null
root=$(mktemp -d /tmp/x96-fixture.XXXXXX)
state=$root/state
receipt_dir=$root/receipts
transport=$root/transport.sh
uptime_file=$root/uptime
mkdir -p "$state" "$receipt_dir" /tmp/x96-bin
chmod 0755 "$receipt_dir"
printf '#!/bin/sh\necho 1\n' >/tmp/x96-bin/getprop
printf '#!/bin/sh\necho "$*" >> /tmp/x96-readiness\n' >/tmp/x96-bin/log
chmod 755 /tmp/x96-bin/{getprop,log}
export PATH=/tmp/x96-bin:$PATH
script=$root/network.sh
sed -e "s|^state=.*|state=$state|" -e "s|^receipt_dir=.*|receipt_dir=$receipt_dir|" \
  -e "s|^transport=.*|transport=$transport|" -e "s|^uptime_file=.*|uptime_file=$uptime_file|" \
  /fixture/x96-network.sh > "$script"
cat >"$transport" <<'SH'
#!/bin/sh
[ "$#" -eq 1 ] && [ "$1" = --ensure ] || exit 2
base=${0%/*}
cat "$base/uptime" >>"$base/transport-calls"
[ -f "$base/transport-available" ]
SH
printf '298.90 0\n' > "$uptime_file"
boot=$(cat /proc/sys/kernel/random/boot_id)
printf 'previous-boot 88\n' > "$receipt_dir/early"
ra=(-i eth0 -p ipv6-icmp --icmpv6-type router-advertisement -j DROP)
dns=(-p tcp --dport 53 -j DNAT --to-destination 192.168.1.19:53)
snapshot() { ip6tables -S; iptables -t nat -S; }

# The early stage runs before eth0 exists. Repeat to check exact idempotency.
bash "$script" --early
grep -Fq "ready boot=$(cat /proc/sys/kernel/random/boot_id) phase=early" /tmp/x96-readiness
[[ $(cat "$receipt_dir/early") == "$boot 298" ]]
[[ $(stat -c %a "$receipt_dir/early") == 644 && ! -e "$receipt_dir/late" ]]
[[ ! -e "$root/transport-calls" ]]
first=$(snapshot)
[[ $(ip6tables -S | grep -c '^-A') -eq 5 ]]
[[ $(iptables -t nat -S | grep -c '^-A') -eq 2 ]]
printf '299.90 0\n' > "$uptime_file"
bash "$script" --ensure
[[ $(cat "$receipt_dir/early") == "$boot 298" && ! -e "$receipt_dir/late" ]]
[[ "$first" == "$(snapshot)" ]]
grep -Fq 'phase=ensure' /tmp/x96-readiness

ip link add eth0 type veth peer name peer0
ip link set eth0 up
ip link set peer0 up
ip addr add 192.168.1.144/24 dev eth0
ip -6 addr add fd70::1/64 dev eth0 nodad
ip -6 addr add fe80::1/64 dev eth0 nodad
ip -6 neigh replace fe80::ab lladdr "$(cat /sys/class/net/peer0/address)" nud permanent dev eth0
ip -6 route add default dev eth0
ip route add default via 192.168.1.19
bash "$script" --watch &
watch_pid=$!
trap 'kill "$watch_pid" 2>/dev/null || :; wait "$watch_pid" 2>/dev/null || :' EXIT
for attempt in {1..30}; do
  [[ -p "$state/x96-network-events.fifo" ]] && break
  sleep 0.1
done
bash "$script" --watch   # Duplicate invocation must return.
for attempt in {1..25}; do
  [[ -f "$receipt_dir/late" ]] && break
  sleep .1
done
[[ $(cat "$receipt_dir/late") == "$boot 299" ]]
[[ ! -e "$receipt_dir/verified" && -s "$root/transport-calls" ]]
touch "$root/transport-available"
printf '300.00 0\n' > "$uptime_file"
for attempt in {1..30}; do
  [[ -f "$receipt_dir/verified" ]] && break
  sleep .15
done
[[ $(cat "$receipt_dir/verified") == "$boot 300" ]]
[[ $(stat -c %a "$receipt_dir/verified") == 644 ]]

# Model a netd rewrite followed by a normal address event. The existing IPv6
# address, physical link and both default routes must survive rule recovery.
ip6tables -D INPUT "${ra[@]}"
iptables -t nat -D OUTPUT "${dns[@]}"
if ip6tables -C INPUT "${ra[@]}" 2>/dev/null; then exit 1; fi
if iptables -t nat -C OUTPUT "${dns[@]}" 2>/dev/null; then exit 1; fi
printf '360.00 0\n' > "$uptime_file"
ip address add 192.168.1.145/32 dev eth0
for attempt in {1..25}; do
  if ip6tables -C INPUT "${ra[@]}" 2>/dev/null &&
     iptables -t nat -C OUTPUT "${dns[@]}" 2>/dev/null &&
     [[ $(cat "$receipt_dir/verified") == "$boot 360" ]]; then break; fi
  sleep 0.2
done
ip6tables -C INPUT "${ra[@]}"
iptables -t nat -C OUTPUT "${dns[@]}"
[[ $(cat "$receipt_dir/late") == "$boot 299" ]]
[[ $(cat "$receipt_dir/verified") == "$boot 360" ]]
ip -6 addr show dev eth0 | grep -Fq fd70::1/64
ip -4 route show default | grep -Fq 'via 192.168.1.19 dev eth0'
ip -6 route show default | grep -Fq 'dev eth0'
[[ $(cat /proc/sys/net/ipv6/conf/eth0/disable_ipv6) == 0 ]]

# Exercise the kernel with a valid RA arriving on eth0 from its veth peer.
python3 - <<'PY'
import ipaddress, socket, struct, time
def address(text):
    return ipaddress.IPv6Address(text).packed
src, dst = address("fe80::ab"), address("ff02::1")
ra = struct.pack("!BBHBBHII", 134, 0, 0, 64, 0, 1800, 0, 0)
data = src + dst + struct.pack("!I3xB", len(ra), 58) + ra
total = sum(struct.unpack("!%dH" % (len(data)//2), data))
while total >> 16:
    total = (total & 0xffff) + (total >> 16)
ra = ra[:2] + struct.pack("!H", (~total) & 0xffff) + ra[4:]
with socket.socket(socket.AF_PACKET, socket.SOCK_RAW) as sock:
    sock.bind(("peer0", 0))
    header = bytes.fromhex("333300000001") + sock.getsockname()[4] + bytes.fromhex("86dd")
    sock.send(header + struct.pack("!IHBB", 6 << 28, len(ra), 58, 255) + src + dst + ra)
# Attempt an external and a link-local DNS flow. Both rules must record packets.
for host, port in [("2001:db8::ab", 443), ("fe80::ab", 53)]:
    with socket.socket(socket.AF_INET6, socket.SOCK_DGRAM) as s:
        try:
            s.sendto(b"probe", (host, port, 0, socket.if_nametoindex("eth0")))
        except OSError:
            pass
# A link-local unicast datagram and a multicast datagram must reach the peer.
with socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.htons(0x86DD)) as tap:
    tap.bind(("peer0", 0))
    tap.settimeout(2)
    allowed = ["fe80::ab", "ff02::1"]
    with socket.socket(socket.AF_INET6, socket.SOCK_DGRAM) as s:
        for host in allowed:
            s.sendto(b"x96-allowed", (host, 5353, 0, socket.if_nametoindex("eth0")))
    expected = {address(host) for host in allowed}
    deadline = time.monotonic() + 2
    while expected and time.monotonic() < deadline:
        frame = tap.recv(2048)
        if frame.endswith(b"x96-allowed"):
            expected.discard(frame[38:54])
    assert not expected, expected
PY
ip6tables -nvxL INPUT | awk '/type 134/ && $1>0 {ok=1} END {exit !ok}'
ip6tables -nvxL OUTPUT | awk '/::2-fe7f:/ && $1>0 {external=1}; /udp dpt:53/ && $1>0 {dns=1} END {exit !(external && dns)}'
[[ $(grep -Fc 'phase=late' /tmp/x96-readiness) -eq 1 ]]
kill "$watch_pid"
wait "$watch_pid"

# For each earlier checkpoint start one second before it. Keep the interface
# quiet and the transport unavailable until late readiness. Recovery must then
# come from the specified uptime checkpoint, even without a netlink event.
for checkpoint in 30 60 120 240; do
  rm -f "$receipt_dir/verified" "$receipt_dir/late" "$root/transport-available"
  printf '%d.00 0\n' "$((checkpoint - 1))" > "$uptime_file"
  bash "$script" --watch &
  watch_pid=$!
  for attempt in {1..25}; do
    [[ -f "$receipt_dir/late" ]] && break
    sleep .1
  done
  [[ -f "$receipt_dir/late" && ! -e "$receipt_dir/verified" ]]
  sleep .2
  touch "$root/transport-available"
  printf '%d.00 0\n' "$checkpoint" > "$uptime_file"
  for attempt in {1..30}; do
    [[ -f "$receipt_dir/verified" ]] && break
    sleep .15
  done
  [[ $(cat "$receipt_dir/verified") == "$boot $checkpoint" ]]
  kill "$watch_pid"
  wait "$watch_pid"
done
trap - EXIT
echo 'PASS: seven rules and packets, five uptime checkpoints, atomic receipts, netlink recovery'
