#!/usr/bin/env python3
"""从 xray config.json 转换生成 sing-box config.json (v1.13 格式)"""
import json

XRAY_CONFIG = "/Users/rayman.chen/xray/config.json"
OUTPUT = "/Users/rayman.chen/mycc/2-Projects/sing-box/config.json"
SB_DIR = "/Users/rayman.chen/mycc/2-Projects/sing-box"

with open(XRAY_CONFIG, "r") as f:
    xray = json.load(f)

def convert_outbound(o):
    tag = o["tag"]
    proto = o["protocol"]
    if proto == "freedom":
        return {"type": "direct", "tag": tag}
    if proto == "blackhole":
        return {"type": "block", "tag": tag}

    vnext = o["settings"]["vnext"][0]
    user = vnext["users"][0]
    stream = o.get("streamSettings", {})
    network = stream.get("network", "tcp")
    security = stream.get("security", "none")

    sb = {
        "tag": tag, "type": proto,
        "server": vnext["address"], "server_port": vnext["port"],
        "uuid": user["id"],
    }
    if proto == "vmess":
        sb["alter_id"] = user.get("alterId", 0)
        sb["security"] = user.get("security", "auto")
    elif proto == "vless":
        flow = user.get("flow", "")
        if flow:
            sb["flow"] = flow

    if network == "ws":
        ws = stream.get("wsSettings", {})
        sb["transport"] = {"type": "ws", "path": ws.get("path", "/")}
        if ws.get("headers"):
            sb["transport"]["headers"] = ws["headers"]

    if security == "tls":
        tls_s = stream.get("tlsSettings", {})
        sb["tls"] = {"enabled": True, "server_name": tls_s.get("serverName", vnext["address"])}
        fp = tls_s.get("fingerprint")
        if fp:
            sb["tls"]["utls"] = {"enabled": True, "fingerprint": fp}
    elif security == "reality":
        rs = stream.get("realitySettings", {})
        sb["tls"] = {
            "enabled": True,
            "server_name": rs.get("serverName", vnext["address"]),
            "reality": {"enabled": True, "public_key": rs.get("publicKey", ""), "short_id": rs.get("shortId", "")},
            "utls": {"enabled": True, "fingerprint": rs.get("fingerprint", "chrome")},
        }
    return sb

outbounds = [convert_outbound(o) for o in xray["outbounds"]]

# 从 xray balancers 提取分组
balancers = {b["tag"]: b for b in xray["routing"].get("balancers", [])}

media_sel = balancers.get("media-balancer", {}).get("selector", [])
google_sel = balancers.get("google-ai-balancer", {}).get("selector", [])

outbounds += [
    # urltest 自动选最低延迟，等效 leastPing/leastLoad
    {"type": "urltest", "tag": "media-balancer", "outbounds": media_sel,
     "url": "https://www.gstatic.com/generate_204", "interval": "5m", "tolerance": 100},
    {"type": "urltest", "tag": "google-ai-balancer", "outbounds": google_sel,
     "url": "https://www.gstatic.com/generate_204", "interval": "5m", "tolerance": 100},
]
all_proxy = [o["tag"] for o in outbounds if o["type"] not in ("direct", "block", "urltest")]
outbounds.append({"type": "selector", "tag": "proxy",
                   "outbounds": ["media-balancer"] + all_proxy, "default": "media-balancer"})

# 转换路由规则（从 xray routing.rules）
def extract_domains(xray_domains):
    """从 xray domain 列表提取 sing-box domain_suffix"""
    suffixes = []
    for d in xray_domains:
        if d.startswith("domain:"):
            suffixes.append(d[7:])
        elif d.startswith("geosite:"):
            pass  # 用 rule_set 处理
    return suffixes

route_rules = []
for r in xray["routing"]["rules"]:
    outbound_tag = r.get("outboundTag")
    balancer_tag = r.get("balancerTag")
    target = outbound_tag or balancer_tag
    if not target:
        continue

    domains = r.get("domain", [])
    ips = r.get("ip", [])
    port = r.get("port")
    network = r.get("network")

    # Block QUIC
    if target == "block" and port and network == "udp":
        route_rules.append({"protocol": "quic", "port": int(port), "action": "reject"})
        continue

    # 提取域名后缀
    suffixes = extract_domains(domains)
    has_geosite_cn = any(d == "geosite:cn" for d in domains)
    has_geoip_cn = any(ip in ("geoip:cn",) for ip in ips)
    has_private = any(ip == "geoip:private" for ip in ips)

    if suffixes:
        rule = {"domain_suffix": suffixes, "action": "route", "outbound": target}
        route_rules.append(rule)
    if has_geosite_cn:
        route_rules.append({"rule_set": "geosite-cn", "action": "route", "outbound": target})
    if has_geoip_cn:
        route_rules.append({"rule_set": "geoip-cn", "action": "route", "outbound": target})
    if has_private:
        route_rules.append({"ip_is_private": True, "action": "route", "outbound": target})

config = {
    "log": {"level": "info", "output": f"{SB_DIR}/sing-box.log", "timestamp": True},
    "dns": {
        "servers": [
            {"type": "tls", "tag": "google", "server": "8.8.8.8", "detour": "proxy"},
            {"type": "udp", "tag": "alidns", "server": "223.5.5.5"},
            {"type": "udp", "tag": "local-dns", "server": "223.5.5.5"},
        ],
        "rules": [
            {"domain_suffix": [".cn"], "server": "alidns"},
            {"rule_set": "geosite-cn", "server": "alidns"},
        ],
        "strategy": "prefer_ipv4",
    },
    "inbounds": [{
        "type": "mixed", "tag": "mixed-in", "listen": "127.0.0.1", "listen_port": 10809,
        "sniff": True, "sniff_override_destination": True,
    }],
    "outbounds": outbounds,
    "route": {
        "rules": route_rules,
        "rule_set": [
            {"type": "local", "tag": "geosite-cn", "format": "binary",
             "path": f"{SB_DIR}/geosite-cn.srs"},
            {"type": "local", "tag": "geoip-cn", "format": "binary",
             "path": f"{SB_DIR}/geoip-cn.srs"},
        ],
        "final": "proxy",
        "auto_detect_interface": True,
        "default_domain_resolver": "local-dns",
    },
    "experimental": {
        "clash_api": {
            "external_controller": "127.0.0.1:9090",
            "external_ui": "ui",
            "default_mode": "rule",
        },
    },
}

with open(OUTPUT, "w") as f:
    json.dump(config, f, indent=2, ensure_ascii=False)

print(f"✓ config.json 已生成: {OUTPUT}")
print(f"  出站节点: {len(outbounds)} 个")
print(f"  路由规则: {len(route_rules)} 条")
for r in route_rules:
    target = r.get("outbound", r.get("action", "?"))
    key = next((k for k in ("domain_suffix", "rule_set", "ip_is_private", "protocol") if k in r), "?")
    val = r.get(key, "")
    if isinstance(val, list):
        val = f"{val[0]}... ({len(val)}个)" if len(val) > 1 else val[0]
    print(f"    {key}={val} -> {target}")
