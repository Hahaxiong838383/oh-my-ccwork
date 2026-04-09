#!/usr/bin/env python3
"""
Xray Manager - 跨平台 Xray 分流代理管理工具
零依赖单文件 Web UI，仅使用 Python 标准库
支持 macOS / Windows / Linux
"""

import base64
import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

# ==================== 平台检测 ====================

import platform as _platform
IS_WINDOWS = _platform.system() == "Windows"
IS_MACOS = _platform.system() == "Darwin"
IS_LINUX = _platform.system() == "Linux"

# ==================== 配置 ====================

XRAY_HOME = Path.home() / "xray"
CONFIG_PATH = XRAY_HOME / "config.json"
LOG_PATH = XRAY_HOME / "xray.log"
XRAY_BIN = XRAY_HOME / ("xray.exe" if IS_WINDOWS else "xray")
WEB_PORT = 8888
LAUNCHD_LABEL = "com.xray.proxy"
WIN_TASK_NAME = "XrayProxy"
SYSTEMD_SERVICE = "xray-proxy"

# ==================== 工具函数 ====================

def load_config():
    """加载 xray 配置"""
    if not CONFIG_PATH.exists():
        return None
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)

def save_config(config):
    """保存 xray 配置"""
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    # 备份
    if CONFIG_PATH.exists():
        backup = CONFIG_PATH.with_suffix(".json.bak")
        with open(CONFIG_PATH, "r") as src, open(backup, "w") as dst:
            dst.write(src.read())
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2, ensure_ascii=False)

def get_xray_status():
    """获取 xray 运行状态"""
    try:
        if IS_WINDOWS:
            result = subprocess.run(
                ["tasklist", "/FI", "IMAGENAME eq xray.exe", "/FO", "CSV", "/NH"],
                capture_output=True, text=True, timeout=5
            )
            lines = [l for l in result.stdout.strip().split("\n") if "xray.exe" in l]
            if lines:
                pid = int(lines[0].split(",")[1].strip('"'))
                return {"running": True, "pid": pid, "count": len(lines)}
        else:
            # 先尝试 pgrep，不可用则 fallback 到 ps aux | grep
            try:
                result = subprocess.run(
                    ["pgrep", "-f", "xray run"],
                    capture_output=True, text=True, timeout=5
                )
                pids = [p for p in result.stdout.strip().split("\n") if p]
            except FileNotFoundError:
                result = subprocess.run(
                    ["ps", "aux"], capture_output=True, text=True, timeout=5
                )
                pids = []
                for line in result.stdout.split("\n"):
                    if "xray run" in line and "grep" not in line:
                        parts = line.split()
                        if len(parts) > 1:
                            pids.append(parts[1])
            if pids:
                return {"running": True, "pid": int(pids[0]), "count": len(pids)}
    except Exception:
        pass
    return {"running": False, "pid": None, "count": 0}

def _kill_xray():
    """杀掉所有 xray 进程"""
    try:
        if IS_WINDOWS:
            subprocess.run(["taskkill", "/F", "/IM", "xray.exe"], capture_output=True, timeout=5)
        else:
            # 先尝试 killall，不可用则 fallback 到 pkill
            try:
                subprocess.run(["killall", "xray"], capture_output=True, timeout=5)
            except FileNotFoundError:
                subprocess.run(["pkill", "-f", "xray run"], capture_output=True, timeout=5)
        time.sleep(1)
    except Exception:
        pass

def _start_xray_process():
    """手动启动 xray 进程"""
    kwargs = {
        "stdout": open(LOG_PATH, "a"),
        "stderr": subprocess.STDOUT,
        "cwd": str(XRAY_HOME),
    }
    if IS_WINDOWS:
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW | subprocess.DETACHED_PROCESS
    else:
        kwargs["start_new_session"] = True
    subprocess.Popen([str(XRAY_BIN), "run", "-c", str(CONFIG_PATH)], **kwargs)

def restart_xray():
    """重启 xray 服务"""
    if IS_LINUX:
        try:
            subprocess.run(
                ["systemctl", "--user", "restart", SYSTEMD_SERVICE],
                capture_output=True, text=True, timeout=10
            )
            time.sleep(1)
            status = get_xray_status()
            if status["running"]:
                return {"success": True, "method": "systemd", "pid": status["pid"]}
        except Exception:
            pass
    elif IS_MACOS:
        uid = os.getuid()
        try:
            subprocess.run(
                ["launchctl", "kickstart", "-k", f"gui/{uid}/{LAUNCHD_LABEL}"],
                capture_output=True, text=True, timeout=10
            )
            time.sleep(1)
            status = get_xray_status()
            if status["running"]:
                return {"success": True, "method": "launchctl", "pid": status["pid"]}
        except Exception:
            pass

    # Windows: 先尝试 Task Scheduler
    if IS_WINDOWS:
        try:
            subprocess.run(["schtasks", "/End", "/TN", WIN_TASK_NAME], capture_output=True, timeout=5)
            time.sleep(1)
            subprocess.run(["schtasks", "/Run", "/TN", WIN_TASK_NAME], capture_output=True, timeout=5)
            time.sleep(2)
            status = get_xray_status()
            if status["running"]:
                return {"success": True, "method": "schtasks", "pid": status["pid"]}
        except Exception:
            pass

    # 回退：手动杀进程重启
    try:
        subprocess.run(["pkill", "-f", "xray run"], capture_output=True, timeout=5)
        time.sleep(1)
    except Exception:
        pass

    try:
        subprocess.Popen(
            [str(XRAY_BIN), "run", "-c", str(CONFIG_PATH)],
            stdout=open(LOG_PATH, "a"),
            stderr=subprocess.STDOUT,
            cwd=str(XRAY_HOME),
            start_new_session=True
        )
        time.sleep(2)
        status = get_xray_status()
        return {"success": status["running"], "method": "manual", "pid": status.get("pid")}
    except Exception as e:
        return {"success": False, "error": str(e)}

def stop_xray():
    """停止 xray"""
    try:
        if IS_LINUX:
            subprocess.run(["systemctl", "--user", "stop", SYSTEMD_SERVICE],
                           capture_output=True, timeout=5)
        elif IS_MACOS:
            subprocess.run(["pkill", "-f", "xray run"], capture_output=True, timeout=5)
        else:
            subprocess.run(["pkill", "-f", "xray run"], capture_output=True, timeout=5)
        return {"success": True}
    except Exception as e:
        return {"success": False, "error": str(e)}

def get_system_proxy():
    """获取系统代理状态（macOS only）"""
    if not IS_MACOS:
        return {"supported": False}
    try:
        # 找到活跃的网络接口
        result = subprocess.run(
            ["/usr/sbin/networksetup", "-listallnetworkservices"],
            capture_output=True, text=True, timeout=5
        )
        services = [l.strip() for l in result.stdout.splitlines()
                     if l.strip() and not l.startswith("An asterisk")]
        # 优先 Wi-Fi
        iface = "Wi-Fi" if "Wi-Fi" in services else (services[0] if services else None)
        if not iface:
            return {"supported": True, "enabled": False, "error": "未找到网络接口"}

        # 检查 SOCKS / HTTP / HTTPS 三个代理状态
        socks_enabled = http_enabled = https_enabled = False
        port = 0
        server = ""
        for cmd, label in [
            (["-getsocksfirewallproxy"], "socks"),
            (["-getwebproxy"], "http"),
            (["-getsecurewebproxy"], "https"),
        ]:
            r = subprocess.run(
                ["/usr/sbin/networksetup"] + cmd + [iface],
                capture_output=True, text=True, timeout=5
            )
            if "Enabled: Yes" in r.stdout:
                if label == "socks": socks_enabled = True
                elif label == "http": http_enabled = True
                else: https_enabled = True
            if label == "socks":
                for line in r.stdout.splitlines():
                    if line.startswith("Server:"):
                        server = line.split(":", 1)[1].strip()
                    elif line.startswith("Port:"):
                        port = int(line.split(":", 1)[1].strip())
        enabled = socks_enabled and http_enabled and https_enabled
        return {
            "supported": True, "enabled": enabled,
            "server": server, "port": port, "interface": iface,
            "detail": {"socks": socks_enabled, "http": http_enabled, "https": https_enabled},
        }
    except Exception as e:
        return {"supported": True, "enabled": False, "error": str(e)}

def set_system_proxy(enable, iface=None):
    """设置/关闭系统代理：SOCKS + HTTP + HTTPS（macOS only）"""
    if not IS_MACOS:
        return {"success": False, "error": "仅支持 macOS"}
    try:
        if not iface:
            iface = get_system_proxy().get("interface", "Wi-Fi")
        config = load_config()
        proxy_port = 10808
        if config:
            for ib in config.get("inbounds", []):
                if ib.get("protocol") in ("socks", "mixed"):
                    proxy_port = ib.get("port", 10808)
                    break
        port_str = str(proxy_port)
        if enable:
            # SOCKS 代理
            subprocess.run(
                ["/usr/sbin/networksetup", "-setsocksfirewallproxy", iface, "127.0.0.1", port_str],
                capture_output=True, timeout=5
            )
            subprocess.run(
                ["/usr/sbin/networksetup", "-setsocksfirewallproxystate", iface, "on"],
                capture_output=True, timeout=5
            )
            # HTTP 代理
            subprocess.run(
                ["/usr/sbin/networksetup", "-setwebproxy", iface, "127.0.0.1", port_str],
                capture_output=True, timeout=5
            )
            subprocess.run(
                ["/usr/sbin/networksetup", "-setwebproxystate", iface, "on"],
                capture_output=True, timeout=5
            )
            # HTTPS 代理
            subprocess.run(
                ["/usr/sbin/networksetup", "-setsecurewebproxy", iface, "127.0.0.1", port_str],
                capture_output=True, timeout=5
            )
            subprocess.run(
                ["/usr/sbin/networksetup", "-setsecurewebproxystate", iface, "on"],
                capture_output=True, timeout=5
            )
        else:
            subprocess.run(
                ["/usr/sbin/networksetup", "-setsocksfirewallproxystate", iface, "off"],
                capture_output=True, timeout=5
            )
            subprocess.run(
                ["/usr/sbin/networksetup", "-setwebproxystate", iface, "off"],
                capture_output=True, timeout=5
            )
            subprocess.run(
                ["/usr/sbin/networksetup", "-setsecurewebproxystate", iface, "off"],
                capture_output=True, timeout=5
            )
        return {"success": True}
    except Exception as e:
        return {"success": False, "error": str(e)}


def get_logs(lines=100):
    """获取最近日志"""
    if not LOG_PATH.exists():
        return ""
    try:
        result = subprocess.run(
            ["tail", f"-{lines}", str(LOG_PATH)],
            capture_output=True, text=True, timeout=5
        )
        return result.stdout
    except Exception:
        return ""

def test_node(address, port, timeout=5):
    """测试节点延迟"""
    start = time.time()
    try:
        sock = socket.create_connection((address, int(port)), timeout=timeout)
        sock.close()
        latency = int((time.time() - start) * 1000)
        return {"reachable": True, "latency": latency}
    except Exception as e:
        return {"reachable": False, "error": str(e)}

def parse_vless_url(url):
    """解析 vless:// 链接"""
    try:
        url = url.strip()
        if not url.startswith("vless://"):
            return None
        rest = url[8:]
        # uuid@address:port?params#remark
        uuid_part, rest = rest.split("@", 1)
        if "#" in rest:
            addr_params, remark = rest.rsplit("#", 1)
            remark = urllib.parse.unquote(remark)
        else:
            addr_params = rest
            remark = ""
        if "?" in addr_params:
            addr_port, params_str = addr_params.split("?", 1)
            params = dict(urllib.parse.parse_qsl(params_str))
        else:
            addr_port = addr_params
            params = {}
        address, port = addr_port.rsplit(":", 1)
        return {
            "uuid": uuid_part,
            "address": address,
            "port": int(port),
            "remark": remark,
            "security": params.get("security", "none"),
            "type": params.get("type", "tcp"),
            "flow": params.get("flow", ""),
            "sni": params.get("sni", ""),
            "fp": params.get("fp", ""),
            "pbk": params.get("pbk", ""),
            "sid": params.get("sid", ""),
            "spx": params.get("spx", ""),
        }
    except Exception:
        return None

def parse_vmess_url(url):
    """解析 vmess:// 链接（base64 编码的 JSON）"""
    try:
        url = url.strip()
        if not url.startswith("vmess://"):
            return None
        b64 = url[8:]
        # 补齐 base64 padding
        b64 += "=" * (4 - len(b64) % 4) if len(b64) % 4 else ""
        data = json.loads(base64.b64decode(b64).decode("utf-8"))
        tls_val = data.get("tls", "")
        return {
            "protocol": "vmess",
            "uuid": data.get("id", ""),
            "address": data.get("add", ""),
            "port": int(data.get("port", 443)),
            "remark": data.get("ps", ""),
            "alterId": int(data.get("aid", 0)),
            "network": data.get("net", "tcp"),
            "type": data.get("type", "none"),
            "host": data.get("host", ""),
            "path": data.get("path", ""),
            "security": "tls" if tls_val == "tls" else "none",
            "sni": data.get("sni", "") or data.get("host", ""),
            "fp": data.get("fp", ""),
            "pbk": "",
            "sid": "",
        }
    except Exception:
        return None

def parse_proxy_url(url):
    """解析代理链接（自动识别 vless:// 和 vmess://）"""
    url = url.strip()
    if url.startswith("vless://"):
        parsed = parse_vless_url(url)
        if parsed:
            parsed["protocol"] = "vless"
        return parsed
    elif url.startswith("vmess://"):
        return parse_vmess_url(url)
    return None

def extract_nodes(config):
    """从配置中提取节点信息"""
    nodes = []
    for ob in config.get("outbounds", []):
        protocol = ob.get("protocol", "")
        settings = ob.get("settings", {})
        stream = ob.get("streamSettings", {})
        if protocol == "vless" and "vnext" in settings:
            vnext = settings["vnext"][0]
            user = vnext.get("users", [{}])[0]
            reality = stream.get("realitySettings", {})
            tls_settings = stream.get("tlsSettings", {})
            nodes.append({
                "tag": ob.get("tag", ""),
                "protocol": "vless",
                "address": vnext.get("address", ""),
                "port": vnext.get("port", 443),
                "uuid": user.get("id", ""),
                "flow": user.get("flow", ""),
                "alterId": 0,
                "network": stream.get("network", "tcp"),
                "security": stream.get("security", "reality"),
                "sni": reality.get("serverName", tls_settings.get("serverName", "")),
                "fingerprint": reality.get("fingerprint", "chrome"),
                "publicKey": reality.get("publicKey", ""),
                "shortId": reality.get("shortId", ""),
                "host": stream.get("wsSettings", {}).get("headers", {}).get("Host", ""),
                "path": stream.get("wsSettings", {}).get("path", ""),
            })
        elif protocol == "vmess" and "vnext" in settings:
            vnext = settings["vnext"][0]
            user = vnext.get("users", [{}])[0]
            tls_settings = stream.get("tlsSettings", {})
            ws_settings = stream.get("wsSettings", {})
            nodes.append({
                "tag": ob.get("tag", ""),
                "protocol": "vmess",
                "address": vnext.get("address", ""),
                "port": vnext.get("port", 443),
                "uuid": user.get("id", ""),
                "flow": "",
                "alterId": user.get("alterId", 0),
                "network": stream.get("network", "tcp"),
                "security": stream.get("security", "none"),
                "sni": tls_settings.get("serverName", ""),
                "fingerprint": tls_settings.get("fingerprint", "chrome"),
                "publicKey": "",
                "shortId": "",
                "host": ws_settings.get("headers", {}).get("Host", ""),
                "path": ws_settings.get("path", ""),
            })
    return nodes

def extract_routes(config):
    """从配置中提取路由规则"""
    routes = []
    for rule in config.get("routing", {}).get("rules", []):
        tag = rule.get("outboundTag", "")
        btag = rule.get("balancerTag", "")
        if tag in ("api",):
            continue
        domains = rule.get("domain", [])
        ips = rule.get("ip", [])
        port = rule.get("port", "")
        network = rule.get("network", "")
        routes.append({
            "outboundTag": tag,
            "balancerTag": btag,
            "domains": domains,
            "ips": ips,
            "port": port,
            "network": network,
        })
    return routes

def extract_balancers(config):
    """从配置中提取均衡组信息"""
    balancers = config.get("routing", {}).get("balancers", [])
    observatory = config.get("observatory", {})
    rules = config.get("routing", {}).get("rules", [])
    result = []
    for b in balancers:
        tag = b.get("tag", "")
        selector = b.get("selector", [])
        strategy = b.get("strategy", {}).get("type", "leastPing")
        # 找到使用此 balancer 的路由规则中的域名
        domains = []
        ips = []
        for r in rules:
            if r.get("balancerTag") == tag:
                domains.extend(r.get("domain", []))
                ips.extend(r.get("ip", []))
        # 匹配 selector 到实际节点 tag
        node_tags = []
        for ob in config.get("outbounds", []):
            ob_tag = ob.get("tag", "")
            for sel in selector:
                if ob_tag.startswith(sel):
                    node_tags.append(ob_tag)
                    break
        result.append({
            "tag": tag,
            "selector": selector,
            "strategy": strategy,
            "nodeTags": node_tags,
            "domains": domains,
            "ips": ips,
            "probeURL": observatory.get("probeURL", "https://www.google.com/generate_204"),
            "probeInterval": observatory.get("probeInterval", "60s"),
        })
    return result

def save_balancer_to_config(config, balancer_data):
    """保存均衡组到配置（更新 observatory + balancers + routing rules）"""
    tag = balancer_data["tag"]
    node_tags = balancer_data.get("nodeTags", [])
    domains = balancer_data.get("domains", [])
    ips = balancer_data.get("ips", [])
    strategy = balancer_data.get("strategy", "leastPing")
    probe_url = balancer_data.get("probeURL", "https://www.google.com/generate_204")
    probe_interval = balancer_data.get("probeInterval", "60s")

    # 1. 更新 routing.balancers
    routing = config.setdefault("routing", {})
    balancers = routing.setdefault("balancers", [])
    # 用节点的完整 tag 作为 selector（精确匹配）
    new_balancer = {
        "tag": tag,
        "selector": node_tags,
        "strategy": {"type": strategy},
    }
    existing_idx = next((i for i, b in enumerate(balancers) if b.get("tag") == tag), None)
    if existing_idx is not None:
        balancers[existing_idx] = new_balancer
    else:
        balancers.append(new_balancer)

    # 2. 更新 observatory（合并所有 balancer 的 selector）
    all_selectors = []
    for b in balancers:
        all_selectors.extend(b.get("selector", []))
    if all_selectors:
        config["observatory"] = {
            "subjectSelector": list(set(all_selectors)),
            "probeInterval": probe_interval,
            "probeURL": probe_url,
        }

    # 3. 更新路由规则
    rules = routing.setdefault("rules", [])
    # 删除旧的 balancerTag 规则
    rules[:] = [r for r in rules if r.get("balancerTag") != tag]
    # 添加新规则（在 direct 规则之前）
    if domains or ips:
        new_rule = {"type": "field", "balancerTag": tag}
        if domains:
            new_rule["domain"] = domains
        if ips:
            new_rule["ip"] = ips
        # 插入到 direct/block 规则之前
        insert_idx = next(
            (i for i, r in enumerate(rules)
             if r.get("outboundTag") in ("direct",) and ("domain" not in r or "geoip:private" in r.get("ip", []))),
            len(rules)
        )
        rules.insert(insert_idx, new_rule)

    return config

def delete_balancer_from_config(config, tag):
    """从配置中删除均衡组"""
    routing = config.get("routing", {})
    # 删除 balancer
    balancers = routing.get("balancers", [])
    routing["balancers"] = [b for b in balancers if b.get("tag") != tag]
    # 删除路由规则
    rules = routing.get("rules", [])
    routing["rules"] = [r for r in rules if r.get("balancerTag") != tag]
    # 更新 observatory
    remaining_selectors = []
    for b in routing.get("balancers", []):
        remaining_selectors.extend(b.get("selector", []))
    if remaining_selectors:
        config["observatory"]["subjectSelector"] = list(set(remaining_selectors))
    elif "observatory" in config:
        del config["observatory"]
    return config

def build_outbound(node):
    """从节点信息构建 outbound 配置（支持 vless 和 vmess）"""
    protocol = node.get("protocol", "vless")
    network = node.get("network", "tcp")
    security = node.get("security", "none")

    # 构建 users
    if protocol == "vmess":
        users = [{
            "id": node["uuid"],
            "alterId": int(node.get("alterId", 0)),
            "email": "t@t.tt",
            "security": "auto",
        }]
    else:  # vless
        users = [{
            "id": node["uuid"],
            "email": "t@t.tt",
            "security": "auto",
            "encryption": "none",
            "flow": node.get("flow", "xtls-rprx-vision"),
        }]

    outbound = {
        "tag": node["tag"],
        "protocol": protocol,
        "settings": {
            "vnext": [{
                "address": node["address"],
                "port": int(node["port"]),
                "users": users,
            }]
        },
        "streamSettings": {
            "network": network,
            "security": security,
        },
        "mux": {"enabled": False, "concurrency": -1},
    }

    stream = outbound["streamSettings"]

    # WebSocket 设置
    if network == "ws":
        ws_settings = {}
        if node.get("path"):
            ws_settings["path"] = node["path"]
        headers = {}
        if node.get("host"):
            headers["Host"] = node["host"]
        if headers:
            ws_settings["headers"] = headers
        if ws_settings:
            stream["wsSettings"] = ws_settings

    # gRPC 设置
    if network == "grpc" and node.get("path"):
        stream["grpcSettings"] = {"serviceName": node["path"]}

    # TLS 设置
    if security == "tls":
        tls_settings = {}
        if node.get("sni"):
            tls_settings["serverName"] = node["sni"]
        if node.get("fingerprint"):
            tls_settings["fingerprint"] = node["fingerprint"]
        stream["tlsSettings"] = tls_settings

    # Reality 设置
    if security == "reality":
        stream["realitySettings"] = {
            "serverName": node.get("sni", "www.microsoft.com"),
            "fingerprint": node.get("fingerprint", "chrome"),
            "show": False,
            "publicKey": node.get("publicKey", ""),
            "shortId": node.get("shortId", ""),
            "spiderX": "",
        }

    return outbound

# ==================== HTML 模板 ====================

HTML_PAGE = r"""<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Xray Manager</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0d1117; color: #c9d1d9; min-height: 100vh; }
.header { background: #161b22; border-bottom: 1px solid #30363d; padding: 16px 24px; display: flex; align-items: center; justify-content: space-between; }
.header h1 { font-size: 20px; color: #58a6ff; }
.status { display: flex; align-items: center; gap: 8px; }
.dot { width: 10px; height: 10px; border-radius: 50%; }
.dot.on { background: #3fb950; box-shadow: 0 0 8px #3fb950; }
.dot.off { background: #f85149; box-shadow: 0 0 8px #f85149; }
.btn { padding: 6px 16px; border-radius: 6px; border: 1px solid #30363d; background: #21262d; color: #c9d1d9; cursor: pointer; font-size: 13px; transition: all .15s; text-align: center; display: inline-flex; align-items: center; justify-content: center; }
.btn:hover { background: #30363d; border-color: #8b949e; }
.btn.primary { background: #238636; border-color: #238636; color: #fff; }
.btn.primary:hover { background: #2ea043; }
.btn.danger { background: #da3633; border-color: #da3633; color: #fff; }
.btn.danger:hover { background: #f85149; }
.btn.small { padding: 3px 10px; font-size: 12px; }
.container { max-width: 960px; margin: 0 auto; padding: 24px; }
.card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; margin-bottom: 16px; }
.card-header { padding: 12px 16px; border-bottom: 1px solid #30363d; display: flex; align-items: center; justify-content: space-between; }
.card-header h2 { font-size: 15px; color: #58a6ff; }
.card-body { padding: 16px; }
.node-item { display: flex; align-items: center; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #21262d; }
.node-item:last-child { border-bottom: none; }
.node-info { flex: 1; }
.node-tag { font-weight: 600; color: #f0883e; margin-right: 12px; }
.node-addr { color: #8b949e; font-family: monospace; font-size: 13px; }
.node-actions { display: flex; gap: 6px; }
.latency { font-size: 12px; padding: 2px 8px; border-radius: 10px; margin-left: 8px; }
.latency.good { background: #238636; color: #fff; }
.latency.slow { background: #d29922; color: #000; }
.latency.fail { background: #da3633; color: #fff; }
.route-item { padding: 8px 0; border-bottom: 1px solid #21262d; font-size: 13px; }
.route-item:last-child { border-bottom: none; }
.route-tag { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; margin-right: 8px; }
.route-tag.proxy-google { background: #1f6feb33; color: #58a6ff; }
.route-tag.proxy-claude-gpt { background: #8957e533; color: #bc8cff; }
.route-tag.direct { background: #23863633; color: #3fb950; }
.route-tag.block { background: #da363333; color: #f85149; }
.route-domains { color: #8b949e; font-family: monospace; font-size: 12px; word-break: break-all; }
.modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); display: none; align-items: center; justify-content: center; z-index: 100; }
.modal-overlay.show { display: flex; }
.modal { background: #161b22; border: 1px solid #30363d; border-radius: 12px; width: 90%; max-width: 560px; max-height: 90vh; overflow-y: auto; }
.modal-header { padding: 16px; border-bottom: 1px solid #30363d; display: flex; align-items: center; justify-content: space-between; }
.modal-header h3 { color: #f0883e; }
.modal-body { padding: 16px; }
.modal-footer { padding: 16px; border-top: 1px solid #30363d; display: flex; justify-content: flex-end; gap: 8px; }
.form-group { margin-bottom: 12px; }
.form-group label { display: block; font-size: 13px; color: #8b949e; margin-bottom: 4px; }
.form-group input, .form-group select, .form-group textarea { width: 100%; padding: 8px 12px; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; color: #c9d1d9; font-size: 14px; font-family: monospace; }
.form-group input:focus, .form-group textarea:focus { border-color: #58a6ff; outline: none; }
.form-group textarea { min-height: 80px; resize: vertical; }
.form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.toast { position: fixed; top: 20px; right: 20px; padding: 12px 20px; border-radius: 8px; color: #fff; font-size: 14px; z-index: 200; opacity: 0; transition: opacity .3s; }
.toast.show { opacity: 1; }
.toast.success { background: #238636; }
.toast.error { background: #da3633; }
.log-area { background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 12px; font-family: monospace; font-size: 12px; color: #8b949e; max-height: 300px; overflow-y: auto; white-space: pre-wrap; word-break: break-all; }
.import-area { width: 100%; padding: 12px; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; color: #c9d1d9; font-family: monospace; font-size: 13px; min-height: 60px; resize: vertical; }
.tabs { display: flex; gap: 4px; margin-bottom: 16px; }
.tab { padding: 8px 16px; border-radius: 6px 6px 0 0; border: 1px solid transparent; cursor: pointer; font-size: 14px; color: #8b949e; }
.tab.active { background: #161b22; border-color: #30363d; border-bottom-color: #161b22; color: #c9d1d9; }
.tab-content { display: none; }
.tab-content.active { display: block; }
</style>
</head>
<body>

<div class="header">
  <h1>Xray Manager</h1>
  <div class="status">
    <div class="dot" id="statusDot"></div>
    <span id="statusText">checking...</span>
    <button class="btn small" onclick="checkStatus()">刷新</button>
    <button class="btn small primary" onclick="restartXray()">重启</button>
    <button class="btn small danger" onclick="stopXray()">停止</button>
  </div>
</div>

<div class="container">
  <!-- 系统代理控制 -->
  <div class="card" style="margin-bottom:16px;">
    <div style="padding:12px 16px;display:flex;align-items:center;justify-content:space-between;">
      <div style="display:flex;align-items:center;gap:10px;">
        <div class="dot" id="proxyDot"></div>
        <span style="font-size:14px;font-weight:600;color:#c9d1d9;">系统代理</span>
        <span id="proxyText" style="font-size:13px;color:#8b949e;">检测中...</span>
      </div>
      <button class="btn small primary" id="proxyBtn" onclick="toggleSysProxy()" style="min-width:56px;">开启</button>
    </div>
  </div>

  <!-- 端口信息栏 -->
  <div id="portInfo" style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px;"></div>

  <div class="tabs">
    <div class="tab active" onclick="switchTab('nodes')">节点管理</div>
    <div class="tab" onclick="switchTab('routes')">路由规则</div>
    <div class="tab" onclick="switchTab('balancers')">均衡组</div>
    <div class="tab" onclick="switchTab('logs')">日志</div>
  </div>

  <!-- 节点管理 -->
  <div class="tab-content active" id="tab-nodes">
    <div class="card">
      <div class="card-header">
        <h2>代理节点</h2>
        <div style="display:flex;gap:6px;">
          <button class="btn small" onclick="showSubModal()">订阅导入</button>
          <button class="btn small" onclick="showImportModal()">粘贴链接导入</button>
          <button class="btn small primary" onclick="showNodeModal()">+ 添加节点</button>
        </div>
      </div>
      <div class="card-body" id="nodeList">加载中...</div>
    </div>
  </div>

  <!-- 路由规则 -->
  <div class="tab-content" id="tab-routes">
    <div class="card">
      <div class="card-header">
        <h2>路由规则</h2>
        <button class="btn small primary" onclick="showRouteModal()">编辑规则</button>
      </div>
      <div class="card-body" id="routeList">加载中...</div>
    </div>
  </div>

  <!-- 均衡组 -->
  <div class="tab-content" id="tab-balancers">
    <div class="card">
      <div class="card-header">
        <h2>均衡组（自动选最快节点）</h2>
        <button class="btn small primary" onclick="showBalancerModal()">+ 创建均衡组</button>
      </div>
      <div class="card-body" id="balancerList">加载中...</div>
    </div>
  </div>

  <!-- 日志 -->
  <div class="tab-content" id="tab-logs">
    <div class="card">
      <div class="card-header">
        <h2>Xray 日志</h2>
        <button class="btn small" onclick="loadLogs()">刷新</button>
      </div>
      <div class="card-body">
        <div class="log-area" id="logArea">加载中...</div>
      </div>
    </div>
  </div>
</div>

<!-- 节点编辑弹窗 -->
<div class="modal-overlay" id="nodeModal">
  <div class="modal">
    <div class="modal-header">
      <h3 id="nodeModalTitle">添加节点</h3>
      <button class="btn small" onclick="closeModal('nodeModal')">&times;</button>
    </div>
    <div class="modal-body">
      <div class="form-row">
        <div class="form-group">
          <label>协议</label>
          <select id="nodeProtocol" onchange="toggleProtocolFields()">
            <option value="vless">VLESS</option>
            <option value="vmess">VMess</option>
          </select>
        </div>
        <div class="form-group">
          <label>节点标签 (tag)</label>
          <input id="nodeTag" placeholder="如: proxy-google">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>地址</label>
          <input id="nodeAddr" placeholder="域名或 IP">
        </div>
        <div class="form-group">
          <label>端口</label>
          <input id="nodePort" type="number" value="443">
        </div>
      </div>
      <div class="form-group">
        <label>UUID</label>
        <input id="nodeUUID" placeholder="粘贴 UUID">
      </div>
      <div class="form-row">
        <div class="form-group vmess-field" style="display:none;">
          <label>AlterID</label>
          <input id="nodeAlterID" type="number" value="0">
        </div>
        <div class="form-group vless-field">
          <label>Flow</label>
          <select id="nodeFlow">
            <option value="xtls-rprx-vision">xtls-rprx-vision</option>
            <option value="">无</option>
          </select>
        </div>
        <div class="form-group">
          <label>传输协议</label>
          <select id="nodeNetwork" onchange="toggleNetworkFields()">
            <option value="tcp">TCP</option>
            <option value="ws">WebSocket</option>
            <option value="grpc">gRPC</option>
          </select>
        </div>
      </div>
      <div class="form-row ws-field" style="display:none;">
        <div class="form-group">
          <label>WebSocket Path</label>
          <input id="nodePath" placeholder="/ray">
        </div>
        <div class="form-group">
          <label>WebSocket Host</label>
          <input id="nodeHost" placeholder="(可空)">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>安全</label>
          <select id="nodeSecurity" onchange="toggleSecurityFields()">
            <option value="reality">Reality</option>
            <option value="tls">TLS</option>
            <option value="none">无</option>
          </select>
        </div>
        <div class="form-group">
          <label>SNI</label>
          <input id="nodeSNI" placeholder="www.microsoft.com">
        </div>
      </div>
      <div class="form-row reality-field">
        <div class="form-group">
          <label>Public Key</label>
          <input id="nodePBK" placeholder="Reality Public Key">
        </div>
        <div class="form-group">
          <label>Short ID</label>
          <input id="nodeSID" placeholder="Short ID (可空)">
        </div>
      </div>
      <div class="form-group">
        <label>Fingerprint</label>
        <select id="nodeFP">
          <option value="chrome">Chrome</option>
          <option value="firefox">Firefox</option>
          <option value="safari">Safari</option>
          <option value="random">Random</option>
        </select>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal('nodeModal')">取消</button>
      <button class="btn primary" onclick="saveNode()">保存</button>
    </div>
  </div>
</div>

<!-- VLESS 链接导入弹窗 -->
<div class="modal-overlay" id="importModal">
  <div class="modal">
    <div class="modal-header">
      <h3>导入 VLESS 链接</h3>
      <button class="btn small" onclick="closeModal('importModal')">&times;</button>
    </div>
    <div class="modal-body">
      <div class="form-group">
        <label>粘贴代理链接（支持 vless:// 和 vmess://，多行批量导入）</label>
        <textarea class="import-area" id="vlessInput" placeholder="vless://uuid@address:port?params#remark&#10;vmess://base64..."></textarea>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal('importModal')">取消</button>
      <button class="btn primary" onclick="importVless()">导入</button>
    </div>
  </div>
</div>

<!-- 路由编辑弹窗 -->
<div class="modal-overlay" id="routeModal">
  <div class="modal">
    <div class="modal-header">
      <h3>编辑路由规则</h3>
      <button class="btn small" onclick="closeModal('routeModal')">&times;</button>
    </div>
    <div class="modal-body">
      <div class="form-group">
        <label>选择出站节点</label>
        <select id="routeOutbound"></select>
      </div>
      <div class="form-group">
        <label>域名规则（每行一个）</label>
        <textarea class="import-area" id="routeDomains" placeholder="domain:google.com&#10;full:claude.ai&#10;domain:openai.com"></textarea>
      </div>
      <div class="form-group">
        <label>IP 规则（每行一个，可选）</label>
        <textarea class="import-area" id="routeIPs" placeholder="geoip:cn&#10;91.108.4.0/22" style="min-height:50px;"></textarea>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal('routeModal')">取消</button>
      <button class="btn primary" onclick="saveRoute()">保存</button>
    </div>
  </div>
</div>

<!-- 均衡组编辑弹窗 -->
<div class="modal-overlay" id="balancerModal">
  <div class="modal">
    <div class="modal-header">
      <h3 id="balancerModalTitle">创建均衡组</h3>
      <button class="btn small" onclick="closeModal('balancerModal')">&times;</button>
    </div>
    <div class="modal-body">
      <div class="form-row">
        <div class="form-group">
          <label>均衡组名称</label>
          <input id="balancerTag" placeholder="如: youtube-group">
        </div>
        <div class="form-group">
          <label>策略</label>
          <select id="balancerStrategy">
            <option value="leastPing">最低延迟 (leastPing)</option>
            <option value="leastLoad">最低负载 (leastLoad)</option>
            <option value="random">随机 (random)</option>
          </select>
        </div>
      </div>
      <div class="form-group">
        <label>选择节点（勾选加入均衡组）</label>
        <div id="balancerNodeList" style="max-height:200px;overflow-y:auto;background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:8px;"></div>
      </div>
      <div class="form-group">
        <label>适用域名（每行一个，如 domain:youtube.com）</label>
        <textarea class="import-area" id="balancerDomains" placeholder="domain:youtube.com&#10;domain:youtu.be&#10;domain:ytimg.com"></textarea>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>测速 URL</label>
          <input id="balancerProbeURL" value="https://www.google.com/generate_204">
        </div>
        <div class="form-group">
          <label>测速间隔</label>
          <select id="balancerProbeInterval">
            <option value="30s">30 秒</option>
            <option value="60s" selected>60 秒</option>
            <option value="120s">2 分钟</option>
            <option value="300s">5 分钟</option>
          </select>
        </div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal('balancerModal')">取消</button>
      <button class="btn primary" onclick="saveBalancer()">保存并重启</button>
    </div>
  </div>
</div>

<!-- 订阅导入弹窗 -->
<div class="modal-overlay" id="subModal">
  <div class="modal">
    <div class="modal-header">
      <h3>订阅导入</h3>
      <button class="btn small" onclick="closeModal('subModal')">&times;</button>
    </div>
    <div class="modal-body">
      <div class="form-group">
        <label>订阅地址</label>
        <input id="subUrl" placeholder="https://example.com/subscribe?token=xxx" style="width:100%;padding:8px 12px;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-size:14px;font-family:monospace;">
      </div>
      <div id="subPreview" style="margin-top:12px;display:none;">
        <div style="color:#8b949e;font-size:13px;margin-bottom:6px;">解析到 <span id="subCount" style="color:#3fb950;font-weight:600;"></span> 个节点：</div>
        <div id="subList" class="log-area" style="max-height:200px;"></div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal('subModal')">取消</button>
      <button class="btn" onclick="fetchSub()" id="subFetchBtn">解析</button>
      <button class="btn primary" onclick="importSub()" id="subImportBtn" style="display:none;">全部导入</button>
    </div>
  </div>
</div>

<!-- 端口编辑弹窗 -->
<div class="modal-overlay" id="portModal">
  <div class="modal">
    <div class="modal-header">
      <h3>编辑代理端口</h3>
      <button class="btn small" onclick="closeModal('portModal')">&times;</button>
    </div>
    <div class="modal-body">
      <div id="portEditList"></div>
      <div style="margin-top:12px;padding:8px;background:#0d1117;border:1px solid #30363d;border-radius:6px;font-size:12px;color:#8b949e;">
        <b style="color:#d29922;">提示：</b>修改端口后需要重启 Xray 生效。如果修改了 HTTP 代理端口，记得同步更新环境变量 http_proxy/https_proxy。
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="closeModal('portModal')">取消</button>
      <button class="btn primary" onclick="savePorts()">保存并重启</button>
    </div>
  </div>
</div>

<!-- Toast -->
<div class="toast" id="toast"></div>

<script>
let currentConfig = null;
let editingNodeTag = null;
let editingRouteIdx = null;

// ========== API ==========
async function api(path, method='GET', body=null) {
  const opts = { method };
  if (body) {
    opts.headers = {'Content-Type': 'application/json'};
    opts.body = JSON.stringify(body);
  }
  const res = await fetch('/api' + path, opts);
  return res.json();
}

// ========== 状态 ==========
async function checkStatus() {
  const data = await api('/status');
  const dot = document.getElementById('statusDot');
  const text = document.getElementById('statusText');
  if (data.running) {
    dot.className = 'dot on';
    text.textContent = `运行中 (PID: ${data.pid})`;
  } else {
    dot.className = 'dot off';
    text.textContent = '已停止';
  }
}

async function checkSysProxy() {
  const data = await api('/sysproxy');
  const dot = document.getElementById('proxyDot');
  const text = document.getElementById('proxyText');
  const btn = document.getElementById('proxyBtn');
  if (!data.supported) {
    text.textContent = '系统代理(不支持)';
    btn.style.display = 'none';
    return;
  }
  if (data.enabled) {
    dot.className = 'dot on';
    text.textContent = `已启用 → ${data.server}:${data.port}`;
    btn.textContent = '关闭';
    btn.className = 'btn small danger';
  } else {
    dot.className = 'dot off';
    text.textContent = '未启用';
    btn.textContent = '开启';
    btn.className = 'btn small primary';
  }
}

async function toggleSysProxy() {
  const data = await api('/sysproxy');
  const enable = !data.enabled;
  showToast(enable ? '正在开启系统代理...' : '正在关闭系统代理...', 'success');
  const res = await api('/sysproxy', 'POST', { enable });
  if (res.success) {
    showToast(enable ? '系统代理已开启' : '系统代理已关闭', 'success');
  } else {
    showToast('操作失败: ' + (res.error || ''), 'error');
  }
  checkSysProxy();
}

async function restartXray() {
  showToast('正在重启...', 'success');
  const data = await api('/restart', 'POST');
  if (data.success) {
    showToast('重启成功', 'success');
  } else {
    showToast('重启失败: ' + (data.error || ''), 'error');
  }
  checkStatus();
}

async function stopXray() {
  const data = await api('/stop', 'POST');
  if (data.success) showToast('已停止', 'success');
  checkStatus();
}

// ========== 脱敏 ==========
function maskAddr(addr) {
  if (!addr) return '';
  // IP: 1.2.3.4 -> 1.2.*.*
  if (/^\d+\.\d+\.\d+\.\d+$/.test(addr)) {
    const p = addr.split('.');
    return p[0] + '.' + p[1] + '.*.*';
  }
  // 域名: abc.example.com -> ab***e.com
  const parts = addr.split('.');
  if (parts.length >= 2) {
    const host = parts.slice(0, -1).join('.');
    const tld = parts.slice(-1)[0];
    const sld = parts.length >= 3 ? '.' + parts[parts.length - 2] : '';
    if (host.length <= 3) return host[0] + '***' + sld + '.' + tld;
    return host.slice(0, 2) + '***' + host.slice(-1) + sld + '.' + tld;
  }
  return addr.slice(0, 2) + '***';
}

function maskUUID(uuid) {
  if (!uuid || uuid.length < 8) return '****';
  return uuid.slice(0, 4) + '****' + uuid.slice(-4);
}

// ========== 端口信息 ==========
function renderPorts(inbounds) {
  const el = document.getElementById('portInfo');
  if (!inbounds || inbounds.length === 0) { el.innerHTML = ''; return; }
  const colors = { socks: '#3fb950', http: '#58a6ff', mixed: '#d29922' };
  const labels = { socks: 'SOCKS5', http: 'HTTP', mixed: 'SOCKS5/HTTP' };
  el.innerHTML = inbounds.map(ib => {
    const proto = ib.protocol || 'unknown';
    const color = colors[proto] || '#8b949e';
    const label = labels[proto] || proto.toUpperCase();
    return `<div style="display:flex;align-items:center;gap:6px;padding:6px 12px;background:#161b22;border:1px solid #30363d;border-radius:6px;font-size:13px;">
      <span style="color:${color};font-weight:600;">${label}</span>
      <span style="color:#c9d1d9;font-family:monospace;">${ib.listen}:${ib.port}</span>
      <span style="color:#484f58;font-size:11px;">${ib.tag}</span>
    </div>`;
  }).join('') + `<div style="display:flex;align-items:center;gap:6px;padding:6px 12px;background:#161b22;border:1px solid #30363d;border-radius:6px;font-size:13px;">
    <span style="color:#bc8cff;font-weight:600;">Web UI</span>
    <span style="color:#c9d1d9;font-family:monospace;">127.0.0.1:${location.port || 8888}</span>
  </div>` + `<button class="btn small" onclick="showPortModal()" style="padding:6px 10px;">编辑端口</button>`;
}

function showPortModal() {
  const inbounds = (currentConfig && currentConfig.inbounds) || [];
  const labels = { socks: 'SOCKS5', http: 'HTTP', mixed: 'SOCKS5/HTTP' };
  document.getElementById('portEditList').innerHTML = inbounds.map((ib, i) => {
    const label = labels[ib.protocol] || ib.protocol.toUpperCase();
    return `<div class="form-row" style="margin-bottom:8px;align-items:center;">
      <div class="form-group" style="margin-bottom:0;">
        <label>${label} (${ib.tag})</label>
        <div style="display:flex;gap:8px;">
          <input id="portListen${i}" value="${ib.listen}" style="width:40%;padding:6px 8px;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-family:monospace;font-size:13px;" placeholder="监听地址">
          <input id="portNum${i}" type="number" value="${ib.port}" min="1" max="65535" style="width:30%;padding:6px 8px;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;font-family:monospace;font-size:13px;" placeholder="端口">
        </div>
      </div>
    </div>`;
  }).join('');
  document.getElementById('portModal').classList.add('show');
}

async function savePorts() {
  const inbounds = (currentConfig && currentConfig.inbounds) || [];
  const updated = inbounds.map((ib, i) => ({
    tag: ib.tag,
    protocol: ib.protocol,
    listen: document.getElementById('portListen' + i).value.trim() || '127.0.0.1',
    port: parseInt(document.getElementById('portNum' + i).value) || ib.port,
  }));
  // 前端校验
  const ports = updated.map(u => u.port);
  if (ports.some(p => p < 1 || p > 65535)) { showToast('端口范围 1-65535', 'error'); return; }
  if (new Set(ports).size !== ports.length) { showToast('端口不能重复', 'error'); return; }
  const data = await api('/inbounds', 'POST', { inbounds: updated });
  if (data.error) { showToast(data.error, 'error'); return; }
  closeModal('portModal');
  showToast('端口已保存，正在重启...', 'success');
  await restartXray();
  loadNodes();
}

// ========== 节点管理 ==========
async function loadNodes() {
  const data = await api('/config');
  currentConfig = data;
  renderPorts(data.inbounds || []);
  const nodes = data.nodes || [];
  const list = document.getElementById('nodeList');
  if (nodes.length === 0) {
    list.innerHTML = '<div style="color:#8b949e;text-align:center;padding:20px;">暂无节点，点击"添加节点"开始</div>';
    return;
  }
  list.innerHTML = nodes.map(n => `
    <div class="node-item">
      <div class="node-info">
        <span style="font-size:11px;padding:1px 6px;border-radius:3px;margin-right:6px;background:${n.protocol==='vmess'?'#8957e533':'#1f6feb33'};color:${n.protocol==='vmess'?'#bc8cff':'#58a6ff'}">${(n.protocol||'vless').toUpperCase()}</span>
        <span class="node-tag">${n.tag}</span>
        <span class="node-addr">${maskAddr(n.address)}:${n.port}</span>
        <span style="color:#484f58;font-size:12px;margin-left:6px;">${n.network}/${n.security}</span>
        <span class="latency" id="latency-${n.tag}"></span>
      </div>
      <div class="node-actions">
        <button class="btn small" onclick="testNode('${n.tag}','${n.address}',${n.port})">测速</button>
        <button class="btn small" onclick="editNode('${n.tag}')">编辑</button>
        <button class="btn small danger" onclick="deleteNode('${n.tag}')">删除</button>
      </div>
    </div>
  `).join('');
}

async function testNode(tag, addr, port) {
  const el = document.getElementById('latency-' + tag);
  el.textContent = '测试中...';
  el.className = 'latency';
  const data = await api(`/test?address=${addr}&port=${port}`);
  if (data.reachable) {
    const ms = data.latency;
    el.textContent = ms + 'ms';
    el.className = 'latency ' + (ms < 200 ? 'good' : 'slow');
  } else {
    el.textContent = '不可达';
    el.className = 'latency fail';
  }
}

function toggleProtocolFields() {
  const proto = document.getElementById('nodeProtocol').value;
  document.querySelectorAll('.vless-field').forEach(e => e.style.display = proto === 'vless' ? '' : 'none');
  document.querySelectorAll('.vmess-field').forEach(e => e.style.display = proto === 'vmess' ? '' : 'none');
  toggleSecurityFields();
}
function toggleNetworkFields() {
  const net = document.getElementById('nodeNetwork').value;
  document.querySelectorAll('.ws-field').forEach(e => e.style.display = net === 'ws' ? '' : 'none');
}
function toggleSecurityFields() {
  const sec = document.getElementById('nodeSecurity').value;
  document.querySelectorAll('.reality-field').forEach(e => e.style.display = sec === 'reality' ? '' : 'none');
}

function showNodeModal(tag) {
  editingNodeTag = tag || null;
  document.getElementById('nodeModalTitle').textContent = tag ? '编辑节点' : '添加节点';
  if (tag && currentConfig) {
    const node = (currentConfig.nodes || []).find(n => n.tag === tag);
    if (node) {
      document.getElementById('nodeProtocol').value = node.protocol || 'vless';
      document.getElementById('nodeTag').value = node.tag;
      document.getElementById('nodeAddr').value = node.address;
      document.getElementById('nodePort').value = node.port;
      document.getElementById('nodeUUID').value = node.uuid;
      document.getElementById('nodeAlterID').value = node.alterId || 0;
      document.getElementById('nodeFlow').value = node.flow || 'xtls-rprx-vision';
      document.getElementById('nodeNetwork').value = node.network || 'tcp';
      document.getElementById('nodePath').value = node.path || '';
      document.getElementById('nodeHost').value = node.host || '';
      document.getElementById('nodeSecurity').value = node.security || 'reality';
      document.getElementById('nodeSNI').value = node.sni || '';
      document.getElementById('nodePBK').value = node.publicKey || '';
      document.getElementById('nodeSID').value = node.shortId || '';
      document.getElementById('nodeFP').value = node.fingerprint || 'chrome';
    }
  } else {
    document.querySelectorAll('#nodeModal input').forEach(i => i.value = '');
    document.getElementById('nodeProtocol').value = 'vless';
    document.getElementById('nodePort').value = '443';
    document.getElementById('nodeAlterID').value = '0';
    document.getElementById('nodeSNI').value = 'www.microsoft.com';
  }
  toggleProtocolFields();
  toggleNetworkFields();
  toggleSecurityFields();
  document.getElementById('nodeModal').classList.add('show');
}

function editNode(tag) { showNodeModal(tag); }

async function deleteNode(tag) {
  if (!confirm(`确定删除节点 "${tag}"？`)) return;
  await api('/node/' + encodeURIComponent(tag), 'DELETE');
  showToast('已删除', 'success');
  loadNodes();
  loadRoutes();
}

async function saveNode() {
  const node = {
    protocol: document.getElementById('nodeProtocol').value,
    tag: document.getElementById('nodeTag').value.trim(),
    address: document.getElementById('nodeAddr').value.trim(),
    port: parseInt(document.getElementById('nodePort').value),
    uuid: document.getElementById('nodeUUID').value.trim(),
    alterId: parseInt(document.getElementById('nodeAlterID').value || '0'),
    flow: document.getElementById('nodeFlow').value,
    network: document.getElementById('nodeNetwork').value,
    path: document.getElementById('nodePath').value.trim(),
    host: document.getElementById('nodeHost').value.trim(),
    security: document.getElementById('nodeSecurity').value,
    sni: document.getElementById('nodeSNI').value.trim(),
    publicKey: document.getElementById('nodePBK').value.trim(),
    shortId: document.getElementById('nodeSID').value.trim(),
    fingerprint: document.getElementById('nodeFP').value,
  };
  if (!node.tag || !node.address || !node.uuid) {
    showToast('标签、地址和 UUID 不能为空', 'error');
    return;
  }
  const method = editingNodeTag ? 'PUT' : 'POST';
  const path = editingNodeTag ? '/node/' + encodeURIComponent(editingNodeTag) : '/node';
  await api(path, method, node);
  closeModal('nodeModal');
  showToast('节点已保存', 'success');
  loadNodes();
}

// ========== VLESS 导入 ==========
function showImportModal() {
  document.getElementById('vlessInput').value = '';
  document.getElementById('importModal').classList.add('show');
}

async function importVless() {
  const input = document.getElementById('vlessInput').value.trim();
  const lines = input.split('\n').filter(l => l.trim().startsWith('vless://') || l.trim().startsWith('vmess://'));
  if (lines.length === 0) {
    showToast('未找到有效的 vless:// 或 vmess:// 链接', 'error');
    return;
  }
  const data = await api('/import', 'POST', { urls: lines });
  closeModal('importModal');
  showToast(`成功导入 ${data.imported || 0} 个节点`, 'success');
  loadNodes();
}

// ========== 均衡组 ==========
let editingBalancerTag = null;

async function loadBalancers() {
  const data = await api('/config');
  currentConfig = data;
  const balancers = data.balancers || [];
  const list = document.getElementById('balancerList');
  if (balancers.length === 0) {
    list.innerHTML = '<div style="color:#8b949e;text-align:center;padding:20px;">暂无均衡组。创建均衡组后，xray 会自动为指定域名选择延迟最低的节点。</div>';
    return;
  }
  list.innerHTML = balancers.map(b => `
    <div class="node-item" style="flex-direction:column;align-items:flex-start;gap:8px;">
      <div style="display:flex;align-items:center;justify-content:space-between;width:100%;">
        <div>
          <span style="font-size:11px;padding:1px 6px;border-radius:3px;margin-right:6px;background:#d2992233;color:#d29922;">BALANCER</span>
          <span class="node-tag">${b.tag}</span>
          <span style="color:#484f58;font-size:12px;margin-left:6px;">${b.strategy} | ${b.probeInterval}</span>
        </div>
        <div class="node-actions">
          <button class="btn small" onclick="editBalancer('${b.tag}')">编辑</button>
          <button class="btn small danger" onclick="deleteBalancer('${b.tag}')">删除</button>
        </div>
      </div>
      <div style="font-size:12px;color:#8b949e;padding-left:4px;">
        <span style="color:#3fb950;">节点(${b.nodeTags.length}):</span> ${b.nodeTags.map(t => '<span style="background:#21262d;padding:1px 6px;border-radius:3px;margin:0 2px;">'+t+'</span>').join('')}
      </div>
      <div style="font-size:12px;color:#8b949e;padding-left:4px;">
        <span style="color:#58a6ff;">域名(${b.domains.length}):</span> <span class="route-domains">${b.domains.slice(0,5).join(', ')}${b.domains.length>5?' +' +(b.domains.length-5):''}</span>
      </div>
    </div>
  `).join('');
}

function showBalancerModal(tag) {
  editingBalancerTag = tag || null;
  document.getElementById('balancerModalTitle').textContent = tag ? '编辑均衡组' : '创建均衡组';
  const nodes = currentConfig ? currentConfig.nodes || [] : [];
  let selectedTags = [];
  if (tag && currentConfig) {
    const b = (currentConfig.balancers || []).find(x => x.tag === tag);
    if (b) {
      document.getElementById('balancerTag').value = b.tag;
      document.getElementById('balancerStrategy').value = b.strategy || 'leastPing';
      document.getElementById('balancerDomains').value = b.domains.join('\n');
      document.getElementById('balancerProbeURL').value = b.probeURL || 'https://www.google.com/generate_204';
      document.getElementById('balancerProbeInterval').value = b.probeInterval || '60s';
      selectedTags = b.nodeTags || [];
    }
  } else {
    document.getElementById('balancerTag').value = '';
    document.getElementById('balancerDomains').value = '';
    document.getElementById('balancerProbeURL').value = 'https://www.google.com/generate_204';
    document.getElementById('balancerProbeInterval').value = '60s';
  }
  // 渲染节点选择列表
  document.getElementById('balancerNodeList').innerHTML = nodes.map(n => `
    <label style="display:flex;align-items:center;gap:8px;padding:4px 0;cursor:pointer;">
      <input type="checkbox" value="${n.tag}" ${selectedTags.includes(n.tag)?'checked':''}>
      <span style="font-size:11px;padding:1px 4px;border-radius:3px;background:${n.protocol==='vmess'?'#8957e533':'#1f6feb33'};color:${n.protocol==='vmess'?'#bc8cff':'#58a6ff'}">${(n.protocol||'vless').toUpperCase()}</span>
      <span style="color:#f0883e;font-weight:500;">${n.tag}</span>
      <span style="color:#484f58;font-size:12px;">${maskAddr(n.address)}:${n.port}</span>
    </label>
  `).join('') || '<div style="color:#484f58">无可用节点</div>';
  document.getElementById('balancerModal').classList.add('show');
}

function editBalancer(tag) { showBalancerModal(tag); }

async function deleteBalancer(tag) {
  if (!confirm('确定删除均衡组 "' + tag + '"？')) return;
  await api('/balancer/' + encodeURIComponent(tag), 'DELETE');
  showToast('均衡组已删除', 'success');
  await restartXray();
  loadBalancers();
  loadRoutes();
}

async function saveBalancer() {
  const tag = document.getElementById('balancerTag').value.trim();
  if (!tag) { showToast('请输入均衡组名称', 'error'); return; }
  const checkedNodes = Array.from(document.querySelectorAll('#balancerNodeList input:checked')).map(c => c.value);
  if (checkedNodes.length < 2) { showToast('至少选择 2 个节点', 'error'); return; }
  const domains = document.getElementById('balancerDomains').value.split('\n').map(s => s.trim()).filter(Boolean);
  if (domains.length === 0) { showToast('请输入至少一个域名规则', 'error'); return; }
  const data = {
    tag: tag,
    nodeTags: checkedNodes,
    domains: domains,
    strategy: document.getElementById('balancerStrategy').value,
    probeURL: document.getElementById('balancerProbeURL').value.trim(),
    probeInterval: document.getElementById('balancerProbeInterval').value,
  };
  const method = editingBalancerTag ? 'PUT' : 'POST';
  const path = editingBalancerTag ? '/balancer/' + encodeURIComponent(editingBalancerTag) : '/balancer';
  await api(path, method, data);
  closeModal('balancerModal');
  showToast('均衡组已保存，正在重启...', 'success');
  await restartXray();
  loadBalancers();
  loadRoutes();
}

// ========== 订阅导入 ==========
let subParsedUrls = [];

function showSubModal() {
  document.getElementById('subUrl').value = '';
  document.getElementById('subPreview').style.display = 'none';
  document.getElementById('subImportBtn').style.display = 'none';
  document.getElementById('subFetchBtn').textContent = '解析';
  subParsedUrls = [];
  document.getElementById('subModal').classList.add('show');
}

async function fetchSub() {
  const url = document.getElementById('subUrl').value.trim();
  if (!url) { showToast('请输入订阅地址', 'error'); return; }
  document.getElementById('subFetchBtn').textContent = '解析中...';
  try {
    const data = await api('/subscribe', 'POST', { url });
    if (data.error) { showToast(data.error, 'error'); document.getElementById('subFetchBtn').textContent = '解析'; return; }
    subParsedUrls = data.urls || [];
    const nodes = data.nodes || [];
    document.getElementById('subCount').textContent = nodes.length;
    document.getElementById('subList').innerHTML = nodes.map(n =>
      `<div style="padding:2px 0;"><span style="color:${n.protocol==='vmess'?'#bc8cff':'#58a6ff'}">[${n.protocol}]</span> ${n.remark || n.tag || ''} - ${maskAddr(n.address)}:${n.port} (${n.network}/${n.security})</div>`
    ).join('');
    document.getElementById('subPreview').style.display = '';
    document.getElementById('subImportBtn').style.display = '';
    document.getElementById('subFetchBtn').textContent = '重新解析';
  } catch(e) {
    showToast('解析失败: ' + e.message, 'error');
    document.getElementById('subFetchBtn').textContent = '解析';
  }
}

async function importSub() {
  if (!subParsedUrls.length) { showToast('没有可导入的节点', 'error'); return; }
  const data = await api('/import', 'POST', { urls: subParsedUrls });
  closeModal('subModal');
  showToast(`成功导入 ${data.imported || 0} 个节点`, 'success');
  loadNodes();
}

// ========== 路由规则 ==========
async function loadRoutes() {
  const data = await api('/config');
  currentConfig = data;
  const routes = data.routes || [];
  const list = document.getElementById('routeList');
  if (routes.length === 0) {
    list.innerHTML = '<div style="color:#8b949e">暂无路由规则</div>';
    return;
  }
  list.innerHTML = routes.map((r, i) => {
    const tagClass = r.outboundTag.replace(/[^a-z-]/gi, '-');
    const items = [...r.domains, ...r.ips].slice(0, 6);
    const more = r.domains.length + r.ips.length - 6;
    return `
      <div class="route-item">
        <span class="route-tag ${tagClass}">${r.outboundTag}</span>
        ${r.port ? `<span style="color:#d29922;font-size:12px;">[port:${r.port}]</span>` : ''}
        ${r.network ? `<span style="color:#d29922;font-size:12px;">[${r.network}]</span>` : ''}
        <span class="route-domains">${items.join(', ')}${more > 0 ? ` +${more}` : ''}</span>
        <button class="btn small" style="float:right;" onclick="editRoute(${i})">编辑</button>
      </div>
    `;
  }).join('');
}

function showRouteModal() {
  editingRouteIdx = null;
  const select = document.getElementById('routeOutbound');
  const nodes = currentConfig ? currentConfig.nodes || [] : [];
  select.innerHTML = nodes.map(n => `<option value="${n.tag}">${n.tag}</option>`).join('') +
    '<option value="direct">direct</option><option value="block">block</option>';
  document.getElementById('routeDomains').value = '';
  document.getElementById('routeIPs').value = '';
  document.getElementById('routeModal').classList.add('show');
}

function editRoute(idx) {
  editingRouteIdx = idx;
  const route = currentConfig.routes[idx];
  const select = document.getElementById('routeOutbound');
  const nodes = currentConfig ? currentConfig.nodes || [] : [];
  select.innerHTML = nodes.map(n => `<option value="${n.tag}">${n.tag}</option>`).join('') +
    '<option value="direct">direct</option><option value="block">block</option>';
  select.value = route.outboundTag;
  document.getElementById('routeDomains').value = route.domains.join('\n');
  document.getElementById('routeIPs').value = route.ips.join('\n');
  document.getElementById('routeModal').classList.add('show');
}

async function saveRoute() {
  const route = {
    outboundTag: document.getElementById('routeOutbound').value,
    domains: document.getElementById('routeDomains').value.split('\n').map(s => s.trim()).filter(Boolean),
    ips: document.getElementById('routeIPs').value.split('\n').map(s => s.trim()).filter(Boolean),
  };
  const method = editingRouteIdx !== null ? 'PUT' : 'POST';
  const path = editingRouteIdx !== null ? '/route/' + editingRouteIdx : '/route';
  await api(path, method, route);
  closeModal('routeModal');
  showToast('路由规则已保存', 'success');
  loadRoutes();
}

// ========== 日志 ==========
async function loadLogs() {
  const data = await api('/logs');
  document.getElementById('logArea').textContent = data.logs || '暂无日志';
}

// ========== UI 工具 ==========
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  event.target.classList.add('active');
  document.getElementById('tab-' + name).classList.add('active');
  if (name === 'logs') loadLogs();
  if (name === 'balancers') loadBalancers();
}

function closeModal(id) { document.getElementById(id).classList.remove('show'); }

function showToast(msg, type) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show ' + type;
  setTimeout(() => t.classList.remove('show'), 3000);
}

// ========== 初始化 ==========
checkStatus();
checkSysProxy();
loadNodes();
loadRoutes();
setInterval(checkStatus, 10000);
setInterval(checkSysProxy, 10000);
</script>
</body>
</html>"""

# ==================== HTTP 处理器 ====================

class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # 静默日志

    def _json(self, data, code=200):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode())

    def _html(self, html):
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(html.encode())

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        params = dict(urllib.parse.parse_qsl(parsed.query))

        if path == "/":
            self._html(HTML_PAGE)
        elif path == "/api/status":
            self._json(get_xray_status())
        elif path == "/api/config":
            config = load_config()
            if config:
                inbounds = []
                for ib in config.get("inbounds", []):
                    inbounds.append({
                        "tag": ib.get("tag", ""),
                        "protocol": ib.get("protocol", ""),
                        "listen": ib.get("listen", "0.0.0.0"),
                        "port": ib.get("port", 0),
                    })
                self._json({
                    "nodes": extract_nodes(config),
                    "routes": extract_routes(config),
                    "balancers": extract_balancers(config),
                    "inbounds": inbounds,
                })
            else:
                self._json({"nodes": [], "routes": [], "balancers": [], "inbounds": []})
        elif path == "/api/sysproxy":
            self._json(get_system_proxy())
        elif path == "/api/logs":
            self._json({"logs": get_logs(200)})
        elif path == "/api/test":
            addr = params.get("address", "")
            port = params.get("port", "443")
            self._json(test_node(addr, port))
        else:
            self.send_error(404)

    def do_POST(self):
        content_len = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(content_len)) if content_len > 0 else {}
        path = urllib.parse.urlparse(self.path).path

        if path == "/api/restart":
            self._json(restart_xray())
        elif path == "/api/stop":
            self._json(stop_xray())
        elif path == "/api/sysproxy":
            enable = body.get("enable", True)
            iface = body.get("interface", None)
            self._json(set_system_proxy(enable, iface))
        elif path == "/api/subscribe":
            sub_url = body.get("url", "")
            if not sub_url:
                self._json({"error": "缺少订阅地址"}, 400)
                return
            try:
                req = urllib.request.Request(sub_url, headers={
                    "User-Agent": "V2RayN/7.0",
                    "Accept": "*/*",
                })
                with urllib.request.urlopen(req, timeout=15) as resp:
                    raw = resp.read().decode("utf-8").strip()
                # base64 解码
                try:
                    raw += "=" * (4 - len(raw) % 4) if len(raw) % 4 else ""
                    decoded = base64.b64decode(raw).decode("utf-8")
                except Exception:
                    decoded = raw  # 可能不是 base64，直接是文本
                # 按行解析
                lines = [l.strip() for l in decoded.splitlines() if l.strip()]
                urls = [l for l in lines if l.startswith("vless://") or l.startswith("vmess://") or l.startswith("ss://") or l.startswith("trojan://")]
                # 解析每个节点的基本信息用于预览
                nodes = []
                for u in urls:
                    parsed = parse_proxy_url(u)
                    if parsed:
                        nodes.append({
                            "protocol": parsed.get("protocol", "unknown"),
                            "remark": parsed.get("remark", ""),
                            "address": parsed.get("address", ""),
                            "port": parsed.get("port", 0),
                            "network": parsed.get("network", parsed.get("type", "tcp")),
                            "security": parsed.get("security", "none"),
                        })
                    else:
                        # 不支持的协议也列出来
                        proto = u.split("://")[0] if "://" in u else "unknown"
                        nodes.append({"protocol": proto, "remark": "(不支持)", "address": "?", "port": 0, "network": "-", "security": "-"})
                self._json({"urls": urls, "nodes": nodes, "total": len(lines), "supported": len([u for u in urls if u.startswith("vless://") or u.startswith("vmess://")])} )
            except Exception as e:
                self._json({"error": f"获取订阅失败: {str(e)}"}, 500)
        elif path == "/api/balancer":
            config = load_config()
            if not config:
                self._json({"error": "no config"}, 400)
                return
            config = save_balancer_to_config(config, body)
            save_config(config)
            self._json({"success": True})
        elif path == "/api/node":
            config = load_config()
            if not config:
                self._json({"error": "no config"}, 400)
                return
            outbound = build_outbound(body)
            # 添加到 outbounds（在 direct 之前）
            outbounds = config.get("outbounds", [])
            insert_idx = next((i for i, o in enumerate(outbounds) if o.get("tag") == "direct"), len(outbounds))
            outbounds.insert(insert_idx, outbound)
            config["outbounds"] = outbounds
            save_config(config)
            self._json({"success": True})
        elif path == "/api/import":
            config = load_config()
            if not config:
                self._json({"error": "no config"}, 400)
                return
            urls = body.get("urls", [])
            imported = 0
            for url in urls:
                parsed = parse_proxy_url(url)
                if not parsed:
                    continue
                tag = parsed.get("remark") or f"proxy-{imported}"
                proto = parsed.get("protocol", "vless")
                node = {
                    "tag": tag,
                    "protocol": proto,
                    "address": parsed["address"],
                    "port": parsed["port"],
                    "uuid": parsed["uuid"],
                    "alterId": parsed.get("alterId", 0),
                    "flow": parsed.get("flow", "") if proto == "vless" else "",
                    "network": parsed.get("network", parsed.get("type", "tcp")),
                    "path": parsed.get("path", ""),
                    "host": parsed.get("host", ""),
                    "security": parsed.get("security", parsed.get("tls", "none")),
                    "sni": parsed.get("sni", ""),
                    "publicKey": parsed.get("pbk", ""),
                    "shortId": parsed.get("sid", ""),
                    "fingerprint": parsed.get("fp", "chrome") or "chrome",
                }
                outbound = build_outbound(node)
                outbounds = config.get("outbounds", [])
                # 检查是否已存在
                existing = next((i for i, o in enumerate(outbounds) if o.get("tag") == tag), None)
                if existing is not None:
                    outbounds[existing] = outbound
                else:
                    insert_idx = next((i for i, o in enumerate(outbounds) if o.get("tag") == "direct"), len(outbounds))
                    outbounds.insert(insert_idx, outbound)
                config["outbounds"] = outbounds
                imported += 1
            save_config(config)
            self._json({"success": True, "imported": imported})
        elif path == "/api/inbounds":
            config = load_config()
            if not config:
                self._json({"error": "no config"}, 400)
                return
            new_inbounds = body.get("inbounds", [])
            if not new_inbounds:
                self._json({"error": "inbounds 不能为空"}, 400)
                return
            # 检查端口冲突
            ports = [ib["port"] for ib in new_inbounds]
            if len(ports) != len(set(ports)):
                self._json({"error": "端口不能重复"}, 400)
                return
            # 更新配置中的 inbounds
            for new_ib in new_inbounds:
                for i, old_ib in enumerate(config.get("inbounds", [])):
                    if old_ib.get("tag") == new_ib.get("tag"):
                        config["inbounds"][i]["port"] = int(new_ib["port"])
                        if "listen" in new_ib:
                            config["inbounds"][i]["listen"] = new_ib["listen"]
                        break
                else:
                    # 新增的 inbound
                    config.setdefault("inbounds", []).append({
                        "tag": new_ib.get("tag", f"inbound-{new_ib['port']}"),
                        "port": int(new_ib["port"]),
                        "listen": new_ib.get("listen", "127.0.0.1"),
                        "protocol": new_ib.get("protocol", "http"),
                        "sniffing": {"enabled": True, "destOverride": ["http", "tls"]},
                        "settings": {"timeout": 300, "allowTransparent": False},
                    })
            save_config(config)
            self._json({"success": True})
        elif path.startswith("/api/route"):
            config = load_config()
            if not config:
                self._json({"error": "no config"}, 400)
                return
            rules = config.get("routing", {}).get("rules", [])
            # 构建新规则
            new_rule = {"type": "field", "outboundTag": body["outboundTag"]}
            if body.get("domains"):
                new_rule["domain"] = body["domains"]
            if body.get("ips"):
                new_rule["ip"] = body["ips"]
            # 找到合适的插入位置（在 direct/block 规则之前）
            insert_idx = next(
                (i for i, r in enumerate(rules) if r.get("outboundTag") in ("direct", "block") and "domain" not in r and "ip" not in r),
                len(rules)
            )
            rules.insert(insert_idx, new_rule)
            config["routing"]["rules"] = rules
            save_config(config)
            self._json({"success": True})
        else:
            self.send_error(404)

    def do_PUT(self):
        content_len = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(content_len)) if content_len > 0 else {}
        path = urllib.parse.urlparse(self.path).path

        if path.startswith("/api/balancer/"):
            old_tag = urllib.parse.unquote(path.split("/api/balancer/")[1])
            config = load_config()
            if not config:
                self._json({"error": "no config"}, 400)
                return
            # 先删旧的再保存新的
            if old_tag != body.get("tag", old_tag):
                config = delete_balancer_from_config(config, old_tag)
            config = save_balancer_to_config(config, body)
            save_config(config)
            self._json({"success": True})
        elif path.startswith("/api/node/"):
            old_tag = urllib.parse.unquote(path.split("/api/node/")[1])
            config = load_config()
            if not config:
                self._json({"error": "no config"}, 400)
                return
            outbound = build_outbound(body)
            outbounds = config.get("outbounds", [])
            idx = next((i for i, o in enumerate(outbounds) if o.get("tag") == old_tag), None)
            if idx is not None:
                outbounds[idx] = outbound
            config["outbounds"] = outbounds
            # 更新路由规则中的 tag
            if old_tag != body["tag"]:
                for rule in config.get("routing", {}).get("rules", []):
                    if rule.get("outboundTag") == old_tag:
                        rule["outboundTag"] = body["tag"]
            save_config(config)
            self._json({"success": True})
        elif path.startswith("/api/route/"):
            idx = int(path.split("/api/route/")[1])
            config = load_config()
            if not config:
                self._json({"error": "no config"}, 400)
                return
            # 找到实际的 rule index（跳过 api 规则）
            rules = config.get("routing", {}).get("rules", [])
            visible_idx = -1
            for i, r in enumerate(rules):
                if r.get("outboundTag") == "api":
                    continue
                visible_idx += 1
                if visible_idx == idx:
                    if body.get("domains"):
                        rules[i]["domain"] = body["domains"]
                    elif "domain" in rules[i]:
                        del rules[i]["domain"]
                    if body.get("ips"):
                        rules[i]["ip"] = body["ips"]
                    elif "ip" in rules[i]:
                        del rules[i]["ip"]
                    rules[i]["outboundTag"] = body["outboundTag"]
                    break
            config["routing"]["rules"] = rules
            save_config(config)
            self._json({"success": True})
        else:
            self.send_error(404)

    def do_DELETE(self):
        path = urllib.parse.urlparse(self.path).path
        if path.startswith("/api/balancer/"):
            tag = urllib.parse.unquote(path.split("/api/balancer/")[1])
            config = load_config()
            if not config:
                self._json({"error": "no config"}, 400)
                return
            config = delete_balancer_from_config(config, tag)
            save_config(config)
            self._json({"success": True})
        elif path.startswith("/api/node/"):
            tag = urllib.parse.unquote(path.split("/api/node/")[1])
            config = load_config()
            if not config:
                self._json({"error": "no config"}, 400)
                return
            config["outbounds"] = [o for o in config.get("outbounds", []) if o.get("tag") != tag]
            config["routing"]["rules"] = [
                r for r in config.get("routing", {}).get("rules", [])
                if r.get("outboundTag") != tag
            ]
            save_config(config)
            self._json({"success": True})
        else:
            self.send_error(404)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()


# ==================== 主入口 ====================

def main():
    print(f"Xray Manager starting on http://{('0.0.0.0' if IS_LINUX else '127.0.0.1')}:{WEB_PORT}")
    print(f"Config: {CONFIG_PATH}")
    print(f"Xray: {XRAY_BIN}")

    # 确保配置目录存在
    XRAY_HOME.mkdir(parents=True, exist_ok=True)

    # Linux 服务器监听所有接口（方便远程管理），macOS 只监听本地
    bind_addr = "0.0.0.0" if IS_LINUX else "127.0.0.1"
    server = HTTPServer((bind_addr, WEB_PORT), Handler)

    def shutdown(sig, frame):
        print("\nShutting down...")
        server.shutdown()
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown)
    if not IS_WINDOWS:
        signal.signal(signal.SIGTERM, shutdown)

    # 自动打开浏览器
    if "--no-browser" not in sys.argv:
        url = f"http://127.0.0.1:{WEB_PORT}"
        if IS_WINDOWS:
            os.startfile(url)
        elif IS_MACOS:
            subprocess.Popen(["open", url])
        elif IS_LINUX:
            try:
                subprocess.Popen(["xdg-open", url], stderr=subprocess.DEVNULL)
            except FileNotFoundError:
                pass  # Linux 无桌面环境时跳过

    print(f"Web UI: http://127.0.0.1:{WEB_PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
