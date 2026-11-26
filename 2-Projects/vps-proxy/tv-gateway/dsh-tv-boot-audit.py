#!/usr/bin/env python3
"""Sample the existing ADB connection during the first minutes of each observed TV boot."""
import ipaddress
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import time

TV = "192.168.1.144:5555"
GATEWAY = "192.168.1.19"
LIVE = "192.168.1.211:4022"
STATE = Path("/var/lib/dsh-tv-boot-audit")
OFFSETS = (0, 25, 60, 120, 240)
FILES = {"central": "/sdcard/MiTV/\ufeff央视频道.txt", "beijing": "/sdcard/MiTV/本市频道.txt"}

# Filter on the TV; full process tables, playlist URLs and network dumps never enter the log.
STATUS = r"""
echo NET
dumpsys connectivity | grep -E 'Active default network:|NetworkAgentInfo\{.*type: Ethernet'
echo ROUTE
ip -4 route show table eth0
echo IPV6
cat /proc/sys/net/ipv6/conf/eth0/disable_ipv6
echo V6STATE
if addrs=$(ip -6 addr show dev eth0 scope global 2>/dev/null); then
    echo "global $(echo "$addrs" | grep -c 'inet6 ')"
fi
if routes=$(ip -6 route show table all 2>/dev/null); then
    echo "default $(echo "$routes" | awk '/^default / && / dev eth0( |$)/ {n++} END {print n+0}')"
fi
echo FIREWALL
if ip6tables -w 1 -S INPUT >/dev/null 2>&1 && ip6tables -w 1 -S OUTPUT >/dev/null 2>&1 && iptables -w 1 -t nat -S OUTPUT >/dev/null 2>&1; then
    check() { key=$1; shift; "$@" >/dev/null 2>&1; echo "$key $?"; }
    check ra ip6tables -w 1 -C INPUT -i eth0 -p ipv6-icmp --icmpv6-type router-advertisement -j DROP
    n=0
    for dest in ::2-fe7f:ffff:ffff:ffff:ffff:ffff:ffff:ffff fec0::-feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff; do
        check dst$n ip6tables -w 1 -C OUTPUT -o eth0 -m iprange --dst-range "$dest" -j REJECT --reject-with icmp6-no-route
        n=$((n+1))
    done
    for proto in tcp udp; do
        check v6$proto ip6tables -w 1 -C OUTPUT -o eth0 -p "$proto" --dport 53 -j REJECT --reject-with icmp6-port-unreachable
        check v4$proto iptables -w 1 -t nat -C OUTPUT -p "$proto" --dport 53 -j DNAT --to-destination 192.168.1.19:53
    done
fi
echo PROVISION
dumpsys network_stack | awk '/^IpClient\./ {eth=($1=="IpClient.eth0"); if(eth)print "eth0"; next}
  /^Other IpClient logs:/ {eth=0}
  eth && /INVOKE onProvisioning(Failure|Success)/ {print $1,($0~/INVOKE onProvisioningFailure/?"failure":"success")}'
echo WATCH
ps -A -o PID,ARGS | awk 'NR==1 && $1=="PID" && $2=="ARGS" {print "scanned";next}
  $1~/^[0-9]+$/ {for(i=2;i<=NF;i++) if($i==("/data/adb/dsh-gateway/" "watch.sh")) {print "matched";break}}'
echo UID
cmd package list packages --user 0 -U org.smarttube.beta
echo RULE
iptables -w 1 -S OUTPUT 2>/dev/null
echo PLAYBACK
foreground() {
    dumpsys activity activities | awk '/mResumedActivity:/ {
        if(index($0," org.smarttube.beta/")) print "smarttube";
        else if(index($0," com.player.diyp2020/")) print "diyp"; else print "other"; exit}'
}
frames() {
    awk '/device name/ {codec=$NF} /frame count/ {if(codec && $NF~/^[0-9]+$/) print codec, $NF}' /sys/class/vdec/vdec_status 2>/dev/null
}
app=$(foreground 2>/dev/null)
echo "start $app"
case "$app" in smarttube|diyp)
    frames; sleep 1; frames
    echo "end $(foreground 2>/dev/null)"
esac
echo BOOTFILES
for phase in early late transport verified; do
    if [ -r "/data/misc/x96-boot-status/$phase" ] && read -r id age extra < "/data/misc/x96-boot-status/$phase" && [ -z "$extra" ]; then
        echo "$phase $id $age"
    fi
done
cut -d. -f1 /proc/uptime | sed 's/^/read_time /'
echo RECEIPT
logcat -d -s SmartTubeTransport:I X96Network:I | grep 'ready boot=' | grep -E 'SmartTubeTransport|phase=(early|late)' | tail -30
"""

def adb(command, timeout=8):
    try:
        result = subprocess.run(["adb", "-s", TV, "shell", "-T", command],
                                capture_output=True, timeout=timeout)
        return result.stdout if result.returncode == 0 else b""
    except subprocess.TimeoutExpired:
        return b""


def boot():
    result = adb("cat /proc/sys/kernel/random/boot_id /proc/uptime").decode().split()
    if len(result) == 3 and re.fullmatch(r"[a-f0-9-]{36}", result[0]) and re.fullmatch(r"\d+\.\d+", result[1]):
        return result[0], int(float(result[1]))
    return None


def parse_status(data, boot_id):
    fields = re.split(r"^(NET|ROUTE|IPV6|V6STATE|FIREWALL|PROVISION|WATCH|UID|RULE|RECEIPT|BOOTFILES|PLAYBACK)\s*$", data, flags=re.M)
    pieces = dict(zip(fields[1::2], fields[2::2]))
    net = pieces.get("NET", "")
    active = re.search(r"Active default network:\s*(\d+)", net)
    net_id = active.group(1) if active else None
    ethernet = next((line for line in net.splitlines() if f"network{{{net_id}}}" in line), "")
    dns = re.search(r"DnsAddresses:\s*\[([^]]*)\]", ethernet)
    gateway = re.search(r"^default via (\S+)", pieces.get("ROUTE", ""), flags=re.M)
    watcher = pieces.get("WATCH", "").strip().splitlines()
    watch_count = watcher.count("matched") if "scanned" in watcher else None
    counts = dict(re.findall(r"^(global|default) (\d+)$", pieces.get("V6STATE", ""), re.M))
    firewall = dict(re.findall(r"^(ra|dst[01]|v[46](?:tcp|udp)) (\d+)$", pieces.get("FIREWALL", ""), re.M))
    events = pieces.get("PROVISION", "").splitlines()
    successes = [v.split()[0] for v in events if v.endswith(" success")]
    failures = [v.split()[0] for v in events if v.endswith(" failure")]
    observed = "eth0" in events and bool(successes or failures)
    uid = re.search(r"package:org\.smarttube\.beta uid:(\d+)\b", pieces.get("UID", ""))
    rule_data = pieces.get("RULE", "")
    rule = None
    receipt = False
    if uid:
        owner = uid.group(1)
        if re.search(r"^-P OUTPUT ", rule_data, re.M):
            rule = any(all(token in row for token in ("-p udp ", "--dport 443 ", f"--uid-owner {owner} ",
                       "--ctstate NEW ", "-j REJECT ", "--reject-with icmp-port-unreachable"))
                       for row in rule_data.splitlines() if row.startswith("-A OUTPUT "))
        receipt = bool(re.search(rf"SmartTubeTransport.*ready boot={boot_id} uid={owner}\b", pieces.get("RECEIPT", "")))
    file_data = pieces.get("BOOTFILES", "")
    read_time = re.search(r"^read_time (\d+)$", file_data, re.M)
    boot_files = {name: int(age) for name, age in re.findall(
        rf"^(early|late|transport|verified) {boot_id} (\d+)$", file_data, re.M)
        if read_time and int(age) <= int(read_time[1])}
    playback = pieces.get("PLAYBACK", "")
    start = re.search(r"^start (smarttube|diyp|other)$", playback, re.M)
    end = re.search(r"^end (smarttube|diyp)$", playback, re.M)
    frames = re.findall(r"^([A-Za-z0-9_-]+) (\d+)$", playback, re.M)
    frame_delta = None
    if start and end and start[1] == end[1] and len(frames) == 2 and frames[0][0] == frames[1][0]:
        delta = int(frames[1][1]) - int(frames[0][1])
        if delta >= 0:
            frame_delta = delta
    return {"boot_files": boot_files, "receipt_read_uptime": int(read_time[1]) if read_time else None,
            "foreground_app": start[1] if start else None, "decoder_frames_over_one_second": frame_delta,
            "net_id": net_id, "gateway": gateway.group(1) if gateway else None,
            "dns": [x.lstrip("/") for x in dns.group(1).split()] if dns else None,
            "ipv6_disabled": pieces.get("IPV6", "").strip() or None, "old_watchers": watch_count,
            "ipv6_global_addresses": int(counts["global"]) if "global" in counts else None,
            "ipv6_default_routes": int(counts["default"]) if "default" in counts else None,
            "firewall_checks": {name: int(code) for name, code in firewall.items()},
            "network_boot_phases": sorted(set(re.findall(rf"X96Network.*ready boot={boot_id} phase=(early|late)\b", pieces.get("RECEIPT", "")))),
            "provision_failures_observed": len(failures) if observed else None,
            "provision_last_failure": max(failures, default=None),
            "provision_first_success": min(successes, default=None),
            "provision_failures_after_success": sum(v > min(successes) for v in failures) if successes else None,
            "tcp_rule_present": rule, "tcp_rule_boot_receipt": receipt}


def has_ts(payload):
    # Ten consecutive MPEG-TS packets. The first packet may be partial.
    for start in range(min(188, len(payload))):
        run = 0
        for index in range(start, len(payload) - 187, 188):
            run = run + 1 if payload[index] == 0x47 else 0
            if run == 10:
                return True
    return False


def channel_probe(filename):
    first = adb("head -n 1 " + shlex.quote(filename)).decode("utf-8-sig", errors="replace")
    path = re.search(r",http://192\.168\.1\.211:4022(/udp/([\d.]+):(\d+))\s*$", first)
    try:
        if not path or not ipaddress.IPv4Address(path[2]).is_multicast or not 0 < int(path[3]) < 65536:
            return "missing_source"
    except ValueError:
        return "missing_source"
    request = f"GET {path[1]} HTTP/1.0\r\nHost: {LIVE}\r\nConnection: close\r\n\r\n"
    # Keep the half-duplex request pipe open for servers that close on client EOF.
    command = ("if [ -x /data/local/tmp/busybox ]; then nc='/data/local/tmp/busybox nc'; "
               "elif [ -x /data/adb/magisk/busybox ]; then nc='/data/adb/magisk/busybox nc'; "
               "else nc='toybox nc'; fi; { printf %s " + shlex.quote(request) +
               "; sleep 3; } | $nc -w 3 192.168.1.211 4022 | head -c 32768")
    response = adb(command, timeout=5)
    head, sep, body = response.partition(b"\r\n\r\n")
    if not sep:
        return "no_http_response"
    if not re.match(rb"HTTP/1\.[01] 200\b", head):
        return "http_error"
    return "ts_ok" if has_ts(body) else "no_ts"


def youtube_probe():
    # Read only a resolved address and HTTP status; never capture cookies or response headers.
    output = adb(r"""
ping -c 1 -W 1 www.youtube.com 2>/dev/null | head -1
for bb in /data/local/tmp/busybox /data/adb/magisk/busybox; do
    [ -x "$bb" ] || continue
    "$bb" wget -S -T 5 -t 1 -O /dev/null https://www.youtube.com/generate_204 2>&1 |
        grep -E '^[[:space:]]*HTTP/[0-9.]+ [0-9]{3}' | tail -1
    break
done
""", timeout=9).decode(errors="replace")
    address = re.search(r"^PING [^\n(]*\(([0-9.]+)\)", output, re.M)
    try:
        resolved = str(ipaddress.IPv4Address(address[1])) if address else None
    except ValueError:
        resolved = None
    http = re.search(r"^\s*HTTP/[0-9.]+ (\d{3})\b", output, re.M)
    return {"system_resolver_ipv4": resolved, "https_status_tls_identity_unverified": int(http[1]) if http else None}


def network_ok(sample):
    return (bool(sample["net_id"]) and sample["gateway"] == GATEWAY and bool(sample["dns"])
            and set(sample["dns"]) == {GATEWAY}
            and sample["ipv6_global_addresses"] == 0 and sample["ipv6_default_routes"] == 0
            and sample["old_watchers"] == 0)


def verdict(record):
    samples = record["samples"]
    if samples[-1]["uptime"] - record["first_uptime"] < OFFSETS[-1]:
        return "observing"
    if len(samples) < 3:
        return "insufficient_samples"
    last_two = samples[-2:]
    if not all(network_ok(s) for s in last_two):
        return "network_unready_or_unverified"
    if last_two[-1]["uptime"] - last_two[0]["uptime"] < 30:
        return "insufficient_stability_window"
    # Churn while Android is still bringing up Ethernet is recorded but judged separately.
    stable_ids = [s["net_id"] for s in samples if s["uptime"] >= 60 and s["net_id"]]
    if len(set(stable_ids)) > 1:
        return "default_network_changed_after_startup"
    final = samples[-1]
    if final["provision_failures_after_success"] is None:
        return "provisioning_history_unverified"
    if record["observation"] == "early_boot" and any((s["provision_failures_after_success"] or 0) >= 2 for s in samples):
        return "repeated_ethernet_provisioning_failure"
    baseline = next((s for s in samples if s["provision_failures_after_success"] is not None), final)
    if any(s["provision_last_failure"] and s["provision_last_failure"] != baseline["provision_last_failure"]
           and s["provision_failures_after_success"] for s in samples if s["uptime"] > baseline["uptime"]):
        return "ethernet_provisioning_failed_during_observation"
    # A direct negative has priority over a cached privileged observation.
    if any(final["firewall_checks"].values()):
        return "network_firewall_incomplete"
    if final["tcp_rule_present"] is False:
        return "tcp_rule_absent_or_unverified"
    reference_uptime = max(final["uptime"], final["receipt_read_uptime"] or 0)
    verified = max((s["boot_files"].get("verified", -1000000) for s in last_two), default=-1000000)
    fresh = 0 <= reference_uptime - verified <= 75
    if len(final["firewall_checks"]) != 7 and not fresh:
        return "network_firewall_live_state_unverified"
    if final["tcp_rule_present"] is not True and not fresh:
        return "tcp_rule_absent_or_unverified"
    if record["observation"] == "early_boot":
        hooks = set()
        for s in samples:
            hooks.update(s["network_boot_phases"])
            hooks.update(s["boot_files"])
            if s["tcp_rule_boot_receipt"]:
                hooks.add("transport")
        if not {"early", "late", "transport"}.issubset(hooks):
            return "boot_hook_timing_unverified"
    youtube = final.get("youtube_reachability", {})
    if not youtube.get("system_resolver_ipv4") or youtube.get("https_status_tls_identity_unverified") != 204:
        return "youtube_reachability_unverified"
    if not all(value == "ts_ok" for value in record["channels"].values()):
        return "live_sources_unverified"
    return "observed_checks_pass" if record["observation"] == "early_boot" else "late_join_checks_pass"


def main():
    identity = boot()
    if not identity:
        return
    boot_id, uptime = identity
    STATE.mkdir(mode=0o700, exist_ok=True)
    dest = STATE / (boot_id + ".json")
    record = json.loads(dest.read_text()) if dest.exists() else {}
    if record.get("schema") != 3:
        previous = record
        record = {"schema": 3, "boot_id": boot_id, "first_uptime": uptime, "observation": "early_boot" if uptime <= 60 else "late_join",
                  "channels": dict.fromkeys(FILES, "not_sampled"), "samples": [], "status": "observing"}
        if previous:
            record["prior_schema_samples"] = previous.get("samples", [])[:len(OFFSETS)]
    if record["status"] != "observing":
        return
    elapsed = uptime - record["first_uptime"]
    due = max(offset for offset in OFFSETS if offset <= elapsed)
    if record["samples"] and record["samples"][-1]["offset"] >= due:
        return
    sample = parse_status(adb(STATUS).decode(errors="replace"), boot_id)
    sample.update(offset=due, uptime=uptime, unix_time=int(time.time()))
    if due >= 60 and network_ok(sample):
        if due in (60, OFFSETS[-1]):
            sample["youtube_reachability"] = youtube_probe()
        for name, filename in FILES.items():
            if record["channels"][name] != "ts_ok":
                record["channels"][name] = channel_probe(filename)
    if not (current := boot()) or current[0] != boot_id:
        return
    record["samples"].append(sample)
    record["status"] = verdict(record)
    temp = dest.with_suffix(".tmp")
    temp.write_text(json.dumps(record, ensure_ascii=False, indent=2)+"\n")
    os.replace(temp, dest)
    for old in sorted(STATE.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)[12:]:
        old.unlink()


if __name__ == "__main__":
    main()
