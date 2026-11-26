#!/usr/bin/env python3
"""Offline acceptance for TV boot sampling. No ADB connection or device changes."""
import json
from pathlib import Path
import runpy
import subprocess
import tempfile
from unittest.mock import patch

audit = runpy.run_path(str(Path(__file__).with_name("dsh-tv-boot-audit.py")))["main"].__globals__
boot_id = "00000000-1111-2222-3333-444444444444"
status = f"""NET
Active default network: 110
  NetworkAgentInfo{{ ni{{[type: Ethernet[], state: CONNECTED/CONNECTED]}} network{{110}} lp{{DnsAddresses: [ /192.168.1.19 ]}} }}
ROUTE
default via 192.168.1.19 dev eth0 proto static
IPV6
0
V6STATE
global 0
default 0
FIREWALL
ra 0
dst0 0
dst1 0
v6tcp 0
v6udp 0
v4tcp 0
v4udp 0
PROVISION
eth0
2026-11-26T19:31:04.613 success
WATCH
scanned
UID
package:org.smarttube.beta uid:10087
RULE
-P OUTPUT ACCEPT
-A OUTPUT -p udp -m udp --dport 443 -m owner --uid-owner 10087 -m conntrack --ctstate NEW -j REJECT --reject-with icmp-port-unreachable
RECEIPT
SmartTubeTransport: ready boot={boot_id} uid=10087
X96Network: ready boot={boot_id} phase=early
X96Network: ready boot={boot_id} phase=late
""".encode()
packet = bytes([0x47]) + bytes(187)
assert audit["has_ts"](b"partial" + packet * 10)
assert not audit["has_ts"](b"partial" + packet * 9)
assert not audit["has_ts"](b"<html>error</html>" * 300)
assert not audit["has_ts"]((packet * 3 + bytes(188)) * 5)

watcher_filter = audit["STATUS"].split("ps -A -o PID,ARGS | awk '")[1].split("'")[0]
fake_ps = ("PID ARGS\n"
           "13 /data/adb/magisk/busybox sh /data/adb/dsh-gateway/watch.sh\n"
           "14 logcat /data/adb/dsh-gateway/watch.sh.disabled-20261125\n"
           "15 sh /data/adb/dsh-gateway/x96-network.sh --watch\n")
output = subprocess.run(["awk", watcher_filter], input=fake_ps, capture_output=True, text=True, check=True)
assert output.stdout.splitlines() == ["scanned", "matched"]
positive = audit["parse_status"](status.decode().replace("scanned", "scanned\nmatched"), boot_id)
assert positive["old_watchers"] == 1 and not audit["network_ok"](positive)
positive = audit["parse_status"](status.decode().replace("global 0", "global 1"), boot_id)
assert not audit["network_ok"](positive)
missing = audit["parse_status"](status.decode().replace("global 0", "").replace("default 0", ""), boot_id)
assert missing["ipv6_global_addresses"] is None and missing["ipv6_default_routes"] is None
assert not audit["network_ok"](missing)

with tempfile.TemporaryDirectory() as tmp, patch.dict(audit, STATE=Path(tmp)):
    current_uptime = 12
    payload = b""
    default_network = 110
    def shell(cmd, timeout=8):
        if "www.youtube.com/generate_204" in cmd:
            return b"PING www.youtube.com (142.251.33.78) 56 bytes of data.\n  HTTP/1.1 204 No Content\n"
        if cmd.startswith("head -n 1"):
            return b"sample,http://192.168.1.211:4022/udp/228.1.1.28:8008\n"
        if "head -c 32768" in cmd:
            return b"HTTP/1.0 200 OK\r\n\r\n"+packet*20
        return payload.replace(b"110", str(default_network).encode())

    dest = Path(tmp)/(boot_id+".json")
    with patch.dict(audit, boot=lambda: (boot_id, current_uptime), adb=shell):
        audit["main"]()
        first = json.loads(dest.read_text())
        assert first["status"] == "observing" and first["samples"][0]["old_watchers"] is None
        payload = status
        for current_uptime in (39, 72, 132, 252):
            audit["main"]()
        complete = json.loads(dest.read_text())
        assert complete["status"] == "observed_checks_pass" and len(complete["samples"]) == 5
        audit["main"]()
        assert json.loads(dest.read_text()) == complete
        assert set(complete["channels"].values()) == {"ts_ok"}
        final = complete["samples"][-1]
        assert final["tcp_rule_present"] and final["tcp_rule_boot_receipt"]
        assert final["ipv6_disabled"] == "0" and audit["network_ok"](final)
        final["provision_failures_after_success"] = 2
        assert audit["verdict"](complete) == "repeated_ethernet_provisioning_failure"
        final["provision_failures_after_success"] = 0
        final["firewall_checks"]["ra"] = 1
        assert audit["verdict"](complete) == "network_firewall_incomplete"
        del final["firewall_checks"]["ra"]
        assert audit["verdict"](complete) == "network_firewall_live_state_unverified"
        final["firewall_checks"]["ra"] = 0
        ensure_only = audit["parse_status"](status.decode().replace("phase=early", "phase=ensure"), boot_id)
        assert ensure_only["network_boot_phases"] == ["late"]
        final["network_boot_phases"] = []
        final["tcp_rule_boot_receipt"] = False
        assert audit["verdict"](complete) == "observed_checks_pass"
        for s in complete["samples"][:-1]:
            s["network_boot_phases"] = []
            s["tcp_rule_boot_receipt"] = False
        assert audit["verdict"](complete) == "boot_hook_timing_unverified"
        final["boot_files"] = {"early": 3, "late": 20, "transport": 20}
        assert audit["verdict"](complete) == "observed_checks_pass"
        final["net_id"] = "111"
        assert audit["verdict"](complete) == "default_network_changed_after_startup"
        final["net_id"] = "110"
        final["tcp_rule_present"] = None
        final["tcp_rule_boot_receipt"] = False
        assert audit["verdict"](complete) == "tcp_rule_absent_or_unverified"
        final["tcp_rule_boot_receipt"] = True
        assert audit["verdict"](complete) == "tcp_rule_absent_or_unverified"
        final["tcp_rule_present"] = False
        assert audit["verdict"](complete) == "tcp_rule_absent_or_unverified"
        final["boot_files"]["verified"] = 240
        assert audit["verdict"](complete) == "tcp_rule_absent_or_unverified"
        final["tcp_rule_present"] = None
        final["firewall_checks"] = {}
        assert audit["verdict"](complete) == "observed_checks_pass"
        final["boot_files"]["verified"] = 176
        assert audit["verdict"](complete) == "network_firewall_live_state_unverified"
        del final["boot_files"]["verified"]
        complete["samples"][-2]["uptime"] = 205
        complete["samples"][-2]["boot_files"]["verified"] = 200
        assert audit["verdict"](complete) == "observed_checks_pass"
        final["firewall_checks"]["ra"] = 1
        assert audit["verdict"](complete) == "network_firewall_incomplete"
        final["firewall_checks"] = {}
        final["youtube_reachability"]["https_status_tls_identity_unverified"] = 200
        assert audit["verdict"](complete) == "youtube_reachability_unverified"
        f = f"""BOOTFILES
early {boot_id} 2
verified 00000000-0000-0000-0000-000000000001 100
transport {boot_id} 101
read_time 100
PLAYBACK
start diyp
vdec 150
vdec 180
end diyp
"""
        parsed = audit["parse_status"](f, boot_id)
        assert parsed["boot_files"] == {"early": 2} and parsed["decoder_frames_over_one_second"] == 30
        parsed = audit["parse_status"](f.replace("end diyp", "end smarttube"), boot_id)
        assert parsed["decoder_frames_over_one_second"] is None
        dest.unlink()
        for current_uptime in (900, 930, 980, 1040, 1150):
            audit["main"]()
        assert json.loads(dest.read_text())["status"] == "late_join_checks_pass"

print("Boot audit offline checks passed")
