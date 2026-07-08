import html
import json
import os
import re
import secrets
import shutil
import sqlite3
import subprocess
import threading
import time
import traceback
import urllib.request
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

KUMA_DB = os.environ.get("KUMA_DB", "/kuma/kuma.db")
NETDATA = os.environ.get("NETDATA_URL", "http://netdata:19999")
DISPLAY_HOSTNAME = os.environ.get("DISPLAY_HOSTNAME", "racknerd-54aa08d")
STATE_DIR = os.environ.get("STATE_DIR", "/tmp/ai-ops-state")
ALERT_STATE_FILE = os.path.join(STATE_DIR, "alert-state.json")
DAILY_STATE_FILE = os.path.join(STATE_DIR, "daily-state.json")
SNAPSHOT_FILE = os.path.join(STATE_DIR, "last-report.json")
CACHE_TTL_SECONDS = int(os.environ.get("CACHE_TTL_SECONDS", "15"))
REPORT_CACHE = {"ts": 0, "data": None}
TERMINAL_LOG_DIR = os.environ.get("TERMINAL_LOG_DIR", "/terminal-logs")
DANGEROUS_PATTERNS = ["rm -rf", "docker compose down", "docker rm", "docker volume rm", "ufw ", "iptables", "mkfs", "drop database", "truncate table", ":(){", "reboot", "shutdown"]
TERMINAL_ACTION_LOCK = threading.Lock()
TERMINAL_ACTION_STATE = {"last_restart": 0}
TERMINAL_RESTART_COOLDOWN_SECONDS = int(os.environ.get("TERMINAL_RESTART_COOLDOWN_SECONDS", "30"))
ACTION_TOKEN = os.environ.get("OPS_ACTION_TOKEN") or secrets.token_urlsafe(24)



def run(cmd):
    return subprocess.check_output(cmd, text=True, timeout=10).strip()


def docker_ps():
    raw = run(["docker", "ps", "--format", "{{json .}}"])
    items = []
    for line in raw.splitlines():
        if line.strip():
            data = json.loads(line)
            if data.get("Names", "").startswith("ops-"):
                items.append({
                    "name": data.get("Names"),
                    "image": data.get("Image"),
                    "status": data.get("Status"),
                    "state": data.get("State"),
                })
    return sorted(items, key=lambda item: item["name"])


def kuma_status():
    conn = sqlite3.connect(KUMA_DB)
    conn.row_factory = sqlite3.Row
    monitors = conn.execute("select id,name,type,url,hostname,port,active from monitor order by id").fetchall()
    rows = []
    for monitor in monitors:
        heartbeat = conn.execute(
            "select status,msg,ping,time from heartbeat where monitor_id=? order by id desc limit 1",
            (monitor["id"],),
        ).fetchone()
        rows.append({
            "id": monitor["id"],
            "name": monitor["name"],
            "type": monitor["type"],
            "target": monitor["url"] or f"{monitor['hostname']}:{monitor['port']}",
            "active": bool(monitor["active"]),
            "status": None if heartbeat is None else heartbeat["status"],
            "statusText": "UP" if heartbeat and heartbeat["status"] == 1 else "DOWN" if heartbeat and heartbeat["status"] == 0 else "UNKNOWN",
            "msg": None if heartbeat is None else heartbeat["msg"],
            "ping": None if heartbeat is None else heartbeat["ping"],
            "time": None if heartbeat is None else heartbeat["time"],
        })
    conn.close()
    return rows


def netdata_chart(chart):
    url = f"{NETDATA}/api/v1/data?chart={chart}&after=-5&before=0&points=1&format=json"
    with urllib.request.urlopen(url, timeout=10) as response:
        data = json.loads(response.read().decode())
    labels = data.get("labels", [])
    values = data.get("data", [[]])[0]
    return dict(zip(labels, values))


def disk_summary():
    disks = []
    for mount in ["/", "/app", "/kuma"]:
        try:
            usage = shutil.disk_usage(mount)
            disks.append({
                "mount": mount,
                "totalGB": round(usage.total / (1024 ** 3), 2),
                "usedGB": round(usage.used / (1024 ** 3), 2),
                "freeGB": round(usage.free / (1024 ** 3), 2),
                "usedPercent": round((usage.used / usage.total) * 100, 1) if usage.total else None,
            })
        except Exception:
            pass
    try:
        docker_df = json.loads(run(["docker", "system", "df", "--format", "json"]).splitlines()[0])
    except Exception:
        docker_df = None
    return {"mounts": disks, "docker": docker_df}


def ensure_state_dir():
    os.makedirs(STATE_DIR, exist_ok=True)


def load_json_file(path, default):
    try:
        with open(path, encoding="utf-8") as file:
            return json.load(file)
    except Exception:
        return default


def save_json_file(path, payload):
    ensure_state_dir()
    tmp_path = path + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as file:
        json.dump(payload, file, ensure_ascii=False, indent=2)
    os.replace(tmp_path, path)


def parse_kuma_time(value):
    if not value:
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(value, fmt).timestamp()
        except ValueError:
            pass
    return None


def backup_summary(monitors):
    backups = [item for item in monitors if "备份" in item["name"] or "MyJavis" in item["name"]]
    if not backups:
        return {"ok": None, "message": "未找到备份监控", "items": []}
    items = []
    now = time.time()
    for item in backups:
        last_ts = parse_kuma_time(item.get("time"))
        age_hours = round((now - last_ts) / 3600, 1) if last_ts else None
        window_hours = 36 if item.get("type") == "push" else None
        remaining_hours = round(window_hours - age_hours, 1) if age_hours is not None and window_hours else None
        items.append({
            "name": item["name"],
            "statusText": item["statusText"],
            "msg": item.get("msg"),
            "time": item.get("time"),
            "ageHours": age_hours,
            "windowHours": window_hours,
            "remainingHours": remaining_hours,
            "ok": item["statusText"] == "UP" and (remaining_hours is None or remaining_hours > 0),
        })
    ok = all(item["ok"] for item in items)
    first = items[0]
    if first.get("remainingHours") is not None:
        message = f"{first['statusText']}，最近心跳 {first.get('time') or '未知'}，约剩 {first['remainingHours']} 小时进入告警窗口"
    else:
        message = f"{first['statusText']}，最近心跳 {first.get('time') or '未知'}"
    return {"ok": ok, "message": message, "items": items}


def latest_daily_state():
    return load_json_file(DAILY_STATE_FILE, {})


def issue_signature(report):
    down = sorted(item["name"] for item in report["monitors"] if item["active"] and item["status"] != 1)
    unhealthy = sorted(item["name"] for item in report["containers"] if "Up" not in item["status"])
    return json.dumps({"down": down, "unhealthy": unhealthy}, ensure_ascii=False, sort_keys=True)


def should_send_alert(report, force=False):
    signature = issue_signature(report)
    state = load_json_file(ALERT_STATE_FILE, {})
    now = time.strftime("%Y-%m-%d %H:%M:%S %Z")
    previous = state.get("signature")
    previous_ok = state.get("ok", True)
    current_ok = report["ok"]
    send = force or signature != previous or (previous_ok is False and current_ok is True)
    state.update({"signature": signature, "ok": current_ok, "updatedAt": now})
    save_json_file(ALERT_STATE_FILE, state)
    return send, {"previousSignature": previous, "signature": signature, "deduped": not send}


def dashboard_payload():
    context = ai_context()
    host = context["summary"]["host"]
    mounts = host.get("diskGB", {}).get("mounts", [])
    max_disk = max([item.get("usedPercent") or 0 for item in mounts] or [0])
    return {
        "ok": context["summary"]["ok"],
        "generatedAt": context["generatedAt"],
        "statusText": "正常" if context["summary"]["ok"] else "需要关注",
        "backup": context.get("backup"),
        "lastDaily": latest_daily_state(),
        "metrics": {
            "monitorCount": context["summary"]["monitorCount"],
            "downCount": len(context["summary"]["downMonitors"]),
            "unhealthyCount": len(context["summary"]["unhealthyContainers"]),
            "maxDiskUsedPercent": max_disk,
            "containerCount": len(context["containers"]),
            "load1": host.get("load1"),
            "freeRamMB": host.get("ramMB", {}).get("free"),
        },
        "cache": context.get("cache"),
    }


def host_summary():
    load = os.getloadavg()
    ram = netdata_chart("system.ram")
    return {
        "hostname": DISPLAY_HOSTNAME,
        "containerHostname": run(["hostname"]),
        "kernel": run(["uname", "-r"]),
        "load1": round(load[0], 2),
        "load5": round(load[1], 2),
        "load15": round(load[2], 2),
        "ramMB": {key: round(value, 1) for key, value in ram.items() if key != "time"},
        "diskGB": disk_summary(),
    }


def collect_report():
    containers = docker_ps()
    monitors = kuma_status()
    host = host_summary()
    unhealthy = [container for container in containers if "Up" not in container["status"]]
    down = [monitor for monitor in monitors if monitor["active"] and monitor["status"] != 1]
    ok = not unhealthy and not down
    lines = []
    lines.append("AI 运维驾驶舱手动巡检")
    lines.append(f"时间：{time.strftime('%Y-%m-%d %H:%M:%S %Z')}")
    lines.append(f"结论：{'✅ 正常' if ok else '⚠️ 需要关注'}")
    lines.append("")
    lines.append(f"主机：{host['hostname']} / Kernel {host['kernel']} / Load {host['load1']}, {host['load5']}, {host['load15']}")
    lines.append(f"内存(MB)：used {host['ramMB'].get('used')} / free {host['ramMB'].get('free')} / cached {host['ramMB'].get('cached')}")
    if host["diskGB"].get("mounts"):
        lines.append("磁盘：" + ", ".join(f"{item['mount']} used {item['usedGB']}GB/{item['totalGB']}GB ({item['usedPercent']}%)" for item in host["diskGB"]["mounts"]))
    lines.append("")
    lines.append("Kuma 监控：")
    for monitor in monitors:
        lines.append(f"- {monitor['statusText']} {monitor['name']}：{monitor['msg'] or ''}")
    lines.append("")
    lines.append("容器：")
    for container in containers:
        lines.append(f"- {container['name']}：{container['status']}")
    return {"ok": ok, "host": host, "monitors": monitors, "containers": containers, "text": "\n".join(lines)}


def build_report(force=False):
    now = time.time()
    if not force and REPORT_CACHE["data"] is not None and now - REPORT_CACHE["ts"] < CACHE_TTL_SECONDS:
        cached = dict(REPORT_CACHE["data"])
        cached["cache"] = {"hit": True, "source": "memory", "ageSeconds": round(now - REPORT_CACHE["ts"], 2), "ttlSeconds": CACHE_TTL_SECONDS}
        return cached
    if not force and REPORT_CACHE["data"] is None:
        snapshot = load_json_file(SNAPSHOT_FILE, None)
        if snapshot:
            REPORT_CACHE["ts"] = now
            REPORT_CACHE["data"] = snapshot
            cached = dict(snapshot)
            cached["cache"] = {"hit": True, "source": "snapshot", "ageSeconds": 0, "ttlSeconds": CACHE_TTL_SECONDS}
            return cached
    report = collect_report()
    report["cache"] = {"hit": False, "source": "live", "ageSeconds": 0, "ttlSeconds": CACHE_TTL_SECONDS}
    REPORT_CACHE["ts"] = now
    REPORT_CACHE["data"] = report
    save_json_file(SNAPSHOT_FILE, report)
    return dict(report)


def ai_context():
    report = build_report()
    active_monitors = [monitor for monitor in report["monitors"] if monitor["active"]]
    return {
        "mode": "read_only_ai_ops_assistant_v0",
        "generatedAt": time.strftime("%Y-%m-%d %H:%M:%S %Z"),
        "guardrails": [
            "只读分析，不执行重启、删除、升级、改配置。",
            "高危动作必须先解释风险、给出命令草案、等待川哥确认。",
            "结论必须基于当前 JSON 数据，不确定就说不确定。",
        ],
        "questionsSupported": [
            "当前有哪些服务异常？",
            "备份是否正常？",
            "这次告警可能是什么原因？",
            "下一步应该先看哪里？",
        ],
        "summary": {
            "ok": report["ok"],
            "host": report["host"],
            "monitorCount": len(active_monitors),
            "downMonitors": [monitor for monitor in active_monitors if monitor["status"] != 1],
            "unhealthyContainers": [container for container in report["containers"] if "Up" not in container["status"]],
        },
        "backup": backup_summary(report["monitors"]),
        "lastDaily": latest_daily_state(),
        "kumaMonitors": report["monitors"],
        "containers": report["containers"],
        "reportText": report["text"],
        "cache": report.get("cache"),
    }


def ai_prompt():
    context = json.dumps(ai_context(), ensure_ascii=False, indent=2)
    return """你是川哥的只读 AI 运维助手。请基于下面 JSON 判断当前 ops.hahaxiong.top 运维驾驶舱状态。

要求：
1. 只能分析和建议，不要执行任何命令。
2. 先给一句总判断，再列异常/风险/下一步。
3. 如果一切正常，也要指出最值得持续观察的 1-3 项。
4. 高危动作只能给建议，不要直接要求执行。

当前只读上下文 JSON：
```json
""" + context + "\n```\n"


def send_feishu(report, force=False):
    send, dedupe = should_send_alert(report, force=force)
    if not send:
        return {"status": "deduped", "body": "same issue signature", "dedupe": dedupe}
    webhook = os.environ.get("FEISHU_WEBHOOK_URL")
    if not webhook:
        raise RuntimeError("FEISHU_WEBHOOK_URL is not configured")
    payload = json.dumps({"msg_type": "text", "content": {"text": report["text"]}}, ensure_ascii=False).encode()
    request = urllib.request.Request(webhook, data=payload, headers={"content-type": "application/json"}, method="POST")
    with urllib.request.urlopen(request, timeout=15) as response:
        body = response.read().decode("utf-8", "replace")
    return {"status": response.status, "body": body, "dedupe": dedupe}


def probe_url(url):
    started = time.time()
    with urllib.request.urlopen(url, timeout=10) as response:
        body = response.read(200).decode("utf-8", "replace")
    return {
        "ok": 200 <= response.status < 300,
        "status": response.status,
        "latencyMs": round((time.time() - started) * 1000),
        "bodyPreview": body,
    }



def safe_read_tail(path, max_bytes=20000):
    try:
        with open(path, "rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - max_bytes), os.SEEK_SET)
            return handle.read().decode("utf-8", "replace")
    except OSError:
        return ""


def redact_sensitive_text(text):
    patterns = [
        (r"https://auth\.x\.ai/oauth2/authorize\?\S+", "[REDACTED_XAI_OAUTH_URL]"),
        (r"http://127\.0\.0\.1:\d+/\S+", "[REDACTED_LOCAL_CALLBACK]"),
        (r"https://open\.feishu\.cn/open-apis/bot/v2/hook/[A-Za-z0-9_-]+", "[REDACTED_FEISHU_WEBHOOK]"),
        (r"https?://[^\s]+/api/push/[A-Za-z0-9_-]+", "[REDACTED_KUMA_PUSH_URL]"),
        (r"(?i)(password|passwd|token|secret|authorization|cookie|api[_-]?key)\s*[:=]\s*\S+", r"\1=[REDACTED]"),
        (r"(?i)(OPS_AUTH_PASSWORD|N8N_PASSWORD|FEISHU_WEBHOOK_URL|KUMA_PUSH_URL)=\S+", r"\1=[REDACTED]"),
        (r"Bearer\s+[A-Za-z0-9._~+/=-]+", "Bearer [REDACTED]"),
        (r"sk-[A-Za-z0-9_-]{16,}", "[REDACTED_API_KEY]"),
    ]
    for pattern, replacement in patterns:
        text = re.sub(pattern, replacement, text)
    return text


def terminal_sessions(limit=12):
    items = []
    if not os.path.isdir(TERMINAL_LOG_DIR):
        return items
    candidates = []
    for name in os.listdir(TERMINAL_LOG_DIR):
        if not name.startswith("session-") or not name.endswith(".log"):
            continue
        path = os.path.join(TERMINAL_LOG_DIR, name)
        try:
            stat = os.stat(path)
        except OSError:
            continue
        candidates.append((stat.st_mtime, stat, name, path))
    for _, stat, name, path in sorted(candidates, reverse=True)[:limit]:
        tail = safe_read_tail(path, 12000)
        items.append({
            "name": name,
            "sizeBytes": stat.st_size,
            "updatedAt": time.strftime("%Y-%m-%d %H:%M:%S %Z", time.localtime(stat.st_mtime)),
            "preview": sanitize_terminal_text(tail)[-1200:],
        })
    return items


def sanitize_terminal_text(text):
    text = re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]", "", text)
    text = re.sub(r"\x1b\].*?(\x07|\x1b\\)", "", text)
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", text)
    return redact_sensitive_text(text)


def terminal_status():
    try:
        output = run(["docker", "ps", "--filter", "name=ops-terminal", "--format", "{{.Names}}\t{{.Status}}"])
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": "ops-terminal" in output and "Up" in output, "raw": output}


def omp_status(sessions=None):
    sessions = sessions if sessions is not None else terminal_sessions(5)
    try:
        probe = run(["docker", "exec", "ops-terminal", "sh", "-lc", "test -s ~/.omp/agent/agent.db && grep -q 'setupWizard: false' ~/.omp/agent/config.yml"])
        db_exists = True
        setup_disabled = True
        error = None
    except Exception as exc:
        db_exists = False
        setup_disabled = False
        error = str(exc)
    recent = ""
    for item in sessions[:5]:
        if item.get("preview"):
            recent = item["preview"]
            break
    payload = {
        "ok": db_exists and setup_disabled,
        "dbExists": db_exists,
        "setupWizardDisabled": setup_disabled,
        "autoModel": "xai-oauth/grok-4.3",
        "recentSessionHasProviderSetup": "Set up your providers" in recent or "Select provider to login" in recent,
        "recentSessionHasReconnectSignal": "process exited with code 1" in recent,
    }
    if error:
        payload["error"] = error
    return payload


def vibe_status_payload():
    terminal = terminal_status()
    sessions = terminal_sessions(8)
    omp = omp_status(sessions)
    return {
        "ok": terminal.get("ok") and omp.get("ok"),
        "terminal": terminal,
        "omp": omp,
        "sessions": sessions,
        "dangerousPatterns": DANGEROUS_PATTERNS,
        "generatedAt": time.strftime("%Y-%m-%d %H:%M:%S %Z"),
    }


def terminal_action_payload(action):
    allowed = {"restart": ["docker", "restart", "ops-terminal"]}
    if action not in allowed:
        return {"ok": False, "error": "unknown action"}
    if action == "restart":
        now = time.time()
        with TERMINAL_ACTION_LOCK:
            elapsed = now - TERMINAL_ACTION_STATE["last_restart"]
            if elapsed < TERMINAL_RESTART_COOLDOWN_SECONDS:
                return {"ok": False, "action": action, "error": "cooldown", "retryAfterSeconds": round(TERMINAL_RESTART_COOLDOWN_SECONDS - elapsed)}
    try:
        output = run(allowed[action])
        if action == "restart":
            with TERMINAL_ACTION_LOCK:
                TERMINAL_ACTION_STATE["last_restart"] = time.time()
        return {"ok": True, "action": action, "output": output, "at": time.strftime("%Y-%m-%d %H:%M:%S %Z")}
    except Exception as exc:
        return {"ok": False, "action": action, "error": str(exc)}


def command_templates():
    return [
        {"label": "全局只读巡检", "prompt": "请只读检查当前 AI Ops 驾驶舱状态，按异常、风险、建议、验收命令输出。"},
        {"label": "查 Docker 问题", "prompt": "请检查 Docker 容器状态、最近异常日志，并给出不执行变更的排查计划。"},
        {"label": "部署前检查", "prompt": "请先检查 git diff、compose 配置、Caddy 路由和回滚点，确认是否可以部署。"},
        {"label": "回滚方案", "prompt": "请基于当前项目给出可执行回滚方案，包含备份、回滚命令、验证标准。"},
        {"label": "写复盘", "prompt": "请根据终端日志和当前 diff 总结本轮改动、踩坑、验收证据和后续 TODO。"},
    ]

def health_payload(component):
    if component == "ai":
        report = build_report()
        return {
            "ok": report["ok"],
            "component": "ai-ops-cockpit",
            "generatedAt": time.strftime("%Y-%m-%d %H:%M:%S %Z"),
            "monitorCount": len([item for item in report["monitors"] if item["active"]]),
            "containerCount": len(report["containers"]),
            "downCount": len([item for item in report["monitors"] if item["active"] and item["status"] != 1]),
            "unhealthyCount": len([item for item in report["containers"] if "Up" not in item["status"]]),
        }
    if component == "n8n":
        probe = probe_url("http://n8n:5678/healthz")
        return {
            "ok": probe["ok"] and "ok" in probe["bodyPreview"],
            "component": "n8n",
            "generatedAt": time.strftime("%Y-%m-%d %H:%M:%S %Z"),
            "probe": probe,
        }
    return {"ok": False, "component": component, "error": "unknown component"}


def send_daily_feishu():
    report = build_report(force=True)
    report = dict(report)
    report["text"] = "AI 运维驾驶舱每日巡检日报\n" + report["text"]
    result = send_feishu(report, force=True)
    save_json_file(DAILY_STATE_FILE, {
        "sentAt": time.strftime("%Y-%m-%d %H:%M:%S %Z"),
        "ok": report["ok"],
        "feishuStatus": result.get("status"),
    })
    return {"ok": True, "feishu": result, "report": report}


def answer_question(question):
    question = (question or "").strip()
    context = ai_context()
    lower = question.lower()
    lines = []
    lines.append("只读回答：")
    if not question:
        lines.append("请先输入问题，例如：当前有哪些异常？备份正常吗？")
    elif any(word in question for word in ["异常", "故障", "down", "不正常", "告警"]):
        down = context["summary"]["downMonitors"]
        unhealthy = context["summary"]["unhealthyContainers"]
        if not down and not unhealthy:
            lines.append("当前没有发现 Kuma DOWN 监控，也没有发现非 Up 的 ops 容器。")
        else:
            if down:
                lines.append("DOWN 监控：" + "；".join(f"{item['name']}({item.get('msg') or ''})" for item in down))
            if unhealthy:
                lines.append("异常容器：" + "；".join(f"{item['name']}({item['status']})" for item in unhealthy))
    elif any(word in question for word in ["备份", "myjavis", "backup"]):
        backups = [item for item in context["kumaMonitors"] if "备份" in item["name"] or "MyJavis" in item["name"]]
        if not backups:
            lines.append("当前上下文里没有找到备份类监控。")
        else:
            for item in backups:
                lines.append(f"{item['name']}：{item['statusText']}，最近消息 {item.get('msg') or '无'}，时间 {item.get('time') or '未知'}。")
    elif any(word in question for word in ["磁盘", "disk", "空间"]):
        mounts = context["summary"]["host"].get("diskGB", {}).get("mounts", [])
        if not mounts:
            lines.append("当前没有采集到磁盘数据。")
        else:
            for item in mounts:
                lines.append(f"{item['mount']}：已用 {item['usedGB']}GB / {item['totalGB']}GB，使用率 {item['usedPercent']}%，剩余 {item['freeGB']}GB。")
    elif any(word in question for word in ["内存", "memory", "ram"]):
        ram = context["summary"]["host"].get("ramMB", {})
        lines.append(f"内存：used {ram.get('used')}MB，free {ram.get('free')}MB，cached {ram.get('cached')}MB。")
    elif any(word in question for word in ["容器", "docker", "服务"]):
        for item in context["containers"]:
            lines.append(f"{item['name']}：{item['status']}")
    else:
        lines.append("当前总状态：" + ("正常" if context["summary"]["ok"] else "需要关注"))
        lines.append("建议复制页面里的 Prompt 给 Grok/OMP 做更深入解释；本站内问答 v0 只做规则化只读回答。")
    lines.append("")
    lines.append("安全边界：我没有执行任何命令，也不会自动重启、删除、升级或改配置。")
    return "\n".join(lines)

def nav_html(active="home"):
    links = [
        ("首页", "/", "home"),
        ("总览", "/ops-dashboard/", "dashboard"),
        ("AI 详情", "/ai/", "ai"),
        ("Vibe Coding", "/vibe/", "vibe"),
        ("终端", "/terminal/", "terminal"),
        ("Kuma", "/ops-app/kuma", "kuma"),
        ("n8n", "/ops-app/n8n", "n8n"),
        ("Netdata", "/ops-app/netdata", "netdata"),
        ("Dockge", "/ops-app/dockge", "dockge"),
    ]
    items = []
    for label, href, key in links:
        class_name = "active" if key == active else ""
        items.append(f'<a class="{class_name}" href="{href}">{html.escape(label)}</a>')
    return '<nav class="topnav">' + ''.join(items) + '</nav>'



def render_ai_page():
    context = ai_context()
    status = "正常" if context["summary"]["ok"] else "需要关注"
    status_class = "ok" if context["summary"]["ok"] else "warn"
    prompt = ai_prompt()
    backup = context.get("backup") or {}
    daily = context.get("lastDaily") or {}
    backup_class = "ok" if backup.get("ok") else "warn"
    backup_message = html.escape(str(backup.get("message") or "暂无备份数据"))
    daily_text = html.escape(str(daily.get("sentAt") or "尚未发送日报"))
    monitor_rows = []
    for monitor in context["kumaMonitors"]:
        row_class = "ok" if monitor["statusText"] == "UP" else "warn"
        monitor_rows.append(
            f"<tr><td>{html.escape(monitor['name'])}</td><td class='{row_class}'>{monitor['statusText']}</td><td>{html.escape(str(monitor.get('msg') or ''))}</td><td>{html.escape(str(monitor.get('time') or ''))}</td></tr>"
        )
    container_rows = []
    for container in context["containers"]:
        container_rows.append(f"<tr><td>{html.escape(container['name'])}</td><td>{html.escape(container['status'])}</td></tr>")
    return f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI 运维助手 v0</title><style>
body{{margin:0;background:#0f172a;color:#e5e7eb;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif}}main{{max-width:1100px;margin:0 auto;padding:32px}}.card{{background:#111827;border:1px solid #334155;border-radius:18px;padding:22px;margin:18px 0;box-shadow:0 20px 60px #0005}}h1{{font-size:34px;margin:0 0 8px}}.muted{{color:#94a3b8}}.ok{{color:#22c55e}}.warn{{color:#f59e0b}}.grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px}}table{{width:100%;border-collapse:collapse}}td,th{{border-bottom:1px solid #263244;padding:10px;text-align:left}}textarea{{width:100%;min-height:360px;background:#020617;color:#d1d5db;border:1px solid #334155;border-radius:12px;padding:14px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}}button,a.btn{{display:inline-block;background:#2563eb;color:white;border:0;border-radius:10px;padding:10px 14px;text-decoration:none;cursor:pointer;margin-right:8px}}code{{background:#020617;padding:2px 6px;border-radius:6px}}.topnav{{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px}}.topnav a{{color:#cbd5e1;text-decoration:none;background:#1f2937;border:1px solid #334155;border-radius:999px;padding:8px 12px}}.topnav a.active{{background:#2563eb;color:white}}</style></head><body><main>
{nav_html("ai")}
<h1>AI 运维助手 v0</h1><p class="muted">只读上下文 + Grok/OMP 提示词入口。当前不执行任何运维动作。</p>
<section class="card grid"><div><div class="muted">总状态</div><h2 class="{status_class}">{status}</h2></div><div><div class="muted">备份</div><h2 class="{backup_class}">{html.escape(str((backup.get('items') or [{'statusText':'未知'}])[0].get('statusText')))}</h2><p class="muted">{backup_message}</p></div><div><div class="muted">主机</div><h2>{html.escape(context['summary']['host']['hostname'])}</h2></div><div><div class="muted">Load</div><h2>{context['summary']['host']['load1']} / {context['summary']['host']['load5']} / {context['summary']['host']['load15']}</h2></div><div><div class="muted">监控数</div><h2>{context['summary']['monitorCount']}</h2></div><div><div class="muted">最后日报</div><h2>{daily_text}</h2></div></section>
<section class="card"><h2>怎么用</h2><p>复制下方提示词，粘到本机 <code>Grok</code> 或 <code>OMP</code> 对话里，即可让 AI 基于当前真实状态做只读分析。</p><button onclick="navigator.clipboard.writeText(document.querySelector('textarea').value)">复制提示词</button><a class="btn" href="/ai/context" target="_blank">查看 JSON</a><a class="btn" href="/ai/prompt" target="_blank">纯文本 Prompt</a><a class="btn" href="/ops-health/ai" target="_blank">健康端点</a></section>
<section class="card"><h2>本机 OMP Bridge 自检</h2><p class="muted">用于确认本机一键问 Grok 的桥接服务是否在线。只访问本机 <code>127.0.0.1:18777</code>，不会把凭据发到服务器。</p><button id="checkBridgeBtn">检测 Bridge</button><span id="bridgeStatus" class="muted">尚未检测</span><pre id="bridgeDetail" style="white-space:pre-wrap;background:#020617;border:1px solid #334155;border-radius:12px;padding:14px"></pre></section>
<section class="card"><h2>站内只读问答 v0</h2><p class="muted">规则化问答，不调用模型、不执行命令。可问：当前有哪些异常？备份正常吗？磁盘空间怎么样？</p><input id="q" style="width:70%;padding:10px;border-radius:10px;border:1px solid #334155;background:#020617;color:#e5e7eb" value="当前有哪些异常？"><button onclick="fetch('/ai/ask?q='+encodeURIComponent(document.getElementById('q').value)).then(r=>r.text()).then(t=>document.getElementById('answer').textContent=t)">规则问答</button><pre id="answer" style="white-space:pre-wrap;background:#020617;border:1px solid #334155;border-radius:12px;padding:14px"></pre></section>
<section class="card"><h2>一键问 OMP / Grok</h2><p class="muted">需要本机先启动 OMP Bridge：<code>python3 /Users/rayman.chen/mycc/2-Projects/ai-ops-cockpit/local-omp-bridge/server.py</code>。Bridge 只监听 127.0.0.1，不把 OMP/Grok 凭据放到服务器。</p><input id="grokq" style="width:70%;padding:10px;border-radius:10px;border:1px solid #334155;background:#020617;color:#e5e7eb" value="请分析当前运维状态，并告诉我最应该关注哪三项。"><button id="askGrokBtn">问 OMP/Grok</button><pre id="grokAnswer" style="white-space:pre-wrap;background:#020617;border:1px solid #334155;border-radius:12px;padding:14px"></pre></section>
<section class="card"><h2>推荐本机命令</h2><p class="muted">为减少 Grok 扫描 mycc 大仓库和 MCP 配置噪音，建议先保存 Prompt 到 /tmp，再从 /tmp 运行。</p><pre style="white-space:pre-wrap;background:#020617;border:1px solid #334155;border-radius:12px;padding:14px">curl -u chuan:你的外层密码 https://ops.hahaxiong.top/ai/prompt -o /tmp/ai-ops-prompt.txt
cd /tmp && grok -p "$(cat /tmp/ai-ops-prompt.txt)" --no-subagents --disable-web-search --max-turns 1
cd /tmp && omp --model xai-oauth/grok-4.3 -p "$(cat /tmp/ai-ops-prompt.txt)"</pre></section>
<section class="card"><h2>AI 提示词</h2><textarea readonly>{html.escape(prompt)}</textarea></section>
<section class="card"><h2>Kuma 监控</h2><table><thead><tr><th>名称</th><th>状态</th><th>消息</th><th>时间</th></tr></thead><tbody>{''.join(monitor_rows)}</tbody></table></section>
<section class="card"><h2>容器</h2><table><thead><tr><th>名称</th><th>状态</th></tr></thead><tbody>{''.join(container_rows)}</tbody></table></section>
<script>
async function checkBridge() {{
  const status = document.getElementById('bridgeStatus');
  const detail = document.getElementById('bridgeDetail');
  status.textContent = '检测中...';
  status.className = 'muted';
  try {{
    const response = await fetch('http://127.0.0.1:18777/health');
    const data = await response.json();
    status.textContent = data.ok ? 'Bridge 在线，可一键问 OMP/Grok' : 'Bridge 返回异常';
    status.className = data.ok ? 'ok' : 'warn';
    detail.textContent = JSON.stringify(data, null, 2);
  }} catch (error) {{
    status.textContent = 'Bridge 不在线';
    status.className = 'warn';
    detail.textContent = '请确认本机 LaunchAgent com.ai-ops.omp-bridge 已启动。\\n' + error;
  }}
}}
document.getElementById('checkBridgeBtn').addEventListener('click', checkBridge);
checkBridge();

document.getElementById('askGrokBtn').addEventListener('click', async () => {{
  const answer = document.getElementById('grokAnswer');
  answer.textContent = '已收到问题，正在调用本机 OMP/Grok...\\n通常需要 30-90 秒，请稍等。';
  try {{
    const response = await fetch('http://127.0.0.1:18777/ask', {{
      method: 'POST',
      headers: {{'content-type': 'application/json'}},
      body: JSON.stringify({{
        question: document.getElementById('grokq').value,
        prompt: document.querySelector('textarea').value
      }})
    }});
    const data = await response.json();
    answer.textContent = data.stdout || data.error || data.stderr || JSON.stringify(data, null, 2);
  }} catch (error) {{
    answer.textContent = '调用失败：请确认本机 OMP Bridge 已启动。\\n' + error;
  }}
}});
</script></main></body></html>""".encode()

def render_home_page():
    data = dashboard_payload()
    backup = data.get("backup") or {}
    metrics = data.get("metrics") or {}
    daily = data.get("lastDaily") or {}
    cache = data.get("cache") or {}
    cache_text = f"缓存：{cache.get('source', 'unknown')} / {cache.get('ageSeconds', 0)}s"
    status_class = "ok" if data.get("ok") else "warn"
    default_question = "现在有什么需要我关注？"
    return f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI 运维驾驶舱</title><style>
body{{margin:0;background:#0f172a;color:#e5e7eb;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif}}main{{max-width:1180px;margin:0 auto;padding:32px}}.hero{{background:linear-gradient(135deg,#111827,#172554);border:1px solid #334155;border-radius:24px;padding:28px;margin-bottom:18px;box-shadow:0 24px 80px #0006}}.grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:16px}}.card{{background:#111827;border:1px solid #334155;border-radius:18px;padding:20px;margin:16px 0;box-shadow:0 20px 60px #0005}}.muted{{color:#94a3b8}}.ok{{color:#22c55e}}.warn{{color:#f59e0b}}a{{color:#93c5fd}}button,a.btn{{display:inline-block;background:#2563eb;color:white;border:0;border-radius:10px;padding:10px 14px;text-decoration:none;cursor:pointer;margin-right:8px}}input,textarea{{width:100%;box-sizing:border-box;padding:12px;border-radius:12px;border:1px solid #334155;background:#020617;color:#e5e7eb}}pre{{white-space:pre-wrap;background:#020617;border:1px solid #334155;border-radius:12px;padding:14px}}.topnav{{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px}}.topnav a{{color:#cbd5e1;text-decoration:none;background:#1f2937;border:1px solid #334155;border-radius:999px;padding:8px 12px}}.topnav a.active{{background:#2563eb;color:white}}
</style></head><body><main>{nav_html("home")}<section class="hero"><h1>AI 运维驾驶舱</h1><p class="muted">一屏看状态，直接问 AI。当前 AI 只读分析，不会执行重启、删除、升级或改配置。</p><div class="grid"><div><div class="muted">总状态</div><h2 class="{status_class}">{html.escape(data['statusText'])}</h2></div><div><div class="muted">备份</div><h2>{html.escape(str(backup.get('message') or '未知'))}</h2></div><div><div class="muted">磁盘</div><h2>{metrics.get('maxDiskUsedPercent')}%</h2></div><div><div class="muted">容器/Kuma</div><h2>异常 {metrics.get('unhealthyCount')} / DOWN {metrics.get('downCount')}</h2></div></div></section><section class="card"><h2>问 AI 运维助手</h2><p class="muted">直接问当前风险、备份、磁盘、容器。调用本机 OMP/Grok Bridge。</p><input id="homeQuestion" value="{html.escape(default_question)}"><p><button id="homeAskBtn">问 AI</button><button id="homeCheckBridgeBtn">检测 Bridge</button><span id="homeBridgeStatus" class="muted">尚未检测</span></p><pre id="homeAnswer">等待提问。提示：页面状态卡会快速显示；AI 回答需要调用 Grok，通常 30-90 秒。</pre></section><section class="grid"><a class="card" href="/ops-dashboard/"><h2>AI Ops 总览</h2><p class="muted">更完整状态卡和 JSON</p></a><a class="card" href="/vibe/"><h2>Vibe Coding 终端</h2><p class="muted">网页终端、项目工作区、远程开发</p></a><a class="card" href="/ops-app/kuma"><h2>Uptime Kuma</h2><p class="muted">监控红绿灯</p></a><a class="card" href="/ops-app/n8n"><h2>n8n 自动化</h2><p class="muted">日报与工作流</p></a><a class="card" href="/ops-app/netdata"><h2>Netdata</h2><p class="muted">资源趋势</p></a><a class="card" href="/ops-app/dockge"><h2>Dockge</h2><p class="muted">服务管理</p></a></section><section class="card"><h2>最后日报</h2><p>{html.escape(str(daily.get('sentAt') or '尚未发送'))}</p><p class="muted">{html.escape(cache_text)}</p></section><textarea id="homePrompt" style="display:none">{html.escape(ai_prompt())}</textarea><script>
async function checkHomeBridge() {{
  const status = document.getElementById('homeBridgeStatus');
  try {{
    const response = await fetch('http://127.0.0.1:18777/health');
    const data = await response.json();
    status.textContent = data.ok ? 'Bridge 在线' : 'Bridge 异常';
    status.className = data.ok ? 'ok' : 'warn';
    return data.ok;
  }} catch (error) {{
    status.textContent = 'Bridge 不在线';
    status.className = 'warn';
    return false;
  }}
}}
document.getElementById('homeCheckBridgeBtn').addEventListener('click', checkHomeBridge);
checkHomeBridge();
document.getElementById('homeAskBtn').addEventListener('click', async () => {{
  const answer = document.getElementById('homeAnswer');
  answer.textContent = '已收到问题，正在调用本机 OMP/Grok...\\n通常需要 30-90 秒，请稍等。';
  try {{
    const response = await fetch('http://127.0.0.1:18777/ask', {{
      method: 'POST',
      headers: {{'content-type':'application/json'}},
      body: JSON.stringify({{question: document.getElementById('homeQuestion').value, prompt: document.getElementById('homePrompt').value}})
    }});
    const data = await response.json();
    answer.textContent = data.stdout || data.error || data.stderr || JSON.stringify(data, null, 2);
  }} catch (error) {{
    answer.textContent = '调用失败：请确认本机 OMP Bridge 已启动。\\n' + error;
  }}
}});
</script></main></body></html>"""



def render_dashboard_page():
    data = dashboard_payload()
    backup = data.get("backup") or {}
    metrics = data.get("metrics") or {}
    daily = data.get("lastDaily") or {}
    cache = data.get("cache") or {}
    cache_text = f"缓存：{cache.get('source', 'unknown')} / {cache.get('ageSeconds', 0)}s"
    status_class = "ok" if data.get("ok") else "warn"
    return f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI Ops 总览</title><style>body{{margin:0;background:#0f172a;color:#e5e7eb;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif}}main{{max-width:1100px;margin:0 auto;padding:32px}}.grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}}.card{{background:#111827;border:1px solid #334155;border-radius:18px;padding:22px;box-shadow:0 20px 60px #0005}}.muted{{color:#94a3b8}}.ok{{color:#22c55e}}.warn{{color:#f59e0b}}a{{color:#93c5fd}}.topnav{{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px}}.topnav a{{color:#cbd5e1;text-decoration:none;background:#1f2937;border:1px solid #334155;border-radius:999px;padding:8px 12px}}.topnav a.active{{background:#2563eb;color:white}}</style></head><body><main>{nav_html("dashboard")}<h1>AI Ops 总览</h1><p class="muted">低代码总览页：正常/异常、备份、磁盘、容器、日报。</p><section class="grid"><div class="card"><div class="muted">总状态</div><h2 class="{status_class}">{html.escape(data['statusText'])}</h2></div><div class="card"><div class="muted">备份状态</div><h2>{html.escape(str(backup.get('message') or '未知'))}</h2></div><div class="card"><div class="muted">磁盘最高使用率</div><h2>{metrics.get('maxDiskUsedPercent')}%</h2></div><div class="card"><div class="muted">容器</div><h2>{metrics.get('containerCount')} 个 / 异常 {metrics.get('unhealthyCount')}</h2></div><div class="card"><div class="muted">Kuma</div><h2>{metrics.get('monitorCount')} 个 / DOWN {metrics.get('downCount')}</h2></div><div class="card"><div class="muted">最后日报</div><h2>{html.escape(str(daily.get('sentAt') or '尚未发送'))}</h2></div></section><p class="muted">{html.escape(cache_text)}</p><p><a href="/ai/">进入 AI 运维助手</a> · <a href="/ops-dashboard.json">查看 JSON</a></p></main></body></html>"""

def workspace_payload():
    projects = [
        {"name": "AI Ops Cockpit", "path": "/workspace/projects/ai-ops-cockpit", "purpose": "运维驾驶舱配置、页面、终端容器", "start": "cd /workspace/projects/ai-ops-cockpit && git status --short"},
        {"name": "mycc", "path": "/workspace/projects/mycc", "purpose": "本机 AI 协作中枢（待接入远程工作副本）", "start": "echo 'mycc 尚未挂载到 ops-terminal；下一步接入 git clone/sshfs 后启用。'"},
        {"name": "个人站", "path": "/workspace/projects/chenchuan-site", "purpose": "个人站开发、构建、部署检查（待挂载）", "start": "echo '个人站尚未挂载到 ops-terminal；下一步接入 git clone/sshfs 后启用。'"},
        {"name": "MyJavis", "path": "/workspace/projects/myjavis", "purpose": "MyJavis 服务、备份、发布相关检查（待挂载）", "start": "echo 'MyJavis 尚未挂载到 ops-terminal；下一步接入 git clone/sshfs 后启用。'"},
        {"name": "Voice Agent", "path": "/workspace/projects/realtime-voice-agent", "purpose": "实时语音 Agent 与声纹链路（待挂载）", "start": "echo 'Voice Agent 尚未挂载到 ops-terminal；下一步接入 git clone/sshfs 后启用。'"},
        {"name": "P003", "path": "/workspace/projects/P003GameDemo20260513", "purpose": "P003 游戏 demo / 实验项目（待挂载）", "start": "echo 'P003 尚未挂载到 ops-terminal；下一步接入 git clone/sshfs 后启用。'"},
        {"name": "Remote Stacks", "path": "/workspace/stacks", "purpose": "远端 Docker Compose stacks", "start": "cd /workspace/stacks && find . -maxdepth 2 -name 'compose*.yml' -o -name 'docker-compose*.yml'"},
        {"name": "Ops Scratchpad", "path": "/workspace/scratch", "purpose": "临时排障记录和命令输出，不放 secret", "start": "mkdir -p /workspace/scratch && cd /workspace/scratch"},
    ]
    servers = [
        {"name": "RackNerd", "target": "本机 ops-terminal 当前宿主", "command": "hostname && uptime && docker ps --format 'table {{.Names}}\t{{.Status}}'"},
        {"name": "阿里云", "target": "按 memory SSH alias 连接", "command": "ssh aliyun 'hostname && uptime'"},
        {"name": "Mini", "target": "家庭 Mini 编排中枢", "command": "ssh mini 'hostname && uptime'"},
        {"name": "NAS", "target": "家庭 NAS / fnOS", "command": "ssh nas 'hostname && uptime'"},
    ]
    commands = [
        {"label": "查看容器", "command": "docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'"},
        {"label": "查看 Compose", "command": "docker compose ls"},
        {"label": "查看终端日志", "command": "ls -lt /var/log/ops-terminal | head"},
        {"label": "进入工作区", "command": "cd /workspace/projects"},
        {"label": "检查权限", "command": "id && sudo -l"},
        {"label": "重启 OMP", "command": "omp --model xai-oauth/grok-4.3 --cwd /workspace/projects/ai-ops-cockpit"},
        {"label": "一键只读巡检", "command": "omp --model xai-oauth/grok-4.3 -p '请只读检查当前 AI Ops 驾驶舱状态，列出异常、风险、建议和验收命令。'"},
        {"label": "首次登录 Grok", "command": "omp auth-broker login xai-oauth"},
    ]
    guardrails = [
        "默认用户 ops：高权限非 root，sudo 免密；需要 root 能力时显式 sudo。",
        "终端会话记录在 /var/log/ops-terminal/session-*.log，用于复盘。",
        "OMP 已安装；Grok OAuth 登录态持久化在 /home/ops/.omp，重建容器不会丢。",
        "不要在终端里粘贴或保存密码、Webhook、Push URL token、API key。",
        "改生产服务前先说明目标、备份点、回滚方式、验收命令。",
        "高危命令命中护栏词时，先停下让 OMP/Codex 给风险说明和回滚方案。",
    ]
    return {"projects": projects, "servers": servers, "commands": commands, "templates": command_templates(), "guardrails": guardrails}


def render_vibe_page():
    payload = workspace_payload()
    status = vibe_status_payload()
    project_cards = "".join(
        f"""<div class=\"card\"><h2>{html.escape(item['name'])}</h2><p class=\"muted\">{html.escape(item['purpose'])}</p><p><code>{html.escape(item['path'])}</code></p><button data-copy=\"{html.escape(item['start'])}\">复制启动命令</button></div>"""
        for item in payload["projects"]
    )
    command_rows = "".join(
        f"""<tr><td>{html.escape(item['label'])}</td><td><code>{html.escape(item['command'])}</code></td><td><button data-copy=\"{html.escape(item['command'])}\">复制</button></td></tr>"""
        for item in payload["commands"]
    )
    server_rows = "".join(
        f"""<tr><td>{html.escape(item['name'])}</td><td>{html.escape(item['target'])}</td><td><code>{html.escape(item['command'])}</code></td><td><button data-copy=\"{html.escape(item['command'])}\">复制</button></td></tr>"""
        for item in payload["servers"]
    )
    template_cards = "".join(
        f"""<div class=\"card\"><h2>{html.escape(item['label'])}</h2><p class=\"muted\">{html.escape(item['prompt'])}</p><button data-copy=\"{html.escape('omp --model xai-oauth/grok-4.3 -p ' + json.dumps(item['prompt'], ensure_ascii=False))}\">复制 OMP 命令</button></div>"""
        for item in payload["templates"]
    )
    session_rows = "".join(
        f"""<tr><td>{html.escape(item['name'])}</td><td>{item['sizeBytes']}</td><td>{html.escape(item['updatedAt'])}</td><td><details><summary>预览</summary><pre>{html.escape(item['preview'])}</pre></details></td></tr>"""
        for item in status["sessions"]
    ) or "<tr><td colspan=4>暂无日志</td></tr>"
    guardrail_items = "".join(f"<li>{html.escape(item)}</li>" for item in payload["guardrails"])
    dangerous = "、".join(DANGEROUS_PATTERNS)
    status_class = "ok" if status["ok"] else "warn"
    return f"""<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Vibe Coding - AI Ops</title><style>
body{{margin:0;background:#0f172a;color:#e5e7eb;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif}}main{{max-width:1280px;margin:0 auto;padding:32px}}.hero{{background:linear-gradient(135deg,#111827,#1e3a8a);border:1px solid #334155;border-radius:24px;padding:28px;margin-bottom:18px;box-shadow:0 24px 80px #0006}}.grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}}.card{{background:#111827;border:1px solid #334155;border-radius:18px;padding:20px;margin:16px 0;box-shadow:0 20px 60px #0005}}.muted{{color:#94a3b8}}.ok{{color:#22c55e}}.warn{{color:#f59e0b}}a{{color:#93c5fd}}button,a.btn{{display:inline-block;background:#2563eb;color:white;border:0;border-radius:10px;padding:10px 14px;text-decoration:none;cursor:pointer;margin:4px 8px 4px 0}}code{{background:#020617;padding:2px 6px;border-radius:6px;word-break:break-all}}table{{width:100%;border-collapse:collapse}}td,th{{border-bottom:1px solid #263244;padding:10px;text-align:left;vertical-align:top}}pre{{white-space:pre-wrap;background:#020617;border:1px solid #334155;border-radius:12px;padding:12px;max-height:280px;overflow:auto}}.topnav{{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px}}.topnav a{{color:#cbd5e1;text-decoration:none;background:#1f2937;border:1px solid #334155;border-radius:999px;padding:8px 12px}}.topnav a.active{{background:#2563eb;color:white}}.terminal{{height:58vh;border:1px solid #334155;border-radius:18px;overflow:hidden;background:#020617}}iframe{{border:0;width:100%;height:100%}}.pill{{display:inline-block;border:1px solid #334155;border-radius:999px;padding:6px 10px;margin:4px;background:#0b1220}}
</style></head><body><main>{nav_html('vibe')}<section class=\"hero\"><h1>Vibe Coding 工作台</h1><p class=\"muted\">打开终端会自动进入 Grok 版 OMP；这里集中项目入口、服务器入口、审计日志、健康检查和操作护栏。</p><p><span class=\"pill {status_class}\">终端/OMP：{html.escape('正常' if status['ok'] else '需要关注')}</span><span class=\"pill\">自动模型：xai-oauth/grok-4.3</span><span class=\"pill\">日志 {len(status['sessions'])} 条</span></p><p><a class=\"btn\" href=\"/terminal/\" target=\"_blank\">新窗口打开终端</a><button id=\"restartTerminalBtn\">重启终端容器</button><a class=\"btn\" href=\"/vibe/status.json\">状态 JSON</a></p><pre id=\"actionResult\">等待操作。</pre></section><section class=\"card\"><h2>内嵌终端</h2><p class=\"muted\">打开后会自动启动 <code>omp --model xai-oauth/grok-4.3</code>。如卡住，先点“重启终端容器”。</p><div class=\"terminal\"><iframe src=\"/terminal/\" title=\"Vibe Terminal\"></iframe></div></section><section><h2>项目入口</h2><div class=\"grid\">{project_cards}</div></section><section class=\"card\"><h2>服务器入口</h2><table><thead><tr><th>服务器</th><th>说明</th><th>命令</th><th>操作</th></tr></thead><tbody>{server_rows}</tbody></table></section><section class=\"card\"><h2>常用命令</h2><table><thead><tr><th>用途</th><th>命令</th><th>操作</th></tr></thead><tbody>{command_rows}</tbody></table></section><section><h2>AI 任务模板</h2><div class=\"grid\">{template_cards}</div></section><section class=\"card\"><h2>审计日志</h2><p class=\"muted\">最近终端日志，只展示尾部预览。完整日志在远端 <code>/opt/ai-ops-cockpit/terminal/logs/</code>。</p><table><thead><tr><th>文件</th><th>大小</th><th>更新时间</th><th>预览</th></tr></thead><tbody>{session_rows}</tbody></table></section><section class=\"card\"><h2>护栏</h2><p class=\"muted\">高危关键词：{html.escape(dangerous)}</p><ul>{guardrail_items}</ul></section></main><script>
document.querySelectorAll('[data-copy]').forEach((button) => {{
  button.addEventListener('click', async () => {{
    await navigator.clipboard.writeText(button.dataset.copy);
    const oldText = button.textContent;
    button.textContent = '已复制';
    setTimeout(() => button.textContent = oldText, 1200);
  }});
}});
document.getElementById('restartTerminalBtn').addEventListener('click', async () => {{
  const result = document.getElementById('actionResult');
  result.textContent = '正在重启 ops-terminal...';
  const response = await fetch('/vibe/action/restart-terminal', {{ method: 'POST', credentials: 'same-origin', headers: {{ 'X-AIOps-Action-Token': '{ACTION_TOKEN}' }} }});
  const data = await response.json();
  result.textContent = JSON.stringify(data, null, 2);
}});
</script></body></html>"""

def render_app_frame(app):
    apps = {
        "kuma": {"title": "Uptime Kuma", "src": "/kuma/", "active": "kuma"},
        "n8n": {"title": "n8n 自动化", "src": "/n8n/", "active": "n8n"},
        "netdata": {"title": "Netdata", "src": "/netdata/", "active": "netdata"},
        "dockge": {"title": "Dockge", "src": "/dockge/", "active": "dockge"},
    }
    config = apps.get(app)
    if not config:
        return None
    return f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{html.escape(config['title'])} - AI Ops</title><style>
html,body{{margin:0;height:100%;background:#0f172a;color:#e5e7eb;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif}}body{{display:flex;flex-direction:column}}.topbar{{padding:12px 16px;background:#111827;border-bottom:1px solid #334155;z-index:10}}.topnav{{display:flex;gap:10px;flex-wrap:wrap;align-items:center}}.topnav a{{color:#cbd5e1;text-decoration:none;background:#1f2937;border:1px solid #334155;border-radius:999px;padding:8px 12px}}.topnav a.active{{background:#2563eb;color:white}}iframe{{border:0;flex:1;width:100%;min-height:0}}.hint{{color:#94a3b8;margin-left:auto}}
</style></head><body><div class="topbar">{nav_html(config['active'])}<span class="hint">如果子应用显示异常，可用浏览器返回或从导航重新进入。</span></div><iframe src="{html.escape(config['src'])}" title="{html.escape(config['title'])}"></iframe></body></html>"""



class Handler(BaseHTTPRequestHandler):
    def _send_json(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_text(self, code, text, content_type="text/plain; charset=utf-8"):
        body = text.encode() if isinstance(text, str) else text
        self.send_response(code)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _is_same_origin_post(self):
        host = self.headers.get("host", "")
        if self.headers.get("x-aiops-action-token") != ACTION_TOKEN:
            return False
        seen_origin_header = False
        for header in ("origin", "referer"):
            value = self.headers.get(header)
            seen_origin_header = seen_origin_header or bool(value)
            if value and urlparse(value).netloc != host:
                return False
        return seen_origin_header

    def do_GET(self):
        path = urlparse(self.path).path
        try:
            if path in ("/", ""):
                self._send_text(200, render_home_page(), "text/html; charset=utf-8")
            elif path == "/health":
                self._send_json(200, {"ok": True})
            elif path == "/summary":
                self._send_json(200, build_report())
            elif path in ("/ops-home", "/ops-home/"):
                self._send_text(200, render_home_page(), "text/html; charset=utf-8")
            elif path == "/ops-health/ai":
                self._send_json(200, health_payload("ai"))
            elif path == "/ops-health/n8n":
                self._send_json(200, health_payload("n8n"))
            elif path == "/ops-dashboard.json":
                self._send_json(200, dashboard_payload())
            elif path in ("/ops-dashboard", "/ops-dashboard/"):
                self._send_text(200, render_dashboard_page(), "text/html; charset=utf-8")
            elif path == "/vibe/workspaces.json":
                self._send_json(200, workspace_payload())
            elif path == "/vibe/status.json":
                self._send_json(200, vibe_status_payload())
            elif path in ("/vibe", "/vibe/"):
                self._send_text(200, render_vibe_page(), "text/html; charset=utf-8")
            elif path.startswith("/ops-app/"):
                app_page = render_app_frame(path.rsplit("/", 1)[-1])
                if app_page is None:
                    self._send_json(404, {"ok": False, "error": "unknown app"})
                else:
                    self._send_text(200, app_page, "text/html; charset=utf-8")
            elif path == "/ai/context":
                self._send_json(200, ai_context())
            elif path == "/ai/prompt":
                self._send_text(200, ai_prompt())
            elif path == "/ai/ask":
                from urllib.parse import parse_qs
                question = parse_qs(urlparse(self.path).query).get("q", [""])[0]
                self._send_text(200, answer_question(question))
            elif path in ("/ai", "/ai/"):
                self._send_text(200, render_ai_page(), "text/html; charset=utf-8")
            elif path == "/send-feishu":
                report = build_report()
                result = send_feishu(report)
                self._send_json(200, {"ok": True, "feishu": result, "report": report})
            elif path == "/send-daily-feishu":
                self._send_json(200, send_daily_feishu())
            else:
                self._send_json(404, {"ok": False, "error": "not found"})
        except Exception as exc:
            traceback.print_exc()
            self._send_json(500, {"ok": False, "error": str(exc)})

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            if not self._is_same_origin_post():
                self._send_json(403, {"ok": False, "error": "cross-origin post rejected"})
                return
            if path == "/vibe/action/restart-terminal":
                self._send_json(200, terminal_action_payload("restart"))
            else:
                self._send_json(404, {"ok": False, "error": "not found"})
        except Exception as exc:
            traceback.print_exc()
            self._send_json(500, {"ok": False, "error": str(exc)})

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args), flush=True)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
