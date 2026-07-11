import html
import json
import os
import re
import secrets
import shlex
import shutil
import sqlite3
import subprocess
import threading
import time
import copy
import traceback
import urllib.request
import urllib.error
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlencode, urlparse

KUMA_DB = os.environ.get("KUMA_DB", "/kuma/kuma.db")
NETDATA = os.environ.get("NETDATA_URL", "http://netdata:19999")
DISPLAY_HOSTNAME = os.environ.get("DISPLAY_HOSTNAME", "racknerd-54aa08d")
STATE_DIR = os.environ.get("STATE_DIR", "/tmp/ai-ops-state")
ALERT_STATE_FILE = os.path.join(STATE_DIR, "alert-state.json")
DAILY_STATE_FILE = os.path.join(STATE_DIR, "daily-state.json")
SNAPSHOT_FILE = os.path.join(STATE_DIR, "last-report.json")
CACHE_TTL_SECONDS = int(os.environ.get("CACHE_TTL_SECONDS", "15"))
REPORT_CACHE = {"ts": 0, "data": None}
ASSETS_CACHE = {"ts": 0, "data": None}
TERMINAL_LOG_DIR = os.environ.get("TERMINAL_LOG_DIR", "/terminal-logs")
DANGEROUS_PATTERNS = ["rm -rf", "docker compose down", "docker rm", "docker volume rm", "ufw ", "iptables", "mkfs", "drop database", "truncate table", ":(){", "reboot", "shutdown"]
TERMINAL_ACTION_LOCK = threading.Lock()
TERMINAL_ACTION_STATE = {"last_restart": 0}
TERMINAL_RESTART_COOLDOWN_SECONDS = int(os.environ.get("TERMINAL_RESTART_COOLDOWN_SECONDS", "30"))
ACTION_TOKEN = os.environ.get("OPS_ACTION_TOKEN") or secrets.token_urlsafe(24)
READ_TOKEN = os.environ.get("OPS_READ_TOKEN") or ACTION_TOKEN
ACTION_HEADER = "x-aiops-action-token"
READ_HEADER = "x-aiops-read-token"
TASKS_DIR = os.path.join(STATE_DIR, "vibe-tasks")
TODOS_DIR = os.path.join(STATE_DIR, "vibe-todos")
CONVERSATIONS_DIR = os.path.join(STATE_DIR, "vibe-conversations")
PILOT_JOBS_DIR = os.path.join(STATE_DIR, "vibe-pilot-jobs")
TODO_JOBS_DIR = os.path.join(STATE_DIR, "vibe-todo-jobs")
PROJECT_DAILY_DIR = os.path.join(STATE_DIR, "project-daily")
PROJECT_PRODUCTION_DIR = os.path.join(STATE_DIR, "project-production")
READONLY_STATE_FILE = os.path.join(STATE_DIR, "readonly-refresh.json")
WORKSPACE_ROOT = os.environ.get("WORKSPACE_ROOT", "/workspace/projects")
READONLY_ROOT = os.environ.get("READONLY_ROOT", "/workspace/readonly")
ALLOWLIST_DIR = os.environ.get("ALLOWLIST_DIR", "/config")
PRODUCTION_SSH_DIR = os.environ.get("PRODUCTION_SSH_DIR", "/run/secrets/chenchuan-maintenance")
PROJECT_CONTEXT_MAX_CHARS = int(os.environ.get("PROJECT_CONTEXT_MAX_CHARS", "280000"))
PROJECT_CONTEXT_FILE_MAX_CHARS = int(os.environ.get("PROJECT_CONTEXT_FILE_MAX_CHARS", "22000"))
TASK_LOCK = threading.Lock()
TASK_STATE = {"last_run": 0}
TASK_COOLDOWN_SECONDS = int(os.environ.get("TASK_COOLDOWN_SECONDS", "20"))
PILOT_JOB_LOCK = threading.Lock()
TODO_JOB_LOCK = threading.Lock()
PROJECT_DAILY_LOCK = threading.Lock()
PROJECT_DAILY_ACTIVE = set()
PROJECT_PRODUCTION_LOCK = threading.Lock()
PROJECT_PRODUCTION_ACTIVE = set()
PROJECT_RESTART_COOLDOWN_SECONDS = int(os.environ.get("PROJECT_RESTART_COOLDOWN_SECONDS", "600"))
ASSETS_CACHE_TTL_SECONDS = int(os.environ.get("ASSETS_CACHE_TTL_SECONDS", "20"))
READONLY_REFRESH_LOCK = threading.Lock()

PROJECT_LIVE_PROBES = {
    "chenchuan-site": [
        {"id": "home", "name": "首页", "path": "/", "marker": "<title>陈川 · AI 原生产品负责人", "kind": "html"},
        {"id": "radar", "name": "AI 前沿资讯雷达", "path": "/radar", "marker": "<title>AI 前沿资讯雷达 · 陈川", "kind": "html"},
        {"id": "videos", "name": "视频库", "path": "/videos", "marker": "<title>视频 · 陈川", "kind": "html"},
        {"id": "ai-chat", "name": "Talk With My AI", "path": "/ai-os/chat", "marker": "<title>Talk With My AI · 陈川的战略镜像 · 陈川", "kind": "html"},
        {"id": "ar-hud", "name": "AR HUD Demo", "path": "/lab/ar-hud-demo", "marker": "<title>AR HUD Demo · 多模态交互沙盒 · 陈川", "kind": "html"},
        {"id": "video-sample", "name": "视频样本资源", "path": "/media-optimized/eye-gesture-interaction/20260319-090647.mp4", "kind": "binary", "contentTypePrefix": "video/"},
    ],
}

PROJECT_DAILY_PUSH_URLS = {
    "chenchuan-site": os.environ.get("CHENCHUAN_DAILY_PUSH_URL", ""),
}


def load_allowlist_file(name, fallback):
    path = os.path.join(ALLOWLIST_DIR, name + "-allowlist.txt")
    try:
        items = []
        with open(path, encoding="utf-8") as file:
            for raw_line in file:
                line = raw_line.strip()
                if not line or line.startswith("#"):
                    continue
                normalized = os.path.normpath(line).replace("\\", "/")
                if normalized.startswith("../") or normalized.startswith("/") or normalized == "..":
                    continue
                items.append(normalized)
        return items or list(fallback)
    except OSError:
        return list(fallback)


CHENCHUAN_SITE_FALLBACK_ALLOWLIST = [
    "README.md",
    "package.json",
    "tsconfig.json",
    "next.config.ts",
    "Dockerfile",
]


PROJECT_ALLOWLIST = {
    "mycc": [
        "AGENTS.md",
        "CLAUDE.md",
        "README.md",
        "docs/rules/SCHEMA.md",
        "docs/rules/CONTEXT-BUDGET.md",
        "docs/rules/FEISHU-FALLBACK.md",
        "2-Projects/ai-ops-cockpit/README.md",
        "2-Projects/ai-ops-cockpit/compose.yaml",
        "2-Projects/ai-ops-cockpit/caddy/Caddyfile",
        "2-Projects/ai-ops-cockpit/ops-inspector/server.py",
        "2-Projects/ai-ops-cockpit/scripts/validate-vibe-regression.sh",
        "2-Projects/ai-ops-cockpit/scripts/sync-readonly-workspaces.sh",
        "2-Projects/ai-ops-cockpit/scripts/install-readonly-refresh-cron.sh",
        "2-Projects/ai-ops-cockpit/terminal/Dockerfile",
        "2-Projects/ai-ops-cockpit/terminal/vibe-bashrc",
        "2-Projects/ai-ops-cockpit/terminal/vibe-omp",
        "2-Projects/ai-ops-cockpit/terminal/vibe-shell",
    ],
    "chenchuan-site": load_allowlist_file("chenchuan-site", CHENCHUAN_SITE_FALLBACK_ALLOWLIST),
    "MyJavis": [
        "README.md",
        "HANDOFF.md",
        "package.json",
        "pnpm-workspace.yaml",
        "apps/server/package.json",
        "apps/server/tsconfig.json",
        "apps/web/package.json",
        "apps/web/tsconfig.json",
        "apps/web/vite.config.ts",
        "apps/web/index.html",
    ],
    "realtime-voice-agent": [],
    "P003GameDemo20260513": [],
}

PILOT_WORKFLOW_MATRIX = {
    "readonly_inspect": {
        "name": "只读巡检",
        "permission": "read_only",
        "allowed": ["读取 allowlist 文件", "查看只读快照", "列风险", "给验收命令"],
        "blocked": ["写文件", "重启服务", "改配置", "commit/push"],
    },
    "plan_design": {
        "name": "方案设计",
        "permission": "no_write",
        "allowed": ["读上下文", "提出方案", "拆待办", "列回滚点"],
        "blocked": ["直接改代码", "直接部署", "改 secrets"],
    },
    "patch_draft": {
        "name": "补丁草案",
        "permission": "draft_only",
        "allowed": ["生成 diff 草案", "列测试命令", "说明风险"],
        "blocked": ["自动写入真实项目", "自动 commit/push", "自动部署"],
    },
    "deploy_verify": {
        "name": "部署验收",
        "permission": "confirm_first",
        "allowed": ["列部署步骤", "列回滚命令", "执行已授权验收"],
        "blocked": ["未确认的生产变更", "破坏性 Docker/DB 操作"],
    },
}

PILOT_PROJECTS = {
    "chenchuan-site": {
        "name": "chenchuan-site",
        "path": "/workspace/readonly/chenchuan-site",
        "risk": "低风险：只读巡检公开页面、组件和安全业务逻辑；后台、API 鉴权、数据库、环境变量与媒体原文件保持隔离。",
        "goal": "基于真实只读源码确认个人站结构、部署线索、潜在风险和下一步低风险优化。",
        "firstWorkflow": "readonly_inspect",
        "production": {
            "domain": "https://my.chenchuan.cc",
            "sshAlias": "aliyun-kr",
            "address": "8.213.134.133",
            "maintenanceUser": "aiops",
            "maintenancePort": 52022,
            "path": "/var/www/chenchuan-site",
            "processManager": "PM2",
            "process": "chenchuan-site",
            "verifiedAt": "2026-07-10",
        },
    },
    "MyJavis": {
        "name": "MyJavis",
        "path": "/workspace/readonly/MyJavis",
        "risk": "中风险：仅允许读 README/HANDOFF/package/tsconfig/vite/index，禁止数据库和 secrets。",
        "goal": "确认 MyJavis 当前结构、备份关联点、可观测性缺口和下一步方案。",
        "firstWorkflow": "readonly_inspect",
    },
}



def run(cmd):
    return subprocess.check_output(cmd, text=True, timeout=10).strip()


def run_quiet(cmd, timeout=10):
    return subprocess.check_output(cmd, text=True, stderr=subprocess.STDOUT, timeout=timeout).strip()


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


def ensure_private_dir(path):
    os.makedirs(path, mode=0o700, exist_ok=True)
    try:
        os.chmod(path, 0o700)
    except OSError:
        pass


def load_json_file(path, default):
    try:
        with open(path, encoding="utf-8") as file:
            return json.load(file)
    except Exception:
        return default


def save_json_file(path, payload):
    ensure_state_dir()
    tmp_path = f"{path}.{os.getpid()}.{threading.get_ident()}.tmp"
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


def send_feishu_text(text):
    webhook = os.environ.get("FEISHU_WEBHOOK_URL")
    if not webhook:
        return {"status": "skipped", "body": "FEISHU_WEBHOOK_URL is not configured"}
    payload = json.dumps({"msg_type": "text", "content": {"text": text}}, ensure_ascii=False).encode()
    request = urllib.request.Request(webhook, data=payload, headers={"content-type": "application/json"}, method="POST")
    with urllib.request.urlopen(request, timeout=15) as response:
        body = response.read().decode("utf-8", "replace")
    return {"status": response.status, "body": body}


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


def compact_task_answer(value, limit=18000):
    text = sanitize_terminal_text(value or "")
    if len(text) <= limit:
        return text
    head_chars = limit // 3
    tail_chars = limit - head_chars
    return text[:head_chars] + "\n[OUTPUT_TRUNCATED_MIDDLE]\n" + text[-tail_chars:]


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
        raw = run(["docker", "exec", "ops-terminal", "python3", "-c", """
import json, sqlite3
db='/home/ops/.omp/agent/agent.db'
cfg='/home/ops/.omp/agent/config.yml'
result={'dbExists': False, 'setupWizardDisabled': False, 'credentialReady': False, 'disabledCause': None}
try:
    open(db, 'rb').close(); result['dbExists'] = True
    result['setupWizardDisabled'] = 'setupWizard: false' in open(cfg, encoding='utf-8').read()
    conn = sqlite3.connect(db)
    row = conn.execute(\"select disabled_cause from auth_credentials where provider='xai-oauth' order by updated_at desc limit 1\").fetchone()
    if row:
        result['disabledCause'] = row[0]
        result['credentialReady'] = row[0] in (None, '')
except Exception as exc:
    result['error'] = str(exc)
print(json.dumps(result, ensure_ascii=False))
"""])
        credential = json.loads(raw)
        db_exists = credential.get("dbExists", False)
        setup_disabled = credential.get("setupWizardDisabled", False)
        credential_ready = credential.get("credentialReady", False)
        disabled_cause = credential.get("disabledCause")
        error = credential.get("error")
    except Exception as exc:
        db_exists = False
        setup_disabled = False
        credential_ready = False
        disabled_cause = None
        error = str(exc)
    recent = ""
    for item in sessions[:5]:
        if item.get("preview"):
            recent = item["preview"]
            break
    payload = {
        "ok": db_exists and setup_disabled and credential_ready,
        "dbExists": db_exists,
        "setupWizardDisabled": setup_disabled,
        "credentialReady": credential_ready,
        "disabledCause": redact_sensitive_text(disabled_cause or "") or None,
        "autoModel": "xai-oauth/grok-4.5",
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


def workspace_readiness(status):
    matrix = {
        "ready_readonly": (100, "只读接入可用"),
        "mounted_readonly_no_git": (85, "只读目录可用但非 git"),
        "ready_writable": (0, "阻断：可写挂载，需改只读"),
        "mounted_no_git": (50, "已挂载但非 git"),
        "error": (20, "探测异常"),
        "not_mounted": (None, "待接入"),
    }
    return matrix.get(status, (None, "未知状态"))


def display_value(value):
    return "-" if value is None else str(value)


def workspace_status_payload():
    items = []
    for project in workspace_payload()["projects"]:
        path = project["path"]
        exists = False
        git = False
        status = "not_mounted"
        details = ""
        if path.startswith(WORKSPACE_ROOT) or path.startswith(READONLY_ROOT):
            try:
                quoted_path = shlex.quote(path)
                output = run_quiet(["docker", "exec", "ops-terminal", "bash", "-lc", f"test -d {quoted_path} && echo exists || true; test -d {quoted_path}/.git && echo git || true; test -w {quoted_path} || echo readonly"], timeout=6)
                exists = "exists" in output.splitlines()
                git = "git" in output.splitlines()
                readonly = "readonly" in output.splitlines()
                if exists and git:
                    status = "ready_readonly" if readonly else "ready_writable"
                    details = run_quiet(["docker", "exec", "ops-terminal", "bash", "-lc", f"cd {quoted_path} && git status --short --branch | head -n 12"], timeout=8)
                elif exists:
                    status = "mounted_readonly_no_git" if readonly else "mounted_no_git"
                details = sanitize_terminal_text(details)
            except Exception as exc:
                status = "error"
                details = str(exc)
        score, risk = workspace_readiness(status)
        items.append({**project, "exists": exists, "git": git, "status": status, "readinessScore": score, "risk": risk, "details": details})
    return {"workspaces": items, "generatedAt": time.strftime("%Y-%m-%d %H:%M:%S %Z")}


def servers_matrix_payload():
    report = build_report()
    docker = report.get("containers", [])
    disks = report.get("disk", {}).get("mounts", [])
    monitors = [item for item in report.get("monitors", []) if item.get("active")]
    racknerd = {
        "name": "RackNerd",
        "role": "AI Ops 当前宿主",
        "status": "UP" if report.get("ok") else "WARN",
        "containers": len(docker),
        "unhealthy": len([item for item in docker if "Up" not in item.get("status", "")]),
        "maxDiskUsedPercent": max([item.get("usedPercent") or 0 for item in disks] or [None]),
        "monitorsDown": len([item for item in monitors if item.get("status") != 1]),
        "lastChecked": report.get("generatedAt"),
    }
    disk_used = racknerd["maxDiskUsedPercent"] or 0
    racknerd["readinessScore"] = max(0, 100 - racknerd["unhealthy"] * 20 - racknerd["monitorsDown"] * 20 - max(0, disk_used - 70))
    racknerd["risk"] = "探测项未见异常（非业务健康结论）" if racknerd["readinessScore"] >= 90 else "需关注：容器/监控/磁盘存在扣分项"
    planned = remote_server_matrix()
    return {"servers": [racknerd] + planned, "generatedAt": time.strftime("%Y-%m-%d %H:%M:%S %Z")}


def remote_server_matrix():
    items = []
    for name, alias, role in [
        ("阿里云", "aliyun", "待接 SSH 只读巡检"),
        ("Mini", "mini", "家庭编排中枢"),
        ("NAS", "nas", "fnOS/NAS"),
    ]:
        status = "待接入"
        risk = "SSH 只读探测未配置或不可达"
        readiness = None
        try:
            output = run_quiet(["docker", "exec", "ops-terminal", "bash", "-lc", f"timeout 6 ssh -o BatchMode=yes -o ConnectTimeout=3 {shlex.quote(alias)} 'hostname && uptime'"], timeout=8)
            if output:
                status = "UP"
                risk = "SSH 只读探测可用"
                readiness = 80
        except Exception:
            pass
        items.append({"name": name, "role": role, "status": status, "containers": None, "unhealthy": None, "maxDiskUsedPercent": None, "monitorsDown": None, "lastChecked": time.strftime("%Y-%m-%d %H:%M:%S %Z"), "readinessScore": readiness, "risk": risk})
    return items


def assets_payload(force=False):
    now = time.time()
    if not force and ASSETS_CACHE["data"] is not None and now - ASSETS_CACHE["ts"] < ASSETS_CACHE_TTL_SECONDS:
        cached = copy.deepcopy(ASSETS_CACHE["data"])
        cached["cache"] = {"hit": True, "source": "memory", "ageSeconds": round(now - ASSETS_CACHE["ts"], 2), "ttlSeconds": ASSETS_CACHE_TTL_SECONDS}
        return cached
    data = {**servers_matrix_payload(), **workspace_status_payload()}
    data["cache"] = {"hit": False, "source": "live", "ageSeconds": 0, "ttlSeconds": ASSETS_CACHE_TTL_SECONDS}
    ASSETS_CACHE["ts"] = now
    ASSETS_CACHE["data"] = copy.deepcopy(data)
    return copy.deepcopy(data)


def readonly_refresh_status():
    state = load_json_file(READONLY_STATE_FILE, {}) or {}
    try:
        raw = run_quiet(["docker", "exec", "ops-terminal", "bash", "-lc", "test -d /workspace/readonly/mycc && stat -c '%y' /workspace/readonly/mycc 2>/dev/null | cut -d. -f1 || true"], timeout=6)
        if raw:
            state["mountedAt"] = raw.strip()
        state["mounted"] = bool(raw)
    except Exception as exc:
        state["mounted"] = False
        state["error"] = str(exc)
    return state


def refresh_readonly_payload():
    if not READONLY_REFRESH_LOCK.acquire(blocking=False):
        return {"ok": False, "error": "refresh already running"}
    started = time.time()
    try:
        try:
            output = run_quiet(["docker", "exec", "ops-terminal", "bash", "-lc", "cd /workspace/projects/ai-ops-cockpit && if [ -x scripts/sync-readonly-workspaces.sh ]; then AI_OPS_ROOT=/workspace/projects/ai-ops-cockpit scripts/sync-readonly-workspaces.sh; else echo 'sync script missing'; exit 1; fi"], timeout=120)
            payload = {"ok": True, "refreshedAt": time.strftime("%Y-%m-%d %H:%M:%S %Z"), "durationMs": round((time.time() - started) * 1000), "output": sanitize_terminal_text(output)[-2000:]}
        except Exception as exc:
            payload = {"ok": False, "refreshedAt": time.strftime("%Y-%m-%d %H:%M:%S %Z"), "durationMs": round((time.time() - started) * 1000), "error": sanitize_terminal_text(str(exc))}
        save_json_file(READONLY_STATE_FILE, payload)
        global ASSETS_CACHE
        ASSETS_CACHE = {"ts": 0, "data": None}
        return payload
    finally:
        READONLY_REFRESH_LOCK.release()


def allowlist_payload():
    return {
        "policy": "真实项目默认占位；接入前必须文件级 allowlist，禁止目录级同步整仓。",
        "projects": [
            {"name": name, "fileCount": len(files), "status": "enabled" if files else "placeholder_only", "files": files}
            for name, files in PROJECT_ALLOWLIST.items()
        ],
        "generatedAt": time.strftime("%Y-%m-%d %H:%M:%S %Z"),
    }


def pilot_payload():
    projects = []
    for key, item in PILOT_PROJECTS.items():
        context = build_project_context(key)
        projects.append(dict(
            item,
            allowlist=PROJECT_ALLOWLIST.get(key, []),
            context={name: value for name, value in context.items() if name != "prompt"},
        ))
    return {
        "policy": "实战试点默认只读；先跑低风险项目巡检，再由 Codex/cc 收口执行任何写入。",
        "acceptance": [
            "Grok 输出必须包含 O1/O2、Plan、Check、Action。",
            "只能引用 allowlist 文件和只读快照路径。",
            "任何写入、部署、commit、push 都必须先生成计划、风险、回滚点和验收命令。",
            "任务结果进入 /vibe/tasks，可再转入 /vibe/todos。",
        ],
        "projects": projects,
        "workflowMatrix": [dict({"id": key}, **value) for key, value in PILOT_WORKFLOW_MATRIX.items()],
        "generatedAt": time.strftime("%Y-%m-%d %H:%M:%S %Z"),
    }


def extract_sections(text):
    text = redact_sensitive_text(sanitize_terminal_text(text or ""))
    markers = [
        ("objective", ["O1", "目标"]),
        ("constraints", ["O2", "约束"]),
        ("plan", ["Plan", "计划"]),
        ("observations", ["Do", "观察", "执行"]),
        ("checks", ["Check", "验收"]),
        ("actions", ["Action", "沉淀", "下一步"]),
    ]
    result = {key: "" for key, _ in markers}
    lines = text.splitlines()
    current = None
    for line in lines:
        clean = line.strip().strip("#*-：: ")
        for key, aliases in markers:
            if any(clean.lower().startswith(alias.lower()) for alias in aliases):
                current = key
                break
        if current:
            result[current] = (result[current] + "\n" + line).strip()[-900:]
    result["hasRequiredSections"] = all(bool(result[key]) for key, _ in markers[:2]) and bool(result["plan"]) and bool(result["checks"]) and bool(result["actions"])
    return result


def task_structured_summary(task):
    answer = task.get("answer") or ""
    sections = extract_sections(answer)
    return {
        "taskId": task.get("id"),
        "modeName": task.get("modeName"),
        "ok": task.get("ok"),
        "createdAt": task.get("createdAt"),
        "sections": sections,
        "riskSignals": [word for word in ["风险", "异常", "失败", "缺失", "需要", "建议"] if word in answer][:8],
        "acceptanceReady": sections.get("hasRequiredSections"),
    }


def project_workspace_panel(project_id):
    project_id = (project_id or "").strip()
    project = PILOT_PROJECTS.get(project_id)
    if not project:
        return None
    allowlist = PROJECT_ALLOWLIST.get(project_id, [])
    todos = [item for item in todo_history(100) if item.get("project") == project_id or project_id in json.dumps(item, ensure_ascii=False)]
    tasks = [item for item in task_history(100) if item.get("project") == project_id or project_id in json.dumps(item, ensure_ascii=False)]
    context = build_project_context(project_id)
    return {
        "ok": True,
        "project": dict(project, allowlist=allowlist, allowlistCount=len(allowlist)),
        "context": {key: value for key, value in context.items() if key != "prompt"},
        "dailyInspection": project_daily_status_payload(project_id),
        "productionMaintenance": project_production_status_payload(project_id),
        "recentTasks": [{"id": item.get("id"), "ok": item.get("ok"), "modeName": item.get("modeName"), "createdAt": item.get("createdAt")} for item in tasks[:10]],
        "openTodos": [{"id": item.get("id"), "status": item.get("status"), "title": item.get("title"), "createdAt": item.get("createdAt")} for item in todos if item.get("status") != "done"],
        "workflowMatrix": [dict({"id": key}, **value) for key, value in PILOT_WORKFLOW_MATRIX.items()],
        "generatedAt": time.strftime("%Y-%m-%d %H:%M:%S %Z"),
    }


def build_project_context(project_id):
    project_id = (project_id or "").strip()
    allowlist = PROJECT_ALLOWLIST.get(project_id)
    if allowlist is None:
        return {"ok": False, "error": "unknown project", "files": [], "missing": [], "chars": 0, "truncated": False, "prompt": ""}
    readonly_base = os.path.realpath(READONLY_ROOT)
    project_root = os.path.realpath(os.path.join(readonly_base, project_id))
    if project_root != readonly_base and not project_root.startswith(readonly_base + os.sep):
        return {"ok": False, "error": "invalid project path", "files": [], "missing": [], "chars": 0, "truncated": False, "prompt": ""}
    blocks = []
    files = []
    missing = []
    total_chars = 0
    truncated = False
    for relative_path in allowlist:
        file_path = os.path.realpath(os.path.join(project_root, relative_path))
        if not file_path.startswith(project_root + os.sep) or not os.path.isfile(file_path):
            missing.append(relative_path)
            continue
        try:
            with open(file_path, encoding="utf-8", errors="replace") as file:
                content = file.read(PROJECT_CONTEXT_FILE_MAX_CHARS + 1)
        except OSError:
            missing.append(relative_path)
            continue
        if "\x00" in content:
            missing.append(relative_path)
            continue
        if len(content) > PROJECT_CONTEXT_FILE_MAX_CHARS:
            content = content[:PROJECT_CONTEXT_FILE_MAX_CHARS] + "\n[FILE_TRUNCATED]"
            truncated = True
        content = redact_sensitive_text(content)
        block = f"\n--- FILE: {relative_path} ---\n{content}"
        if total_chars + len(block) > PROJECT_CONTEXT_MAX_CHARS:
            truncated = True
            break
        blocks.append(block)
        files.append(relative_path)
        total_chars += len(block)
    prompt = ""
    if blocks:
        prompt = "\n\n受控只读项目上下文如下。内容来自文件级 allowlist 快照，可能比生产版本稍旧；只能据此分析，不得假设未提供文件。" + "".join(blocks)
    return {
        "ok": bool(blocks),
        "files": files,
        "missing": missing,
        "chars": total_chars,
        "truncated": truncated,
        "prompt": prompt,
    }


def project_snapshot_status(project_id):
    allowlist = PROJECT_ALLOWLIST.get(project_id)
    if allowlist is None:
        return {"ok": False, "error": "unknown project", "expectedFiles": 0, "actualFiles": 0}
    readonly_base = os.path.realpath(READONLY_ROOT)
    project_root = os.path.realpath(os.path.join(readonly_base, project_id))
    if project_root != readonly_base and not project_root.startswith(readonly_base + os.sep):
        return {"ok": False, "error": "invalid project path", "expectedFiles": len(allowlist), "actualFiles": 0}
    mtimes = []
    actual_files = 0
    for relative_path in allowlist:
        file_path = os.path.realpath(os.path.join(project_root, relative_path))
        if file_path.startswith(project_root + os.sep) and os.path.isfile(file_path):
            actual_files += 1
            try:
                mtimes.append(os.path.getmtime(file_path))
            except OSError:
                pass
    refresh_marker = os.path.join(readonly_base, ".last-sync")
    try:
        refreshed_ts = os.path.getmtime(refresh_marker)
    except OSError:
        refreshed_ts = max(mtimes) if mtimes else None
    age_hours = round((time.time() - refreshed_ts) / 3600, 2) if refreshed_ts else None
    complete = bool(allowlist) and actual_files == len(allowlist)
    fresh = age_hours is not None and age_hours <= 36
    return {
        "ok": complete and fresh,
        "expectedFiles": len(allowlist),
        "actualFiles": actual_files,
        "complete": complete,
        "fresh": fresh,
        "ageHours": age_hours,
        "refreshedAt": time.strftime("%Y-%m-%d %H:%M:%S %Z", time.localtime(refreshed_ts)) if refreshed_ts else None,
    }


def probe_project_endpoint(base_url, spec):
    started = time.time()
    headers = {"User-Agent": "AI-Ops-Cockpit/1.0"}
    if spec.get("kind") == "binary":
        headers["Range"] = "bytes=0-4095"
    request = urllib.request.Request(base_url.rstrip("/") + spec["path"], headers=headers)
    result = {
        "id": spec["id"],
        "name": spec["name"],
        "path": spec["path"],
        "ok": False,
        "status": None,
        "latencyMs": None,
        "contentType": None,
    }
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            body = response.read(131072 if spec.get("kind") == "html" else 4096)
            result["status"] = response.status
            result["contentType"] = (response.headers.get("content-type") or "").split(";", 1)[0]
        result["bytes"] = len(body)
        status_ok = 200 <= result["status"] < 300
        if spec.get("kind") == "binary":
            result["ok"] = status_ok and result["contentType"].startswith(spec.get("contentTypePrefix", ""))
        else:
            marker_ok = spec.get("marker", "").encode("utf-8") in body
            result["markerOk"] = marker_ok
            result["ok"] = status_ok and marker_ok
    except urllib.error.HTTPError as exc:
        result["status"] = exc.code
        result["error"] = "HTTPError"
    except Exception as exc:
        result["error"] = type(exc).__name__
    result["latencyMs"] = round((time.time() - started) * 1000)
    return result


def project_live_check(project_id, simulate_failure=False):
    project = PILOT_PROJECTS.get(project_id)
    probes = PROJECT_LIVE_PROBES.get(project_id)
    if not project or not probes or not (project.get("production") or {}).get("domain"):
        return {"ok": False, "error": "project live probes not configured", "checks": [], "total": 0, "passed": 0}
    checks = [probe_project_endpoint(project["production"]["domain"], spec) for spec in probes]
    if simulate_failure and checks:
        checks[0] = dict(checks[0], ok=False, status=599, error="SimulatedFailure")
    failed_ids = [item["id"] for item in checks if not item.get("ok")]
    return {
        "ok": not failed_ids,
        "project": project_id,
        "generatedAt": time.strftime("%Y-%m-%d %H:%M:%S %Z"),
        "simulated": bool(simulate_failure),
        "passed": len(checks) - len(failed_ids),
        "total": len(checks),
        "failedIds": failed_ids,
        "checks": checks,
    }


def production_channel_files():
    return {
        "identity": os.path.join(PRODUCTION_SSH_DIR, "id_ed25519"),
        "knownHosts": os.path.join(PRODUCTION_SSH_DIR, "known_hosts"),
    }


def production_channel_configured(project_id):
    project = PILOT_PROJECTS.get(project_id) or {}
    production = project.get("production") or {}
    files = production_channel_files()
    return bool(
        production.get("address")
        and production.get("maintenanceUser")
        and production.get("maintenancePort")
        and os.path.isfile(files["identity"])
        and os.path.isfile(files["knownHosts"])
    )


def sanitize_production_inspection(payload):
    process = payload.get("process") or {}
    deployment = payload.get("deployment") or {}
    host = payload.get("host") or {}
    return {
        "ok": bool(payload.get("ok")),
        "generatedAt": payload.get("generatedAt"),
        "hostname": str(payload.get("hostname") or "")[:120],
        "process": {
            "name": str(process.get("name") or "")[:120],
            "status": str(process.get("status") or "")[:40],
            "pid": process.get("pid"),
            "restartCount": process.get("restartCount"),
            "uptimeSeconds": process.get("uptimeSeconds"),
            "cpuPercent": process.get("cpuPercent"),
            "memoryMB": process.get("memoryMB"),
        },
        "deployment": {
            "path": str(deployment.get("path") or "")[:240],
            "buildId": str(deployment.get("buildId") or "")[:100] or None,
            "deployedAt": deployment.get("deployedAt"),
        },
        "host": {
            "load1": host.get("load1"),
            "diskUsedPercent": host.get("diskUsedPercent"),
            "diskFreeGB": host.get("diskFreeGB"),
        },
    }


def run_production_command(project_id, action):
    if action not in {"inspect", "restart"}:
        return {"ok": False, "error": "production action not allowed"}
    project = PILOT_PROJECTS.get(project_id) or {}
    production = project.get("production") or {}
    if not production_channel_configured(project_id):
        return {"ok": False, "error": "maintenance channel not configured"}
    files = production_channel_files()
    command = [
        "ssh",
        "-F", "/dev/null",
        "-i", files["identity"],
        "-o", "BatchMode=yes",
        "-o", "IdentitiesOnly=yes",
        "-o", "StrictHostKeyChecking=yes",
        "-o", "LogLevel=ERROR",
        "-o", f"UserKnownHostsFile={files['knownHosts']}",
        "-p", str(production["maintenancePort"]),
        f"{production['maintenanceUser']}@{production['address']}",
        action,
    ]
    started = time.time()
    try:
        result = subprocess.run(command, text=True, capture_output=True, timeout=30, check=False)
    except Exception as exc:
        return {"ok": False, "error": type(exc).__name__, "durationMs": round((time.time() - started) * 1000)}
    if result.returncode != 0:
        return {"ok": False, "error": "maintenance command failed", "returnCode": result.returncode, "durationMs": round((time.time() - started) * 1000)}
    try:
        raw_payload = json.loads(result.stdout.strip().splitlines()[-1])
    except Exception:
        return {"ok": False, "error": "invalid maintenance response", "durationMs": round((time.time() - started) * 1000)}
    payload = sanitize_production_inspection(raw_payload)
    payload["durationMs"] = round((time.time() - started) * 1000)
    payload["channel"] = "restricted_ssh"
    return payload


def project_production_root(project_id):
    return os.path.join(PROJECT_PRODUCTION_DIR, project_id)


def load_project_production_job(job_id):
    job_id = (job_id or "").strip()
    if not re.match(r"^prod-[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$", job_id):
        return None
    for project_id in PROJECT_LIVE_PROBES:
        path = os.path.join(project_production_root(project_id), "jobs", job_id + ".json")
        job = load_json_file(path, None)
        if job:
            return job
    return None


def save_project_production_job(job):
    jobs_dir = os.path.join(project_production_root(job["project"]), "jobs")
    ensure_private_dir(jobs_dir)
    save_json_file(os.path.join(jobs_dir, job["id"] + ".json"), job)


def project_production_status_payload(project_id):
    if project_id not in PROJECT_LIVE_PROBES:
        return None
    latest = load_json_file(os.path.join(project_production_root(project_id), "latest.json"), None)
    with PROJECT_PRODUCTION_LOCK:
        active = project_id in PROJECT_PRODUCTION_ACTIVE
    return {
        "ok": True,
        "project": project_id,
        "configured": production_channel_configured(project_id),
        "active": active,
        "latest": latest,
        "allowedActions": ["inspect", "restart"],
        "policy": "inspect is read-only; restart requires action token and exact confirmation; deploy and shell are not allowed",
        "generatedAt": time.strftime("%Y-%m-%d %H:%M:%S %Z"),
    }


def production_action_notification_text(project_id, job):
    result = job.get("result") or {}
    live = job.get("live") or {}
    return "\n".join([
        f"AI Ops {project_id} 生产维护动作",
        f"动作：{job.get('action')}",
        f"状态：{'成功' if job.get('ok') else '失败'}",
        f"PM2：{(result.get('process') or {}).get('status') or '-'}",
        f"公网探测：{live.get('passed', 0)}/{live.get('total', 0)}",
        f"动作ID：{job.get('id')}",
        f"审计：https://ops.hahaxiong.top/vibe/project?id={project_id}",
    ])


def run_project_production_worker(job_id, project_id, action):
    job = load_project_production_job(job_id) or {"id": job_id, "project": project_id, "action": action}
    job.update({"status": "running", "updatedAt": time.strftime("%Y-%m-%d %H:%M:%S %Z")})
    save_project_production_job(job)
    started = time.time()
    latest_path = os.path.join(project_production_root(project_id), "latest.json")
    try:
        before = run_production_command(project_id, "inspect")
        result = before if action == "inspect" else run_production_command(project_id, "restart")
        live = project_live_check(project_id)
        ok = bool(result.get("ok") and live.get("ok"))
        job.update({
            "ok": ok,
            "status": "done" if ok else "failed",
            "before": before if action == "restart" else None,
            "result": result,
            "live": live,
            "durationMs": round((time.time() - started) * 1000),
            "updatedAt": time.strftime("%Y-%m-%d %H:%M:%S %Z"),
        })
        if action == "restart":
            try:
                notification = send_feishu_text(production_action_notification_text(project_id, job))
                job["notification"] = {"sent": True, "status": notification.get("status")}
            except Exception as exc:
                job["notification"] = {"sent": False, "status": "error", "error": type(exc).__name__}
    except Exception as exc:
        job.update({
            "ok": False,
            "status": "failed",
            "error": type(exc).__name__,
            "durationMs": round((time.time() - started) * 1000),
            "updatedAt": time.strftime("%Y-%m-%d %H:%M:%S %Z"),
        })
    finally:
        ensure_private_dir(project_production_root(project_id))
        save_json_file(latest_path, job)
        save_project_production_job(job)
        with PROJECT_PRODUCTION_LOCK:
            PROJECT_PRODUCTION_ACTIVE.discard(project_id)


def start_project_production_job(payload):
    project_id = (payload.get("project") or "chenchuan-site").strip()
    action = (payload.get("action") or "inspect").strip()
    if project_id not in PROJECT_LIVE_PROBES:
        return {"ok": False, "error": "project production maintenance not configured"}
    if action not in {"inspect", "restart"}:
        return {"ok": False, "error": "production action not allowed"}
    if action == "restart" and payload.get("confirmation") != "RESTART_CHENCHUAN_SITE":
        return {"ok": False, "error": "restart confirmation required"}
    if not production_channel_configured(project_id):
        return {"ok": False, "error": "maintenance channel not configured"}
    if action == "restart":
        restart_state_path = os.path.join(project_production_root(project_id), "last-restart.json")
        restart_state = load_json_file(restart_state_path, {}) or {}
        elapsed = time.time() - float(restart_state.get("requestedTs") or 0)
        if elapsed < PROJECT_RESTART_COOLDOWN_SECONDS:
            return {"ok": False, "error": "restart cooldown", "retryAfterSeconds": round(PROJECT_RESTART_COOLDOWN_SECONDS - elapsed)}
    with PROJECT_PRODUCTION_LOCK:
        if project_id in PROJECT_PRODUCTION_ACTIVE:
            return {"ok": False, "error": "project production action already running"}
        PROJECT_PRODUCTION_ACTIVE.add(project_id)
    job_id = "prod-" + time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(3)
    job = {
        "id": job_id,
        "ok": None,
        "status": "queued",
        "project": project_id,
        "action": action,
        "createdAt": time.strftime("%Y-%m-%d %H:%M:%S %Z"),
        "updatedAt": time.strftime("%Y-%m-%d %H:%M:%S %Z"),
    }
    try:
        save_project_production_job(job)
        if action == "restart":
            restart_state_path = os.path.join(project_production_root(project_id), "last-restart.json")
            ensure_private_dir(project_production_root(project_id))
            save_json_file(restart_state_path, {"jobId": job_id, "requestedTs": time.time(), "requestedAt": job["createdAt"]})
        thread = threading.Thread(target=run_project_production_worker, args=(job_id, project_id, action), daemon=True)
        thread.start()
    except Exception:
        with PROJECT_PRODUCTION_LOCK:
            PROJECT_PRODUCTION_ACTIVE.discard(project_id)
        raise
    return {"ok": True, "status": "queued", "jobId": job_id, "pollUrl": f"/vibe/project/production/job?id={job_id}"}


def project_daily_root(project_id):
    return os.path.join(PROJECT_DAILY_DIR, project_id)


def load_project_daily_job(job_id):
    job_id = (job_id or "").strip()
    if not re.match(r"^daily-[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$", job_id):
        return None
    for project_id in PROJECT_LIVE_PROBES:
        path = os.path.join(project_daily_root(project_id), "jobs", job_id + ".json")
        job = load_json_file(path, None)
        if job:
            return job
    return None


def save_project_daily_job(job):
    jobs_dir = os.path.join(project_daily_root(job["project"]), "jobs")
    ensure_private_dir(jobs_dir)
    save_json_file(os.path.join(jobs_dir, job["id"] + ".json"), job)


def project_daily_status_payload(project_id):
    if project_id not in PROJECT_LIVE_PROBES:
        return None
    latest = load_json_file(os.path.join(project_daily_root(project_id), "latest.json"), None)
    with PROJECT_DAILY_LOCK:
        active = project_id in PROJECT_DAILY_ACTIVE
    return {
        "ok": True,
        "project": project_id,
        "active": active,
        "latest": latest,
        "generatedAt": time.strftime("%Y-%m-%d %H:%M:%S %Z"),
    }


def send_project_daily_heartbeat(project_id, ok, message, ping):
    push_url = PROJECT_DAILY_PUSH_URLS.get(project_id) or ""
    if not push_url:
        return {"status": "skipped", "configured": False}
    separator = "&" if "?" in push_url else "?"
    query = urlencode({"status": "up" if ok else "down", "msg": str(message)[:160], "ping": max(0, int(ping or 0))})
    try:
        request = urllib.request.Request(push_url + separator + query, headers={"User-Agent": "AI-Ops-Cockpit/1.0"})
        with urllib.request.urlopen(request, timeout=15) as response:
            response.read(512)
        return {"status": response.status, "configured": True, "ok": 200 <= response.status < 300}
    except Exception as exc:
        return {"status": "error", "configured": True, "ok": False, "error": type(exc).__name__}


def run_vibe_task_with_retry(mode, question, project_id, runtime_context, attempts=5):
    result = None
    for attempt in range(attempts):
        result = run_vibe_task(mode, question, "", False, project_id, runtime_context)
        if result.get("error") not in {"cooldown", "task already running"}:
            return result
        if attempt + 1 < attempts:
            delay = min(30, max(5, int(result.get("retryAfterSeconds") or 20) + 1))
            time.sleep(delay)
    return result or {"ok": False, "error": "task unavailable"}


def project_daily_question(project_id):
    project = PILOT_PROJECTS[project_id]
    return "\n".join([
        f"请执行 {project['name']} 每日只读 AI 巡检。",
        "请同时使用系统注入的文件级 allowlist 源码快照、本轮公网实时探测和生产 PM2 限权巡检 JSON。",
        "输出必须按 BRO-PDCA：O1/O2、Plan、Do/观察、Check、Action。",
        "重点判断：关键页面与视频资源是否可访问、源码快照是否完整且新鲜、PM2/磁盘/部署状态是否需要人工处理。",
        "只能分析和给建议；不得执行写文件、重启、部署、commit、push，也不得输出或索要任何 secret。",
    ])


def project_daily_signature(live, snapshot, production, task):
    payload = {
        "failedIds": sorted(live.get("failedIds") or []),
        "snapshot": None if snapshot.get("ok") else "stale_or_incomplete",
        "production": None if production.get("ok") else "maintenance_unavailable",
        "task": None if task.get("ok") else "grok_failed",
    }
    return json.dumps(payload, ensure_ascii=False, sort_keys=True)


def create_project_daily_todo(project_id, task, job_id):
    if not task.get("id"):
        task_id = time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(3)
        task = {
            "id": task_id,
            "ok": False,
            "mode": "readonly_inspect",
            "modeName": "只读巡检",
            "project": project_id,
            "question": f"{project_id} 每日 AI 巡检",
            "answer": "每日巡检链路未能完成 Grok 分析，请查看实时探测与任务审计。",
            "createdAt": time.strftime("%Y-%m-%d %H:%M:%S %Z"),
            "durationMs": 0,
        }
        ensure_private_dir(TASKS_DIR)
        save_json_file(os.path.join(TASKS_DIR, task_id + ".json"), task)
    result = create_todo_from_task(task["id"])
    if not result.get("ok"):
        return None
    todo = result["todo"]
    todo.update({
        "title": f"{project_id} 每日巡检异常",
        "summary": "每日只读巡检发现异常；请查看任务审计、实时探测与项目巡检状态。",
        "source": "/vibe/project/daily",
        "dailyJobId": job_id,
        "autoCreated": True,
    })
    save_json_file(os.path.join(TODOS_DIR, todo["id"] + ".json"), todo)
    return todo


def close_project_daily_todo(todo_id):
    if not todo_id:
        return False
    path = os.path.join(TODOS_DIR, todo_id + ".json")
    todo = load_json_file(path, None)
    if not todo or todo.get("status") == "done":
        return False
    todo.update({
        "status": "done",
        "updatedAt": time.strftime("%Y-%m-%d %H:%M:%S %Z"),
        "autoRecovered": True,
    })
    save_json_file(path, todo)
    return True


def project_daily_notification_text(project_id, job, event):
    live = job.get("live") or {}
    snapshot = job.get("snapshot") or {}
    production = job.get("production") or {}
    labels = {"normal": "每日简报", "alert": "异常告警", "recovery": "恢复通知"}
    return "\n".join([
        f"AI Ops {project_id} {labels.get(event, event)}",
        f"状态：{'通过' if job.get('ok') else '需要关注'}",
        f"实时探测：{live.get('passed', 0)}/{live.get('total', 0)}",
        f"失败项：{','.join(live.get('failedIds') or []) or '-'}",
        f"源码快照：{'可用' if snapshot.get('ok') else '过期或不完整'} / {snapshot.get('ageHours')} 小时",
        f"生产维护通道：{'可用' if production.get('ok') else '不可用'} / PM2 {(production.get('process') or {}).get('status') or '-'}",
        f"任务ID：{job.get('taskId') or '-'}",
        f"待办ID：{job.get('todoId') or '-'}",
        f"审计：https://ops.hahaxiong.top/vibe/project?id={project_id}",
    ])


def run_project_daily_worker(job_id, project_id, simulate_failure, force_notify):
    job = load_project_daily_job(job_id) or {"id": job_id, "project": project_id}
    job.update({"status": "running", "updatedAt": time.strftime("%Y-%m-%d %H:%M:%S %Z")})
    save_project_daily_job(job)
    latest_path = os.path.join(project_daily_root(project_id), "latest.json")
    previous = load_json_file(latest_path, {}) or {}
    started = time.time()
    try:
        live = project_live_check(project_id, simulate_failure)
        snapshot = project_snapshot_status(project_id)
        production = run_production_command(project_id, "inspect")
        runtime_context = {"live": live, "snapshot": snapshot, "production": production}
        task = run_vibe_task_with_retry("readonly_inspect", project_daily_question(project_id), project_id, runtime_context)
        core_ok = bool(live.get("ok") and snapshot.get("ok") and production.get("ok") and task.get("ok"))
        signature = project_daily_signature(live, snapshot, production, task)
        previous_abnormal = previous.get("ok") is False
        same_issue_today = previous_abnormal and previous.get("signature") == signature and previous.get("day") == time.strftime("%Y-%m-%d")
        event = "normal"
        todo = None
        if not core_ok:
            event = "alert"
            if not same_issue_today:
                todo = create_project_daily_todo(project_id, task, job_id)
        elif previous_abnormal:
            event = "recovery"
            close_project_daily_todo(previous.get("todoId"))
        job.update({
            "ok": core_ok,
            "status": "done" if core_ok else "attention",
            "day": time.strftime("%Y-%m-%d"),
            "event": event,
            "signature": signature,
            "live": live,
            "snapshot": snapshot,
            "production": production,
            "taskId": task.get("id"),
            "todoId": (todo or {}).get("id") or (previous.get("todoId") if same_issue_today else None),
            "durationMs": round((time.time() - started) * 1000),
            "updatedAt": time.strftime("%Y-%m-%d %H:%M:%S %Z"),
        })
        should_notify = force_notify or event in {"alert", "recovery"} or previous.get("day") != job["day"]
        if should_notify:
            try:
                notification = send_feishu_text(project_daily_notification_text(project_id, job, event))
                job["notification"] = {"status": notification.get("status"), "sent": True}
            except Exception as exc:
                job["notification"] = {"status": "error", "sent": False, "error": type(exc).__name__}
        else:
            job["notification"] = {"status": "deduped", "sent": False}
        job["heartbeat"] = send_project_daily_heartbeat(project_id, core_ok, f"{event}:{live.get('passed', 0)}/{live.get('total', 0)}", round(job["durationMs"] / 1000))
        ensure_private_dir(project_daily_root(project_id))
        save_json_file(latest_path, job)
    except Exception as exc:
        job.update({
            "ok": False,
            "status": "failed",
            "event": "alert",
            "error": type(exc).__name__,
            "durationMs": round((time.time() - started) * 1000),
            "updatedAt": time.strftime("%Y-%m-%d %H:%M:%S %Z"),
        })
        try:
            send_feishu_text(f"AI Ops {project_id} 每日巡检异常\n状态：巡检链路失败\n任务ID：-\n审计：https://ops.hahaxiong.top/vibe/project?id={project_id}")
        except Exception:
            pass
        job["heartbeat"] = send_project_daily_heartbeat(project_id, False, "pipeline_failed", round(job["durationMs"] / 1000))
        ensure_private_dir(project_daily_root(project_id))
        save_json_file(latest_path, job)
    finally:
        save_project_daily_job(job)
        with PROJECT_DAILY_LOCK:
            PROJECT_DAILY_ACTIVE.discard(project_id)


def start_project_daily_job(payload):
    project_id = (payload.get("project") or "chenchuan-site").strip()
    if project_id not in PROJECT_LIVE_PROBES:
        return {"ok": False, "error": "project daily inspection not configured"}
    with PROJECT_DAILY_LOCK:
        if project_id in PROJECT_DAILY_ACTIVE:
            return {"ok": False, "error": "project daily inspection already running"}
        PROJECT_DAILY_ACTIVE.add(project_id)
    job_id = "daily-" + time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(3)
    job = {
        "id": job_id,
        "ok": None,
        "status": "queued",
        "project": project_id,
        "simulated": bool(payload.get("simulateFailure")),
        "createdAt": time.strftime("%Y-%m-%d %H:%M:%S %Z"),
        "updatedAt": time.strftime("%Y-%m-%d %H:%M:%S %Z"),
    }
    try:
        save_project_daily_job(job)
        thread = threading.Thread(
            target=run_project_daily_worker,
            args=(job_id, project_id, bool(payload.get("simulateFailure")), bool(payload.get("forceNotify"))),
            daemon=True,
        )
        thread.start()
    except Exception:
        with PROJECT_DAILY_LOCK:
            PROJECT_DAILY_ACTIVE.discard(project_id)
        raise
    return {"ok": True, "status": "queued", "jobId": job_id, "pollUrl": f"/vibe/project/daily/job?id={job_id}"}


def build_pilot_question(project_id, workflow_id):
    project = PILOT_PROJECTS.get(project_id)
    workflow = PILOT_WORKFLOW_MATRIX.get(workflow_id)
    if not project or not workflow:
        return None
    allowlist = PROJECT_ALLOWLIST.get(project_id, [])
    production = project.get("production") or {}
    return "\n".join([
        f"请按实战试点流程处理项目：{project['name']}。",
        f"工作流：{workflow['name']}，权限：{workflow['permission']}。",
        f"目标：{project['goal']}",
        f"只读路径：{project['path']}",
        "已核实生产真相：" + (json.dumps(production, ensure_ascii=False) if production else "尚未登记；不得猜测生产目标。"),
        f"系统将注入文件级 allowlist 中的真实只读源码，共 {len(allowlist)} 个候选文件；请引用具体文件路径作为证据。",
        "必须按 BRO-PDCA 输出：O1/O2 → Plan → Do/观察 → Check 验收 → Action 沉淀。",
        "禁止写文件、改配置、重启、部署、commit、push；如认为需要写操作，只能给方案、diff 草案、风险、回滚点和验收命令，等待川哥确认。",
        "禁止输出或索要 secret、Webhook、Kuma Push URL、OAuth code/token、密码、cookie、API key。",
    ])


def load_pilot_job(job_id):
    job_id = (job_id or "").strip()
    if not re.match(r"^pilot-[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$", job_id):
        return None
    return load_json_file(os.path.join(PILOT_JOBS_DIR, job_id + ".json"), None)


def save_pilot_job(job):
    ensure_private_dir(PILOT_JOBS_DIR)
    save_json_file(os.path.join(PILOT_JOBS_DIR, job["id"] + ".json"), job)


def run_pilot_task(payload):
    project_id = (payload.get("project") or "chenchuan-site").strip()
    workflow_id = (payload.get("workflow") or "readonly_inspect").strip()
    if workflow_id not in ("readonly_inspect", "plan_design"):
        return {"ok": False, "error": "pilot workflow must be readonly_inspect or plan_design before write access is approved"}
    question = build_pilot_question(project_id, workflow_id)
    if not question:
        return {"ok": False, "error": "unknown pilot project or workflow"}
    return run_vibe_task(workflow_id, question, "", bool(payload.get("notify")), project_id)


def start_pilot_job(payload):
    project_id = (payload.get("project") or "chenchuan-site").strip()
    workflow_id = (payload.get("workflow") or "readonly_inspect").strip()
    if workflow_id not in ("readonly_inspect", "plan_design"):
        return {"ok": False, "error": "pilot workflow must be readonly_inspect or plan_design before write access is approved"}
    question = build_pilot_question(project_id, workflow_id)
    if not question:
        return {"ok": False, "error": "unknown pilot project or workflow"}
    if not PILOT_JOB_LOCK.acquire(blocking=False):
        return {"ok": False, "error": "pilot job already starting"}
    try:
        job_id = "pilot-" + time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(3)
        job = {
            "id": job_id,
            "ok": None,
            "status": "queued",
            "project": project_id,
            "workflow": workflow_id,
            "createdAt": time.strftime("%Y-%m-%d %H:%M:%S %Z"),
            "updatedAt": time.strftime("%Y-%m-%d %H:%M:%S %Z"),
        }
        save_pilot_job(job)
        thread = threading.Thread(target=run_pilot_job_worker, args=(job_id, project_id, workflow_id, question, bool(payload.get("notify"))), daemon=True)
        thread.start()
        return {"ok": True, "status": "queued", "jobId": job_id, "pollUrl": f"/vibe/pilot/job?id={job_id}"}
    finally:
        PILOT_JOB_LOCK.release()


def run_pilot_job_worker(job_id, project_id, workflow_id, question, notify):
    job = load_pilot_job(job_id) or {"id": job_id}
    job.update({"status": "running", "updatedAt": time.strftime("%Y-%m-%d %H:%M:%S %Z")})
    save_pilot_job(job)
    try:
        result = run_vibe_task(workflow_id, question, "", notify, project_id)
        job.update({
            "ok": bool(result.get("ok")),
            "status": "done" if result.get("ok") else "failed",
            "taskId": result.get("id"),
            "error": result.get("error"),
            "durationMs": result.get("durationMs"),
            "updatedAt": time.strftime("%Y-%m-%d %H:%M:%S %Z"),
        })
    except Exception as exc:
        job.update({"ok": False, "status": "failed", "error": sanitize_terminal_text(str(exc)), "updatedAt": time.strftime("%Y-%m-%d %H:%M:%S %Z")})
    save_pilot_job(job)


def n8n_manual_inspect_payload():
    try:
        report = build_report()
        feishu = send_feishu(report, force=True)
        return {"ok": True, "mode": "internal_inspect", "feishu": feishu, "summary": report.get("summary"), "generatedAt": report.get("generatedAt")}
    except Exception as exc:
        return {"ok": False, "error": sanitize_terminal_text(str(exc)), "generatedAt": time.strftime("%Y-%m-%d %H:%M:%S %Z")}


def todo_history(limit=50):
    ensure_state_dir()
    ensure_private_dir(TODOS_DIR)
    items = []
    for name in os.listdir(TODOS_DIR):
        if not name.endswith(".json"):
            continue
        item = load_json_file(os.path.join(TODOS_DIR, name), None)
        if item:
            items.append(item)
    return sorted(items, key=lambda item: item.get("createdAt", ""), reverse=True)[:limit]


def todo_detail(todo_id):
    todo_id = (todo_id or "").strip()
    if not re.match(r"^todo-[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$", todo_id):
        return None
    todo = load_json_file(os.path.join(TODOS_DIR, todo_id + ".json"), None)
    if not todo:
        return None
    task = load_json_file(os.path.join(TASKS_DIR, todo.get("taskId", "") + ".json"), {}) or {}
    return {"todo": todo, "task": {"id": task.get("id"), "ok": task.get("ok"), "modeName": task.get("modeName"), "createdAt": task.get("createdAt"), "durationMs": task.get("durationMs")}}


def ops_report_payload(kind="daily"):
    report = build_report()
    todos = todo_history(200)
    open_todos = [item for item in todos if item.get("status") != "done"]
    done_todos = [item for item in todos if item.get("status") == "done"]
    backup = backup_summary(report.get("monitors", []))
    payload = {
        "ok": report.get("ok") and not open_todos,
        "kind": kind if kind in ("daily", "weekly") else "daily",
        "generatedAt": time.strftime("%Y-%m-%d %H:%M:%S %Z"),
        "summary": {
            "monitorsDown": len([item for item in report.get("monitors", []) if item.get("active") and item.get("status") != 1]),
            "unhealthyContainers": len([item for item in report.get("containers", []) if "Up" not in item.get("status", "")]),
            "openTodos": len(open_todos),
            "doneTodos": len(done_todos),
            "backupOk": backup.get("ok"),
        },
        "backup": backup,
        "openTodos": [{"id": item.get("id"), "status": item.get("status"), "modeName": item.get("modeName"), "createdAt": item.get("createdAt")} for item in open_todos[:20]],
        "pilotProjects": [project_workspace_panel(project_id) for project_id in PILOT_PROJECTS.keys()],
        "reportText": report.get("text"),
    }
    return payload


def kuma_context_payload():
    report = build_report()
    monitors = [item for item in report.get("monitors", []) if item.get("active")]
    down = [item for item in monitors if item.get("status") != 1]
    return {
        "ok": not down,
        "generatedAt": time.strftime("%Y-%m-%d %H:%M:%S %Z"),
        "downMonitors": down,
        "backup": backup_summary(monitors),
        "host": report.get("host"),
        "containers": report.get("containers", []),
        "nextSteps": ["查看 /vibe/tasks 最近巡检", "查看 /vibe/assets 就绪度", "必要时触发 /vibe/action/n8n-inspect"],
    }


def create_todo_from_task(task_id):
    task_id = (task_id or "").strip()
    if not re.match(r"^[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$", task_id):
        return {"ok": False, "error": "invalid task id"}
    task = load_json_file(os.path.join(TASKS_DIR, task_id + ".json"), None)
    if not task:
        return {"ok": False, "error": "task not found"}
    ensure_private_dir(TODOS_DIR)
    todo_id = "todo-" + task_id
    answer = task.get("answer") or ""
    summary = " ".join(answer.strip().split())[:240] or "查看任务审计输出"
    todo = {
        "id": todo_id,
        "taskId": task_id,
        "project": task.get("project"),
        "status": "open",
        "title": (task.get("question") or "Grok 任务待办")[:120],
        "summary": summary,
        "structured": task_structured_summary(task),
        "nextActions": ["continue_question", "plan_design", "inspect"],
        "modeName": task.get("modeName"),
        "createdAt": time.strftime("%Y-%m-%d %H:%M:%S %Z"),
        "source": "/vibe/tasks",
    }
    save_json_file(os.path.join(TODOS_DIR, todo_id + ".json"), todo)
    return {"ok": True, "todo": todo}


def update_todo_status(todo_id, status):
    todo_id = (todo_id or "").strip()
    status = (status or "").strip()
    if status not in {"open", "doing", "done"}:
        return {"ok": False, "error": "invalid status"}
    if not re.match(r"^todo-[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$", todo_id):
        return {"ok": False, "error": "invalid todo id"}
    path = os.path.join(TODOS_DIR, todo_id + ".json")
    todo = load_json_file(path, None)
    if not todo:
        return {"ok": False, "error": "todo not found"}
    todo["status"] = status
    todo["updatedAt"] = time.strftime("%Y-%m-%d %H:%M:%S %Z")
    save_json_file(path, todo)
    return {"ok": True, "todo": todo}


def notify_todo(todo_id):
    todo_id = (todo_id or "").strip()
    if not re.match(r"^todo-[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$", todo_id):
        return {"ok": False, "error": "invalid todo id"}
    todo = load_json_file(os.path.join(TODOS_DIR, todo_id + ".json"), None)
    if not todo:
        return {"ok": False, "error": "todo not found"}
    text = "AI Ops 待办提醒\n" + f"待办ID：{todo['id']}\n状态：{todo.get('status')}\n模式：{todo.get('modeName') or '-'}\n入口：请在 /vibe/todos 查看脱敏详情。"
    try:
        result = send_feishu_text(text)
        todo["lastNotifiedAt"] = time.strftime("%Y-%m-%d %H:%M:%S %Z")
        save_json_file(os.path.join(TODOS_DIR, todo_id + ".json"), todo)
        return {"ok": True, "feishu": result, "todoId": todo_id}
    except Exception as exc:
        return {"ok": False, "error": sanitize_terminal_text(str(exc))}


def inspect_for_todo(todo_id):
    todo_id = (todo_id or "").strip()
    if not re.match(r"^todo-[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$", todo_id):
        return {"ok": False, "error": "invalid todo id"}
    if not load_json_file(os.path.join(TODOS_DIR, todo_id + ".json"), None):
        return {"ok": False, "error": "todo not found"}
    result = n8n_manual_inspect_payload()
    result["todoId"] = todo_id
    result["note"] = "已基于待办触发内部巡检；未外发待办标题、摘要或 Grok 输出。"
    return result


def load_todo_job(job_id):
    job_id = (job_id or "").strip()
    if not re.match(r"^todojob-[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$", job_id):
        return None
    return load_json_file(os.path.join(TODO_JOBS_DIR, job_id + ".json"), None)


def save_todo_job(job):
    ensure_private_dir(TODO_JOBS_DIR)
    save_json_file(os.path.join(TODO_JOBS_DIR, job["id"] + ".json"), job)


def build_todo_followup_question(todo, action):
    action = action if action in {"continue_question", "plan_design"} else "continue_question"
    mode = "plan_design" if action == "plan_design" else "readonly_inspect"
    prompt = "\n".join([
        f"请基于 AI Ops 待办继续推进：{todo.get('id')}。",
        f"待办状态：{todo.get('status')}，来源任务：{todo.get('taskId')}。",
        f"脱敏标题：{todo.get('title')}",
        f"脱敏摘要：{todo.get('summary')}",
        "要求：不要输出 secret，不执行写入，不部署，不 commit/push。",
        "请输出：异常/风险/建议/验收命令/是否建议转入下一步。",
    ])
    return mode, prompt


def start_todo_action(payload):
    todo_id = (payload.get("todoId") or "").strip()
    action = (payload.get("action") or "continue_question").strip()
    if action not in {"continue_question", "plan_design", "inspect"}:
        return {"ok": False, "error": "invalid todo action"}
    if action == "inspect":
        return inspect_for_todo(todo_id)
    todo = load_json_file(os.path.join(TODOS_DIR, todo_id + ".json"), None)
    if not todo:
        return {"ok": False, "error": "todo not found"}
    if not TODO_JOB_LOCK.acquire(blocking=False):
        return {"ok": False, "error": "todo job already starting"}
    try:
        mode, question = build_todo_followup_question(todo, action)
        job_id = "todojob-" + time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(3)
        job = {"id": job_id, "ok": None, "status": "queued", "todoId": todo_id, "action": action, "createdAt": time.strftime("%Y-%m-%d %H:%M:%S %Z"), "updatedAt": time.strftime("%Y-%m-%d %H:%M:%S %Z")}
        save_todo_job(job)
        thread = threading.Thread(target=run_todo_job_worker, args=(job_id, mode, question, todo.get("project")), daemon=True)
        thread.start()
        return {"ok": True, "status": "queued", "jobId": job_id, "pollUrl": f"/vibe/todos/job?id={job_id}"}
    finally:
        TODO_JOB_LOCK.release()


def run_todo_job_worker(job_id, mode, question, project_id):
    job = load_todo_job(job_id) or {"id": job_id}
    job.update({"status": "running", "updatedAt": time.strftime("%Y-%m-%d %H:%M:%S %Z")})
    save_todo_job(job)
    try:
        result = run_vibe_task(mode, question, "", False, project_id)
        job.update({"ok": bool(result.get("ok")), "status": "done" if result.get("ok") else "failed", "taskId": result.get("id"), "error": result.get("error"), "durationMs": result.get("durationMs"), "updatedAt": time.strftime("%Y-%m-%d %H:%M:%S %Z")})
    except Exception as exc:
        job.update({"ok": False, "status": "failed", "error": sanitize_terminal_text(str(exc)), "updatedAt": time.strftime("%Y-%m-%d %H:%M:%S %Z")})
    save_todo_job(job)


def task_history(limit=20):
    ensure_state_dir()
    ensure_private_dir(TASKS_DIR)
    items = []
    for name in os.listdir(TASKS_DIR):
        if not name.endswith(".json"):
            continue
        path = os.path.join(TASKS_DIR, name)
        item = load_json_file(path, None)
        if item:
            items.append(item)
    return sorted(items, key=lambda item: item.get("createdAt", ""), reverse=True)[:limit]


def run_vibe_task(mode, question, conversation=None, notify=False, project_id=None, runtime_context=None):
    mode = (mode or "readonly_inspect").strip()
    question = (question or "").strip()
    conversation = (conversation or "").strip()[-4000:]
    workflows = {item["id"]: item for item in harness_payload()["workflows"]}
    workflow = workflows.get(mode) or workflows["readonly_inspect"]
    if not question:
        return {"ok": False, "error": "empty question"}
    if len(question) > 1600:
        return {"ok": False, "error": "question too long"}
    context = build_project_context(project_id) if project_id else None
    if project_id and not context.get("ok"):
        return {"ok": False, "error": "project context not ready", "project": project_id, "context": {key: value for key, value in context.items() if key != "prompt"}}
    if not TASK_LOCK.acquire(blocking=False):
        return {"ok": False, "error": "task already running"}
    created = time.strftime("%Y-%m-%d %H:%M:%S %Z")
    task_id = time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(3)
    started = time.time()
    try:
        now = time.time()
        elapsed = now - TASK_STATE["last_run"]
        if elapsed < TASK_COOLDOWN_SECONDS:
            return {"ok": False, "error": "cooldown", "retryAfterSeconds": round(TASK_COOLDOWN_SECONDS - elapsed)}
        prompt = harness_prompt() + "\n\n当前工作模式：" + workflow["prompt"]
        if conversation:
            prompt += "\n\n网页端连续对话上下文（已脱敏，仅供理解当前轮）：\n" + conversation
        prompt += "\n\n川哥发来的任务：" + question
        if context:
            prompt += context["prompt"]
        if runtime_context:
            runtime_text = redact_sensitive_text(json.dumps(runtime_context, ensure_ascii=False, indent=2))[:12000]
            prompt += "\n\n本轮实时运行上下文如下；它比源码快照更新，应优先用于判断当前状态：\n```json\n" + runtime_text + "\n```"
        shell = 'cat > /tmp/aiops-task-prompt.txt && timeout 180 omp --model xai-oauth/grok-4.5 --cwd /workspace/projects/ai-ops-cockpit --no-tools --no-session -p @/tmp/aiops-task-prompt.txt'
        try:
            output = subprocess.check_output(["docker", "exec", "-i", "ops-terminal", "bash", "-lc", shell], input=prompt, text=True, stderr=subprocess.STDOUT, timeout=210)
            ok = True
        except subprocess.CalledProcessError as exc:
            output = exc.output
            ok = False
        except Exception as exc:
            output = str(exc)
            ok = False
        item = {
            "id": task_id,
            "ok": ok,
            "mode": workflow["id"],
            "modeName": workflow["name"],
            "project": project_id,
            "question": redact_sensitive_text(question),
            "conversationPreview": redact_sensitive_text(conversation)[-1000:],
            "answer": compact_task_answer(output),
            "createdAt": created,
            "durationMs": round((time.time() - started) * 1000),
        }
        if context:
            item["context"] = {key: value for key, value in context.items() if key != "prompt"}
        if runtime_context:
            item["runtimeContext"] = runtime_context
        if notify:
            try:
                notify_text = "AI Ops Grok 任务完成\n" + f"状态：{'成功' if item['ok'] else '失败'}\n模式：{item['modeName']}\n任务ID：{item['id']}\n耗时：{item['durationMs']}ms\n审计：请在 /vibe/tasks 查看脱敏结果。"
                item["feishu"] = send_feishu_text(notify_text)
            except Exception as exc:
                item["feishu"] = {"status": "error", "body": sanitize_terminal_text(str(exc))}
        ensure_private_dir(TASKS_DIR)
        save_json_file(os.path.join(TASKS_DIR, task_id + ".json"), item)
        TASK_STATE["last_run"] = time.time()
        return item
    finally:
        TASK_LOCK.release()


def render_vibe_tasks_page():
    return f"""<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Grok 任务审计 - AI Ops</title><style>body{{margin:0;background:#0f172a;color:#e5e7eb;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif}}main{{max-width:1180px;margin:0 auto;padding:28px}}.card{{background:#111827;border:1px solid #334155;border-radius:18px;padding:20px;margin:16px 0}}.muted{{color:#94a3b8}}a{{color:#93c5fd}}button,select{{background:#2563eb;color:white;border:0;border-radius:10px;padding:8px 12px;margin:4px;cursor:pointer}}select{{background:#1f2937;border:1px solid #334155}}table{{width:100%;border-collapse:collapse}}td,th{{border-bottom:1px solid #263244;padding:10px;text-align:left;vertical-align:top}}tr.fail{{background:#3b1118}}tr.ok{{background:#0b1f16}}pre{{white-space:pre-wrap;background:#020617;border:1px solid #334155;border-radius:12px;padding:12px;max-height:360px;overflow:auto}}.topnav{{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px}}.topnav a{{color:#cbd5e1;text-decoration:none;background:#1f2937;border:1px solid #334155;border-radius:999px;padding:8px 12px}}.topnav a.active{{background:#2563eb;color:white}}.toolbar{{display:flex;gap:8px;align-items:center;flex-wrap:wrap}}</style></head><body><main>{nav_html('vibe')}<section class=\"card\"><h1>Grok 任务审计</h1><p class=\"muted\">只展示脱敏后的最近任务输入与输出；支持筛选、复制结果、失败高亮，可一键沉淀为待办。</p><div class=\"toolbar\"><label>状态 <select id=\"statusFilter\"><option value=\"all\">全部</option><option value=\"ok\">成功</option><option value=\"fail\">失败</option></select></label><button id=\"reloadTasks\">刷新</button><a href=\"/vibe/todos\">查看待办</a><span id=\"taskSummary\" class=\"muted\"></span></div><table><thead><tr><th>时间</th><th>模式</th><th>任务</th><th>状态</th><th>输出</th></tr></thead><tbody id=\"taskRows\"><tr><td colspan=5>加载中...</td></tr></tbody></table></section></main><script>
const token = sessionStorage.getItem('aiopsReadToken') || '';
let allTasks = [];
function escapeHtml(value) {{ return String(value || '').replace(/[&<>\"']/g, ch => ({{'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}}[ch])); }}
function renderTasks() {{
  const body = document.getElementById('taskRows');
  const filter = document.getElementById('statusFilter').value;
  const tasks = allTasks.filter(item => filter === 'all' || (filter === 'ok' ? item.ok : !item.ok));
  document.getElementById('taskSummary').textContent = `共 ${{allTasks.length}} 条，当前显示 ${{tasks.length}} 条`;
  body.innerHTML = tasks.map((item, index) => `<tr class="${{item.ok ? 'ok' : 'fail'}}"><td>${{escapeHtml(item.createdAt)}}</td><td>${{escapeHtml(item.modeName)}}</td><td>${{escapeHtml(item.question)}}</td><td>${{item.ok ? '✅ 成功' : '⚠️ 失败'}}</td><td><button data-copy-index="${{index}}">复制结果</button><button data-todo-id="${{escapeHtml(item.id)}}">转待办</button><details><summary>查看</summary><pre>${{escapeHtml(item.answer)}}</pre></details></td></tr>`).join('') || '<tr><td colspan=5>暂无任务</td></tr>';
  document.querySelectorAll('[data-copy-index]').forEach(button => button.addEventListener('click', async () => {{
    const item = tasks[Number(button.dataset.copyIndex)];
    await navigator.clipboard.writeText(item.answer || '');
    button.textContent = '已复制';
    setTimeout(() => button.textContent = '复制结果', 1200);
  }}));
  document.querySelectorAll('[data-todo-id]').forEach(button => button.addEventListener('click', async () => {{
    const response = await fetch('/vibe/todos/create', {{ method: 'POST', credentials: 'same-origin', headers: {{ 'content-type': 'application/json', 'X-AIOps-Read-Token': token }}, body: JSON.stringify({{ taskId: button.dataset.todoId }}) }});
    const data = await response.json();
    button.textContent = data.ok ? '已转待办' : '转待办失败';
  }}));
}}
async function loadTasks() {{
  const body = document.getElementById('taskRows');
  if (!token) {{ body.innerHTML = '<tr><td colspan=5>请从 Vibe 工作台入口进入任务审计。</td></tr>'; return; }}
  const response = await fetch('/vibe/tasks.json', {{ credentials: 'same-origin', headers: {{ 'X-AIOps-Read-Token': token }} }});
  if (!response.ok) {{ body.innerHTML = '<tr><td colspan=5>无权读取任务审计。</td></tr>'; return; }}
  const data = await response.json();
  allTasks = data.tasks || [];
  renderTasks();
}}
document.getElementById('statusFilter').addEventListener('change', renderTasks);
document.getElementById('reloadTasks').addEventListener('click', loadTasks);
loadTasks();
</script></body></html>"""


def render_vibe_todos_page():
    return f"""<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>AI Ops 待办 - Vibe</title><style>body{{margin:0;background:#0f172a;color:#e5e7eb;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif}}main{{max-width:1180px;margin:0 auto;padding:28px}}.card{{background:#111827;border:1px solid #334155;border-radius:18px;padding:20px;margin:16px 0}}.muted{{color:#94a3b8}}a{{color:#93c5fd}}button,select,input{{background:#1f2937;color:white;border:1px solid #334155;border-radius:10px;padding:8px 12px;margin:4px}}button{{background:#2563eb;border:0;cursor:pointer}}table{{width:100%;border-collapse:collapse}}td,th{{border-bottom:1px solid #263244;padding:10px;text-align:left;vertical-align:top}}.topnav{{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px}}.topnav a{{color:#cbd5e1;text-decoration:none;background:#1f2937;border:1px solid #334155;border-radius:999px;padding:8px 12px}}.topnav a.active{{background:#2563eb;color:white}}</style></head><body><main>{nav_html('vibe')}<section class=\"card\"><h1>AI Ops 待办</h1><p class=\"muted\">由 Grok 任务审计一键沉淀，默认只保存脱敏摘要和任务 ID；用于后续转工单/周报。</p><input id=\"todoSearch\" placeholder=\"搜索标题/摘要/ID\"><select id=\"todoStatusFilter\"><option value=\"all\">全部</option><option value=\"open\">open</option><option value=\"doing\">doing</option><option value=\"done\">done</option></select><button id=\"reloadTodos\">刷新</button><span id=\"todoSummary\" class=\"muted\"></span><table><thead><tr><th>时间</th><th>状态</th><th>标题</th><th>摘要</th><th>来源</th></tr></thead><tbody id=\"todoRows\"><tr><td colspan=5>加载中...</td></tr></tbody></table></section></main><script>
const token = sessionStorage.getItem('aiopsReadToken') || '';
let allTodos = [];
function escapeHtml(value) {{ return String(value || '').replace(/[&<>\"']/g, ch => ({{'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}}[ch])); }}
function renderTodos() {{
  const body = document.getElementById('todoRows');
  const statusFilter = document.getElementById('todoStatusFilter').value;
  const query = document.getElementById('todoSearch').value.trim().toLowerCase();
  const todos = allTodos.filter(item => (statusFilter === 'all' || item.status === statusFilter) && (!query || JSON.stringify(item).toLowerCase().includes(query)));
  document.getElementById('todoSummary').textContent = `共 ${{allTodos.length}} 条，当前显示 ${{todos.length}} 条`;
  body.innerHTML = todos.map(item => `<tr><td>${{escapeHtml(item.createdAt)}}</td><td><select data-status-id="${{escapeHtml(item.id)}}"><option value="open" ${{item.status === 'open' ? 'selected' : ''}}>open</option><option value="doing" ${{item.status === 'doing' ? 'selected' : ''}}>doing</option><option value="done" ${{item.status === 'done' ? 'selected' : ''}}>done</option></select></td><td><a href="/vibe/todos/detail?id=${{encodeURIComponent(item.id)}}">${{escapeHtml(item.title)}}</a></td><td>${{escapeHtml(item.summary)}}</td><td><code>${{escapeHtml(item.taskId)}}</code><br><button data-notify-id="${{escapeHtml(item.id)}}">发飞书</button><button data-inspect-id="${{escapeHtml(item.id)}}">巡检</button><button data-todo-action="continue_question" data-todo-id="${{escapeHtml(item.id)}}">继续追问</button><button data-todo-action="plan_design" data-todo-id="${{escapeHtml(item.id)}}">生成方案</button></td></tr>`).join('') || '<tr><td colspan=5>暂无待办</td></tr>';
  bindTodoActions();
}}
function bindTodoActions() {{
  document.querySelectorAll('[data-status-id]').forEach(select => select.addEventListener('change', async () => {{
    const response = await fetch('/vibe/todos/update', {{ method: 'POST', credentials: 'same-origin', headers: {{ 'content-type': 'application/json', 'X-AIOps-Read-Token': token }}, body: JSON.stringify({{ todoId: select.dataset.statusId, status: select.value }}) }});
    if (!response.ok) select.value = 'open';
  }}));
  document.querySelectorAll('[data-notify-id]').forEach(button => button.addEventListener('click', async () => {{
    const response = await fetch('/vibe/todos/notify', {{ method: 'POST', credentials: 'same-origin', headers: {{ 'content-type': 'application/json', 'X-AIOps-Read-Token': token }}, body: JSON.stringify({{ todoId: button.dataset.notifyId }}) }});
    const data = await response.json();
    button.textContent = data.ok ? '已发飞书' : '发送失败';
  }}));
  document.querySelectorAll('[data-inspect-id]').forEach(button => button.addEventListener('click', async () => {{
    const response = await fetch('/vibe/todos/inspect', {{ method: 'POST', credentials: 'same-origin', headers: {{ 'content-type': 'application/json', 'X-AIOps-Read-Token': token }}, body: JSON.stringify({{ todoId: button.dataset.inspectId }}) }});
    const data = await response.json();
    button.textContent = data.ok ? '已巡检' : '巡检失败';
  }}));
  document.querySelectorAll('[data-todo-action]').forEach(button => button.addEventListener('click', async () => {{
    button.textContent = '已提交';
    const response = await fetch('/vibe/todos/action', {{ method: 'POST', credentials: 'same-origin', headers: {{ 'content-type': 'application/json', 'X-AIOps-Read-Token': token }}, body: JSON.stringify({{ todoId: button.dataset.todoId, action: button.dataset.todoAction }}) }});
    const data = await response.json();
    button.textContent = data.ok ? '后台执行中' : '提交失败';
  }}));
}}
async function loadTodos() {{
  const body = document.getElementById('todoRows');
  if (!token) {{ body.innerHTML = '<tr><td colspan=5>请从 Vibe 工作台进入待办。</td></tr>'; return; }}
  const response = await fetch('/vibe/todos.json', {{ credentials: 'same-origin', headers: {{ 'X-AIOps-Read-Token': token }} }});
  if (!response.ok) {{ body.innerHTML = '<tr><td colspan=5>无权读取待办。</td></tr>'; return; }}
  const data = await response.json();
  allTodos = data.todos || [];
  renderTodos();
}}
document.getElementById('reloadTodos').addEventListener('click', loadTodos);
document.getElementById('todoSearch').addEventListener('input', renderTodos);
document.getElementById('todoStatusFilter').addEventListener('change', renderTodos);
loadTodos();
</script></body></html>"""


def render_vibe_todo_detail_page(todo_id):
    detail = todo_detail(todo_id)
    if not detail:
        return f"""<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><title>待办不存在</title></head><body><main>{nav_html('vibe')}<h1>待办不存在</h1><p><a href=\"/vibe/todos\">返回待办</a></p></main></body></html>"""
    todo = detail["todo"]
    task = detail["task"]
    return f"""<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>待办详情 - AI Ops</title><style>body{{margin:0;background:#0f172a;color:#e5e7eb;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif}}main{{max-width:900px;margin:0 auto;padding:28px}}.card{{background:#111827;border:1px solid #334155;border-radius:18px;padding:20px;margin:16px 0}}.muted{{color:#94a3b8}}a{{color:#93c5fd}}code{{background:#020617;padding:2px 6px;border-radius:6px}}pre{{white-space:pre-wrap;background:#020617;border:1px solid #334155;border-radius:12px;padding:12px}}.topnav{{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px}}.topnav a{{color:#cbd5e1;text-decoration:none;background:#1f2937;border:1px solid #334155;border-radius:999px;padding:8px 12px}}.topnav a.active{{background:#2563eb;color:white}}</style></head><body><main>{nav_html('vibe')}<section class=\"card\"><h1>{html.escape(todo.get('title') or 'AI Ops 待办')}</h1><p class=\"muted\">ID：<code>{html.escape(todo.get('id'))}</code> · 状态：{html.escape(todo.get('status'))} · 来源任务：<code>{html.escape(todo.get('taskId'))}</code></p><h2>脱敏摘要</h2><pre>{html.escape(todo.get('summary') or '')}</pre><h2>处理记录</h2><ul><li>创建：{html.escape(todo.get('createdAt') or '-')}</li><li>更新：{html.escape(todo.get('updatedAt') or '-')}</li><li>最后通知：{html.escape(todo.get('lastNotifiedAt') or '-')}</li></ul><h2>来源任务元信息</h2><pre>{html.escape(json.dumps(task, ensure_ascii=False, indent=2))}</pre><p><a href=\"/vibe/todos\">返回待办列表</a></p></section></main></body></html>"""


def render_assets_page():
    matrix = assets_payload()
    workspaces = matrix
    allowlist = allowlist_payload()
    server_rows = "".join(
        f"""<tr><td>{html.escape(item['name'])}</td><td>{html.escape(item['role'])}</td><td>{html.escape(str(item['status']))}</td><td>{html.escape(display_value(item.get('readinessScore')))}</td><td>{html.escape(str(item.get('risk')))}</td><td>{html.escape(display_value(item['containers']))}</td><td>{html.escape(display_value(item['maxDiskUsedPercent']))}</td><td>{html.escape(display_value(item['monitorsDown']))}</td></tr>"""
        for item in matrix["servers"]
    )
    workspace_rows = "".join(
        f"""<tr><td>{html.escape(item['name'])}</td><td><code>{html.escape(item['path'])}</code></td><td>{html.escape(item['status'])}</td><td>{html.escape(display_value(item.get('readinessScore')))}</td><td>{html.escape(str(item.get('risk')))}</td><td><pre>{html.escape(item.get('details') or '')}</pre></td></tr>"""
        for item in workspaces["workspaces"]
    )
    allowlist_rows = "".join(
        f"""<tr><td>{html.escape(item['name'])}</td><td>{html.escape(item['status'])}</td><td>{item['fileCount']}</td><td><pre>{html.escape(chr(10).join(item['files']) or '占位，未接入真实文件')}</pre></td></tr>"""
        for item in allowlist["projects"]
    )
    return f"""<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>资产矩阵 - AI Ops</title><style>body{{margin:0;background:#0f172a;color:#e5e7eb;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif}}main{{max-width:1180px;margin:0 auto;padding:28px}}.card{{background:#111827;border:1px solid #334155;border-radius:18px;padding:20px;margin:16px 0}}.muted{{color:#94a3b8}}a{{color:#93c5fd}}code{{background:#020617;padding:2px 6px;border-radius:6px}}table{{width:100%;border-collapse:collapse}}td,th{{border-bottom:1px solid #263244;padding:10px;text-align:left;vertical-align:top}}pre{{white-space:pre-wrap;background:#020617;border:1px solid #334155;border-radius:12px;padding:10px;max-height:160px;overflow:auto}}.topnav{{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px}}.topnav a{{color:#cbd5e1;text-decoration:none;background:#1f2937;border:1px solid #334155;border-radius:999px;padding:8px 12px}}.topnav a.active{{background:#2563eb;color:white}}</style></head><body><main>{nav_html('vibe')}<section class=\"card\"><h1>服务器资产矩阵</h1><p class=\"muted\">就绪度为启发式运维信号，不代表项目业务质量；异常以 Kuma/日志/审计为准。</p><table><thead><tr><th>资产</th><th>角色</th><th>状态</th><th>就绪度</th><th>风险</th><th>容器</th><th>磁盘%</th><th>Down</th></tr></thead><tbody>{server_rows}</tbody></table></section><section class=\"card\"><h1>项目工作区</h1><p class=\"muted\">当前只允许只读探测；未挂载项目保持待接入，避免 Grok 乱改真实项目。就绪度仅表示挂载/只读/git 状态。</p><table><thead><tr><th>项目</th><th>路径</th><th>状态</th><th>就绪度</th><th>风险</th><th>详情</th></tr></thead><tbody>{workspace_rows}</tbody></table></section><section class="card"><h1>项目文件级 Allowlist</h1><p class="muted">真实项目默认只占位；接入前必须明确文件级 allowlist，禁止目录级同步整仓。</p><table><thead><tr><th>项目</th><th>状态</th><th>文件数</th><th>允许文件</th></tr></thead><tbody>{allowlist_rows}</tbody></table></section></main></body></html>"""


def command_templates():
    return [
        {"label": "全局只读巡检", "prompt": "请只读检查当前 AI Ops 驾驶舱状态，按异常、风险、建议、验收命令输出。"},
        {"label": "Kuma 告警复盘", "prompt": "请只读分析 Uptime Kuma 当前 DOWN/UNKNOWN 监控，按影响、可能原因、下一步检查、是否需要飞书升级输出。"},
        {"label": "n8n 巡检联动", "prompt": "请检查 n8n 手动巡检链路是否可用：只读查看 ops-inspector、Kuma、Netdata、飞书发送链路，并给出验收命令。"},
        {"label": "项目接入评估", "prompt": "请针对一个待接入项目，先列文件级 allowlist 建议、secret 风险、只读验收命令；不要同步整仓。"},
        {"label": "查 Docker 问题", "prompt": "请检查 Docker 容器状态、最近异常日志，并给出不执行变更的排查计划。"},
        {"label": "部署前检查", "prompt": "请先检查 git diff、compose 配置、Caddy 路由和回滚点，确认是否可以部署。"},
        {"label": "回滚方案", "prompt": "请基于当前项目给出可执行回滚方案，包含备份、回滚命令、验证标准。"},
        {"label": "写复盘", "prompt": "请根据终端日志和当前 diff 总结本轮改动、踩坑、验收证据和后续 TODO。"},
    ]


def harness_payload():
    workflows = [
        {
            "id": "readonly_inspect",
            "name": "只读巡检",
            "permission": "read_only",
            "allowed": ["读取状态", "查看日志", "列风险", "给验收命令"],
            "blocked": ["写文件", "重启服务", "删除数据", "提交推送"],
            "prompt": "按 BRO-PDCA 只读巡检当前项目和 AI Ops 状态：先写 O1/O2，再列观察、风险、下一步和验收命令；不要执行写入或重启。",
        },
        {
            "id": "plan_design",
            "name": "方案设计",
            "permission": "no_write",
            "allowed": ["读文档", "读代码", "提出方案", "列验收标准"],
            "blocked": ["直接改代码", "直接部署", "改 secrets"],
            "prompt": "先读上下文，再按 BRO-PDCA 输出方案：背景、风险、分阶段计划、验收标准、回滚点；不改文件。",
        },
        {
            "id": "patch_draft",
            "name": "补丁草案",
            "permission": "draft_only",
            "allowed": ["定位文件", "生成 diff 草案", "列测试命令"],
            "blocked": ["自动 commit", "自动 push", "写入 secret", "未验收即部署"],
            "prompt": "如需改动，先给最小 diff 草案和风险说明，等待川哥或 Codex/cc 确认后再执行；禁止自行 commit/push。",
        },
        {
            "id": "deploy_verify",
            "name": "部署验收",
            "permission": "confirm_first",
            "allowed": ["列部署命令", "列回滚命令", "执行已确认验收"],
            "blocked": ["未确认的生产变更", "破坏性 Docker/DB 操作"],
            "prompt": "部署前必须列变更、备份/回滚点、验收命令和失败处理；高危操作等待明确确认。",
        },
    ]
    projects = workspace_payload()["projects"]
    return {
        "name": "AI Ops Harness v1",
        "generatedAt": time.strftime("%Y-%m-%d %H:%M:%S %Z"),
        "purpose": "让 OMP/Grok 在真实项目接入前先具备规则、记忆、方法论、工作流和权限边界。",
        "identity": {"user": "川哥", "assistant": "grok（xAI via OMP）", "language": "中文"},
        "ruleSources": [
            {"name": "HOME AGENTS", "path": "~/AGENTS.md", "scope": "HOME 白名单、secret、并发、git 权限"},
            {"name": "mycc CLAUDE", "path": "~/mycc/CLAUDE.md", "scope": "BRO-PDCA、记忆系统、归档、验收"},
            {"name": "project AGENTS", "path": "~/mycc/AGENTS.md", "scope": "Codex/mycc 项目规则"},
            {"name": "AI Ops README", "path": "/workspace/projects/ai-ops-cockpit/README.md", "scope": "本项目部署、踩坑、验收记录"},
        ],
        "memorySources": [
            {"name": "recent_events", "path": "0-System/RECENT_EVENTS.md", "mode": "read_before_work", "secretPolicy": "no_secret"},
            {"name": "memory_items", "path": "0-System/memory-items.md", "mode": "query_relevant_only", "secretPolicy": "no_secret"},
            {"name": "status", "path": "0-System/status.md", "mode": "current_snapshot", "secretPolicy": "no_secret"},
        ],
        "methodology": {
            "name": "BRO-PDCA",
            "minimum": ["O1 目标", "O2 约束", "Plan 步骤", "Do 执行", "Check 验收", "Action 复盘/沉淀"],
            "stopRules": ["缺关键约束先问", "发现 secret 立即停止", "发现并发冲突立即停止", "真实项目写入前先给计划和验收标准"],
        },
        "permissions": {
            "defaultMode": "read_only",
            "writeRequires": "川哥明确授权 + 计划 + diff 范围 + 验收命令；/workspace/readonly 始终只读",
            "commitPushOwner": "Codex/cc 收口，OMP/Grok 默认不直接 commit/push",
            "dangerousActions": DANGEROUS_PATTERNS,
        },
        "workflows": workflows,
        "projects": projects,
        "promptEndpoint": "/vibe/harness-prompt",
        "jsonEndpoint": "/vibe/harness.json",
    }


def harness_prompt():
    payload = harness_payload()
    return """你正在 ops.hahaxiong.top 的 AI Ops Vibe Coding 终端中工作。请先遵守以下 Harness，不要绕过。

核心要求：
1. 全程中文，称呼用户为川哥。
2. 默认只读；任何写文件、重启、部署、删除、commit、push 前，必须先说明 O1/O2、风险、计划、回滚点和验收命令，等待明确确认。
3. 真实项目接入前，不能凭空假设路径、密钥、部署方式；先读项目规则和 README。
4. secret、Webhook、Kuma Push URL、OAuth code/token、密码、cookie、API key 不得输出到文档、git、记忆或日志摘要。
5. 遇到 UI 白屏/接口异常/服务不响应，必须先做根因检查和真实页面验收，不能只看 HTTP 200。
6. 输出按 BRO-PDCA：O1/O2 → Plan → Do/建议 → Check 验收 → Action 沉淀。

Harness JSON：
```json
""" + json.dumps(payload, ensure_ascii=False, indent=2) + "\n```\n"

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
        ("实战试点", "/vibe/pilot", "pilot"),
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


def render_vibe_pilot_page():
    payload = pilot_payload()
    project_options = "".join(
        f"<option value='{html.escape(item['name'])}'>{html.escape(item['name'])}</option>"
        for item in payload["projects"]
    )
    workflow_options = "".join(
        f"<option value='{html.escape(item['id'])}'>{html.escape(item['name'])} / {html.escape(item['permission'])}</option>"
        for item in payload["workflowMatrix"]
        if item["id"] in ("readonly_inspect", "plan_design")
    )
    project_rows = "".join(
        f"<tr><td><a href='/vibe/project?id={html.escape(item['name'])}'>{html.escape(item['name'])}</a></td><td><code>{html.escape(item['path'])}</code></td><td>{html.escape(item['risk'])}</td><td>{len(item['allowlist'])}</td><td>{'已就绪' if item['context'].get('ok') else '未就绪'} / {len(item['context'].get('files', []))} 文件</td></tr>"
        for item in payload["projects"]
    )
    workflow_rows = "".join(
        f"<tr><td>{html.escape(item['name'])}</td><td>{html.escape(item['permission'])}</td><td>{html.escape('、'.join(item['allowed']))}</td><td>{html.escape('、'.join(item['blocked']))}</td></tr>"
        for item in payload["workflowMatrix"]
    )
    acceptance_items = "".join(f"<li>{html.escape(item)}</li>" for item in payload["acceptance"])
    return f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>实战试点 - AI Ops</title><style>
body{{margin:0;background:#0f172a;color:#e5e7eb;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif}}main{{max-width:1180px;margin:0 auto;padding:28px}}.hero,.card{{background:#111827;border:1px solid #334155;border-radius:18px;padding:22px;margin:16px 0;box-shadow:0 20px 60px #0005}}.hero{{background:linear-gradient(135deg,#111827,#172554)}}.muted{{color:#94a3b8}}a{{color:#93c5fd}}button,a.btn{{display:inline-block;background:#2563eb;color:white;border:0;border-radius:10px;padding:10px 14px;text-decoration:none;cursor:pointer;margin:4px 8px 4px 0}}select{{background:#020617;color:#e5e7eb;border:1px solid #334155;border-radius:10px;padding:10px;margin:4px 8px 4px 0}}table{{width:100%;border-collapse:collapse}}td,th{{border-bottom:1px solid #263244;padding:10px;text-align:left;vertical-align:top}}code{{background:#020617;padding:2px 6px;border-radius:6px;word-break:break-all}}pre{{white-space:pre-wrap;background:#020617;border:1px solid #334155;border-radius:12px;padding:12px;max-height:360px;overflow:auto}}.topnav{{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px}}.topnav a{{color:#cbd5e1;text-decoration:none;background:#1f2937;border:1px solid #334155;border-radius:999px;padding:8px 12px}}.topnav a.active{{background:#2563eb;color:white}}.warn{{color:#f59e0b}}
</style></head><body><main>{nav_html('pilot')}<section class="hero"><h1>真实项目实战试点</h1><p class="muted">先跑低风险只读/方案任务，验证 Harness、记忆、BRO-PDCA、工作流和权限矩阵，再逐步开放更高权限。</p><p><a class="btn" href="/vibe/">返回 Vibe</a><a class="btn" href="/vibe/pilot.json">查看 JSON</a><a class="btn" href="/vibe/tasks" data-token-link="true">任务审计</a><a class="btn" href="/vibe/todos" data-token-link="true">AI 待办</a></p></section><section class="card"><h2>一键试点</h2><p class="muted">当前只允许“只读巡检”和“方案设计”；补丁草案/部署验收仅展示权限矩阵，不开放一键执行。</p><select id="pilotProject">{project_options}</select><select id="pilotWorkflow">{workflow_options}</select><label><input id="pilotNotify" type="checkbox"> 完成后飞书通知</label><p><button id="runPilotBtn">发送试点任务给 Grok</button></p><pre id="pilotResult">等待试点任务。</pre></section><section class="card"><h2>项目级 Allowlist</h2><table><thead><tr><th>项目</th><th>只读路径</th><th>风险说明</th><th>清单文件数</th><th>上下文状态</th></tr></thead><tbody>{project_rows}</tbody></table></section><section class="card"><h2>Workflow 权限矩阵</h2><table><thead><tr><th>Workflow</th><th>权限</th><th>允许</th><th>禁止</th></tr></thead><tbody>{workflow_rows}</tbody></table></section><section class="card"><h2>验收标准</h2><ul>{acceptance_items}</ul></section></main><script>
sessionStorage.setItem('aiopsReadToken', '{READ_TOKEN}');
document.querySelectorAll('[data-token-link="true"]').forEach((link) => {{
  link.addEventListener('click', () => sessionStorage.setItem('aiopsReadToken', '{READ_TOKEN}'));
}});
document.getElementById('runPilotBtn').addEventListener('click', async () => {{
  const result = document.getElementById('pilotResult');
  const button = document.getElementById('runPilotBtn');
  button.disabled = true;
  result.textContent = '正在提交试点任务...';
  try {{
    const response = await fetch('/vibe/pilot/run', {{ method: 'POST', credentials: 'same-origin', headers: {{ 'content-type': 'application/json', 'X-AIOps-Read-Token': '{READ_TOKEN}' }}, body: JSON.stringify({{ project: document.getElementById('pilotProject').value, workflow: document.getElementById('pilotWorkflow').value, notify: document.getElementById('pilotNotify').checked }}) }});
    const data = await response.json();
    result.textContent = JSON.stringify(data, null, 2);
    if (data.ok && data.jobId) {{
      await pollPilotJob(data.jobId, result);
    }}
  }} catch (error) {{
    result.textContent = String(error);
  }} finally {{
    button.disabled = false;
  }}
}});
async function pollPilotJob(jobId, result) {{
  const startedAt = Date.now();
  for (let attempt = 0; attempt < 90; attempt += 1) {{
    await new Promise(resolve => setTimeout(resolve, 2000));
    const response = await fetch(`/vibe/pilot/job?id=${{encodeURIComponent(jobId)}}`, {{ credentials: 'same-origin' }});
    const data = await response.json();
    result.textContent = JSON.stringify(data, null, 2) + `\\n\\n运行中 ${{Math.round((Date.now() - startedAt) / 1000)}}s；完成后去 /vibe/tasks 查看完整审计。`;
    if (data.status === 'done' || data.status === 'failed') return;
  }}
  result.textContent += '\\n\\n任务仍在后台运行，请稍后到 /vibe/tasks 查看。';
}}
</script></body></html>"""


def render_vibe_project_page(project_id):
    payload = project_workspace_panel(project_id)
    if not payload:
        return "<!doctype html><html lang='zh-CN'><body><h1>项目不存在</h1><p><a href='/vibe/pilot'>返回实战试点</a></p></body></html>"
    project = payload["project"]
    context = payload.get("context") or {}
    production = project.get("production") or {}
    allowlist_rows = "".join(f"<tr><td><code>{html.escape(path)}</code></td></tr>" for path in project["allowlist"])
    production_rows = "".join(
        f"<tr><th>{html.escape(label)}</th><td><code>{html.escape(str(production.get(key) or '-'))}</code></td></tr>"
        for label, key in [("域名", "domain"), ("SSH 别名", "sshAlias"), ("地址", "address"), ("部署目录", "path"), ("进程管理", "processManager"), ("进程", "process"), ("核实日期", "verifiedAt")]
    ) if production else "<tr><td>尚未登记生产目标</td></tr>"
    task_rows = "".join(f"<tr><td>{html.escape(item.get('createdAt') or '')}</td><td>{html.escape(item.get('modeName') or '')}</td><td>{'成功' if item.get('ok') else '失败'}</td><td><code>{html.escape(item.get('id') or '')}</code></td></tr>" for item in payload["recentTasks"]) or "<tr><td colspan=4>暂无任务</td></tr>"
    todo_rows = "".join(f"<tr><td>{html.escape(item.get('createdAt') or '')}</td><td>{html.escape(item.get('status') or '')}</td><td>{html.escape(item.get('title') or '')}</td><td><a href='/vibe/todos/detail?id={html.escape(item.get('id') or '')}'>详情</a></td></tr>" for item in payload["openTodos"]) or "<tr><td colspan=4>暂无未完成待办</td></tr>"
    workflow_rows = "".join(f"<tr><td>{html.escape(item['name'])}</td><td>{html.escape(item['permission'])}</td><td>{html.escape('、'.join(item['allowed']))}</td><td>{html.escape('、'.join(item['blocked']))}</td></tr>" for item in payload["workflowMatrix"])
    daily = (payload.get("dailyInspection") or {}).get("latest") or {}
    daily_status = "尚未执行" if not daily else ("通过" if daily.get("ok") else "需要关注")
    daily_live = daily.get("live") or {}
    daily_snapshot = daily.get("snapshot") or {}
    maintenance = payload.get("productionMaintenance") or {}
    maintenance_latest = maintenance.get("latest") or {}
    maintenance_result = maintenance_latest.get("result") or {}
    maintenance_process = maintenance_result.get("process") or {}
    return f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{html.escape(project['name'])} - 项目工作区</title><style>
body{{margin:0;background:#0f172a;color:#e5e7eb;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif}}main{{max-width:1180px;margin:0 auto;padding:28px}}.card{{background:#111827;border:1px solid #334155;border-radius:18px;padding:20px;margin:16px 0}}.muted{{color:#94a3b8}}.ok{{color:#22c55e}}.warn{{color:#f59e0b}}a{{color:#93c5fd}}button{{background:#2563eb;color:white;border:0;border-radius:10px;padding:10px 14px;cursor:pointer}}table{{width:100%;border-collapse:collapse}}td,th{{border-bottom:1px solid #263244;padding:10px;text-align:left;vertical-align:top}}code{{background:#020617;padding:2px 6px;border-radius:6px;word-break:break-all}}pre{{white-space:pre-wrap;background:#020617;border:1px solid #334155;border-radius:12px;padding:12px}}.topnav{{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px}}.topnav a{{color:#cbd5e1;text-decoration:none;background:#1f2937;border:1px solid #334155;border-radius:999px;padding:8px 12px}}.topnav a.active{{background:#2563eb;color:white}}
</style></head><body><main>{nav_html('pilot')}<section class="card"><h1>{html.escape(project['name'])} 项目工作区</h1><p class="muted">只读路径：<code>{html.escape(project['path'])}</code></p><p>{html.escape(project['risk'])}</p><p><strong>真实上下文：</strong>{'已就绪' if context.get('ok') else '未就绪'}，已注入 {len(context.get('files', []))} 个文件 / {context.get('chars', 0)} 字符，截断：{'是' if context.get('truncated') else '否'}。</p><p><a href="/vibe/pilot">返回实战试点</a> · <a href="/vibe/tasks" data-token-link="true">任务审计</a> · <a href="/vibe/todos" data-token-link="true">AI 待办</a></p></section><section class="card"><h2>每日 AI 巡检</h2><p>最近状态：<strong class="{'ok' if daily.get('ok') else 'warn'}">{html.escape(daily_status)}</strong> · 实时探测 {daily_live.get('passed', 0)}/{daily_live.get('total', 0)} · 快照 {daily_snapshot.get('ageHours', '-')} 小时</p><p class="muted">每日由 n8n 自动触发；包含关键页面/资源探测、生产 PM2 限权巡检、Grok 4.5 源码分析、异常待办、飞书通知和 Kuma 心跳。</p><button id="runDailyBtn">立即执行一次只读巡检</button><pre id="dailyResult">{html.escape(json.dumps(daily, ensure_ascii=False, indent=2) if daily else '等待首次执行。')}</pre></section><section class="card"><h2>生产维护通道</h2><p>通道：<strong class="{'ok' if maintenance.get('configured') else 'warn'}">{'已限权接入' if maintenance.get('configured') else '未接入'}</strong> · PM2：{html.escape(str(maintenance_process.get('status') or '待巡检'))}</p><p class="muted">专用 SSH key 只能执行 <code>inspect</code> 和 <code>restart</code>；禁止任意 shell、部署、文件写入。重启需要动作权限、明确确认、10 分钟冷却，并在完成后自动跑 6 项公网验收。</p><button id="inspectProductionBtn">巡检生产状态</button><button id="restartProductionBtn">确认后重启个人站</button><pre id="productionResult">{html.escape(json.dumps(maintenance_latest, ensure_ascii=False, indent=2) if maintenance_latest else '等待首次生产巡检。')}</pre></section><section class="card"><h2>已核实生产目标</h2><table><tbody>{production_rows}</tbody></table></section><section class="card"><h2>Allowlist 文件</h2><table><tbody>{allowlist_rows}</tbody></table></section><section class="card"><h2>最近任务</h2><table><thead><tr><th>时间</th><th>模式</th><th>状态</th><th>ID</th></tr></thead><tbody>{task_rows}</tbody></table></section><section class="card"><h2>未完成待办</h2><table><thead><tr><th>时间</th><th>状态</th><th>标题</th><th>入口</th></tr></thead><tbody>{todo_rows}</tbody></table></section><section class="card"><h2>Workflow 权限矩阵</h2><table><thead><tr><th>Workflow</th><th>权限</th><th>允许</th><th>禁止</th></tr></thead><tbody>{workflow_rows}</tbody></table></section></main><script>
sessionStorage.setItem('aiopsReadToken', '{READ_TOKEN}');
document.getElementById('runDailyBtn').addEventListener('click', async () => {{
  const button = document.getElementById('runDailyBtn');
  const result = document.getElementById('dailyResult');
  button.disabled = true;
  result.textContent = '已提交，正在执行实时探测与 Grok 4.5 分析，通常需要 1-4 分钟...';
  try {{
    const response = await fetch('/vibe/project/daily/run', {{method:'POST',credentials:'same-origin',headers:{{'content-type':'application/json','X-AIOps-Read-Token':'{READ_TOKEN}'}},body:JSON.stringify({{project:'{html.escape(project_id)}',forceNotify:true}})}});
    const queued = await response.json();
    if (!queued.ok) throw new Error(queued.error || '提交失败');
    for (let attempt = 0; attempt < 60; attempt += 1) {{
      await new Promise(resolve => setTimeout(resolve, 5000));
      const poll = await fetch(queued.pollUrl, {{credentials:'same-origin'}});
      const job = await poll.json();
      result.textContent = JSON.stringify(job, null, 2);
      if (!['queued','running'].includes(job.status)) break;
    }}
  }} catch (error) {{
    result.textContent = '执行失败：' + error;
  }} finally {{
    button.disabled = false;
  }}
}});
async function runProductionAction(action) {{
  const result = document.getElementById('productionResult');
  const isRestart = action === 'restart';
  let confirmation = '';
  if (isRestart) {{
    confirmation = window.prompt('这是生产重启。请输入 RESTART_CHENCHUAN_SITE 确认；系统不会部署或修改文件。') || '';
    if (confirmation !== 'RESTART_CHENCHUAN_SITE') {{ result.textContent = '已取消：确认文字不匹配。'; return; }}
  }}
  result.textContent = isRestart ? '已提交生产重启，完成后会自动验收公网 6 项...' : '正在读取生产 PM2、部署与磁盘状态...';
  const tokenHeader = isRestart ? {{'X-AIOps-Action-Token':'{ACTION_TOKEN}'}} : {{'X-AIOps-Read-Token':'{READ_TOKEN}'}};
  try {{
    const response = await fetch('/vibe/project/production/action', {{method:'POST',credentials:'same-origin',headers:{{'content-type':'application/json',...tokenHeader}},body:JSON.stringify({{project:'{html.escape(project_id)}',action,confirmation}})}});
    const queued = await response.json();
    if (!queued.ok) throw new Error(queued.error || '提交失败');
    for (let attempt = 0; attempt < 36; attempt += 1) {{
      await new Promise(resolve => setTimeout(resolve, 3000));
      const poll = await fetch(queued.pollUrl, {{credentials:'same-origin'}});
      const job = await poll.json();
      result.textContent = JSON.stringify(job, null, 2);
      if (!['queued','running'].includes(job.status)) break;
    }}
  }} catch (error) {{
    result.textContent = '执行失败：' + error;
  }}
}}
document.getElementById('inspectProductionBtn').addEventListener('click', () => runProductionAction('inspect'));
document.getElementById('restartProductionBtn').addEventListener('click', () => runProductionAction('restart'));
</script></body></html>"""



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
cd /tmp && omp --model xai-oauth/grok-4.5 -p "$(cat /tmp/ai-ops-prompt.txt)"</pre></section>
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
        {"name": "mycc", "path": "/workspace/readonly/mycc", "purpose": "本机 AI 协作中枢只读快照", "start": "cd /workspace/readonly/mycc && git status --short --branch"},
        {"name": "个人站", "path": "/workspace/readonly/chenchuan-site", "purpose": "个人站开发、构建、部署检查只读快照", "start": "cd /workspace/readonly/chenchuan-site && git status --short --branch"},
        {"name": "MyJavis", "path": "/workspace/readonly/MyJavis", "purpose": "MyJavis 服务、备份、发布相关检查只读快照", "start": "cd /workspace/readonly/MyJavis && git status --short --branch"},
        {"name": "Voice Agent", "path": "/workspace/readonly/realtime-voice-agent", "purpose": "实时语音 Agent 与声纹链路只读快照", "start": "cd /workspace/readonly/realtime-voice-agent && git status --short --branch"},
        {"name": "P003", "path": "/workspace/readonly/P003GameDemo20260513", "purpose": "P003 游戏 demo / 实验项目只读快照", "start": "cd /workspace/readonly/P003GameDemo20260513 && git status --short --branch"},
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
        {"label": "重启 OMP", "command": "omp --model xai-oauth/grok-4.5 --cwd /workspace/projects/ai-ops-cockpit"},
        {"label": "一键只读巡检", "command": "omp --model xai-oauth/grok-4.5 -p '请只读检查当前 AI Ops 驾驶舱状态，列出异常、风险、建议和验收命令。'"},
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
    harness = harness_payload()
    project_cards = "".join(
        f"""<div class="card"><h2>{html.escape(item['name'])}</h2><p class="muted">{html.escape(item['purpose'])}</p><p><code>{html.escape(item['path'])}</code></p><button data-copy="{html.escape(item['start'])}">复制启动命令</button></div>"""
        for item in payload["projects"]
    )
    workflow_parts = []
    base_harness_prompt = harness_prompt()
    for item in harness["workflows"]:
        prompt_text = base_harness_prompt + "\n\n当前工作模式：" + item["prompt"]
        omp_command = "omp --model xai-oauth/grok-4.5 -p " + json.dumps(prompt_text, ensure_ascii=False)
        workflow_parts.append(
            f"""<div class="card"><h2>{html.escape(item['name'])}</h2><p class="muted">权限：{html.escape(item['permission'])}</p><p>{html.escape(item['prompt'])}</p><button data-copy="{html.escape(omp_command)}">复制 Harness OMP 命令</button></div>"""
        )
    workflow_cards = "".join(workflow_parts)
    command_rows = "".join(
        f"""<tr><td>{html.escape(item['label'])}</td><td><code>{html.escape(item['command'])}</code></td><td><button data-copy="{html.escape(item['command'])}">复制</button></td></tr>"""
        for item in payload["commands"]
    )
    server_rows = "".join(
        f"""<tr><td>{html.escape(item['name'])}</td><td>{html.escape(item['target'])}</td><td><code>{html.escape(item['command'])}</code></td><td><button data-copy="{html.escape(item['command'])}">复制</button></td></tr>"""
        for item in payload["servers"]
    )
    template_cards = "".join(
        f"""<div class="card"><h2>{html.escape(item['label'])}</h2><p class="muted">{html.escape(item['prompt'])}</p><button data-copy="{html.escape('omp --model xai-oauth/grok-4.5 -p ' + json.dumps(item['prompt'], ensure_ascii=False))}">复制 OMP 命令</button></div>"""
        for item in payload["templates"]
    )
    session_rows = "".join(
        f"""<tr><td>{html.escape(item['name'])}</td><td>{item['sizeBytes']}</td><td>{html.escape(item['updatedAt'])}</td><td><details><summary>预览</summary><pre>{html.escape(item['preview'])}</pre></details></td></tr>"""
        for item in status["sessions"]
    ) or "<tr><td colspan=4>暂无日志</td></tr>"
    guardrail_items = "".join(f"<li>{html.escape(item)}</li>" for item in payload["guardrails"])
    dangerous = "、".join(DANGEROUS_PATTERNS)
    status_class = "ok" if status["ok"] else "warn"
    return f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vibe Coding - AI Ops</title><style>
body{{margin:0;background:#0f172a;color:#e5e7eb;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif}}main{{max-width:1240px;margin:0 auto;padding:28px}}.hero{{background:linear-gradient(135deg,#111827,#172554);border:1px solid #334155;border-radius:24px;padding:28px;margin-bottom:18px;box-shadow:0 24px 80px #0006}}.grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}}.card{{background:#111827;border:1px solid #334155;border-radius:18px;padding:20px;margin:16px 0;box-shadow:0 20px 60px #0005}}.muted{{color:#94a3b8}}.ok{{color:#22c55e}}.warn{{color:#f59e0b}}a{{color:#93c5fd}}button,a.btn{{display:inline-block;background:#2563eb;color:white;border:0;border-radius:10px;padding:10px 14px;text-decoration:none;cursor:pointer;margin:4px 8px 4px 0}}code{{background:#020617;padding:2px 6px;border-radius:6px;word-break:break-all}}table{{width:100%;border-collapse:collapse}}td,th{{border-bottom:1px solid #263244;padding:10px;text-align:left;vertical-align:top}}pre{{white-space:pre-wrap;background:#020617;border:1px solid #334155;border-radius:12px;padding:12px;max-height:280px;overflow:auto}}.chat div{{border:1px solid #334155;border-radius:14px;padding:12px;margin:10px 0}}.chat .user{{background:#172554}}.chat .assistant{{background:#111827}}.topnav{{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px}}.topnav a{{color:#cbd5e1;text-decoration:none;background:#1f2937;border:1px solid #334155;border-radius:999px;padding:8px 12px}}.topnav a.active{{background:#2563eb;color:white}}.terminal{{height:58vh;border:1px solid #334155;border-radius:18px;overflow:hidden;background:#020617}}iframe{{border:0;width:100%;height:100%}}.pill{{display:inline-block;border:1px solid #334155;border-radius:999px;padding:6px 10px;margin:4px;background:#0b1220}}
</style></head><body><main>{nav_html('vibe')}<section class="hero"><h1>Vibe Coding 工作台</h1><p class="muted">打开终端会自动进入带 Harness 的 Grok 版 OMP；真实项目接入前先固定规则、记忆、BRO-PDCA、工作流和权限边界。</p><p><span class="pill {status_class}">终端/OMP：{html.escape('正常' if status['ok'] else '需要关注')}</span><span class="pill">Harness：AI Ops Harness v1</span><span class="pill">默认只读</span><span class="pill">日志 {len(status['sessions'])} 条</span></p><p><a class="btn" href="/terminal/" target="_blank">新窗口打开终端</a><button id="restartTerminalBtn">重启终端容器</button><a class="btn" href="/vibe/pilot">实战试点</a><a class="btn" href="/vibe/harness.json">Harness JSON</a><a class="btn" href="/vibe/harness-prompt">Harness Prompt</a><a class="btn" href="/vibe/tasks" data-token-link="true">任务审计</a><a class="btn" href="/vibe/todos" data-token-link="true">AI 待办</a><a class="btn" href="/vibe/assets">资产矩阵</a><button id="refreshReadonlyBtn">刷新只读快照</button><button id="runN8nInspectBtn">触发手动巡检</button></p><pre id="actionResult">等待操作。</pre><p class="muted" id="readonlyStatus">只读快照：检查中...</p></section><section class="card"><h2>实战前护栏</h2><p class="muted">先从低风险项目开始：选择项目、选择只读/方案 workflow、发送给 Grok，结果进入任务审计并可转待办。</p><p><a class="btn" href="/vibe/pilot">进入真实项目实战试点</a></p></section><section class="card"><h2>连续对话</h2><p class="muted">保留本页上下文继续问 Grok；刷新页面会清空上下文。</p><div id="chatHistory" class="chat"><p class="muted">暂无对话。</p></div></section><section class="card"><h2>发任务给 Grok</h2><p class="muted">无需进入终端，选择工作模式后直接发送只读任务。默认禁用工具调用；留空会自动执行默认只读巡检。</p><select id="taskMode"><option value="readonly_inspect">只读巡检</option><option value="plan_design">方案设计</option><option value="patch_draft">补丁草案</option><option value="deploy_verify">部署验收</option></select><textarea id="taskQuestion" rows="4" placeholder="例如：请只读检查 AI Ops 当前状态，并列出风险和下一步。">请只读检查当前 AI Ops 驾驶舱状态，按异常、风险、建议、验收命令输出。</textarea><p><label><input id="notifyFeishu" type="checkbox"> 完成后飞书通知</label></p><p><button id="sendTaskBtn">发送给 Grok</button><button id="clearTaskBtn" type="button">清空重写</button><button id="clearChatBtn" type="button">清空对话</button><a class="btn" href="/vibe/tasks" data-token-link="true">查看任务审计</a></p><p class="muted" id="taskStatus">状态：待发送</p><pre id="taskResult">等待任务。</pre></section><section class="card"><h2>内嵌终端</h2><p class="muted">打开后会自动加载 Harness prompt 并启动 <code>omp --model xai-oauth/grok-4.5</code>。默认只读；写入/部署必须先确认。</p><div class="terminal"><iframe src="/terminal/" title="Vibe Terminal"></iframe></div></section><section><h2>工作模式</h2><div class="grid">{workflow_cards}</div></section><section><h2>项目入口</h2><div class="grid">{project_cards}</div></section><section class="card"><h2>服务器入口</h2><table><thead><tr><th>服务器</th><th>说明</th><th>命令</th><th>操作</th></tr></thead><tbody>{server_rows}</tbody></table></section><section class="card"><h2>常用命令</h2><table><thead><tr><th>用途</th><th>命令</th><th>操作</th></tr></thead><tbody>{command_rows}</tbody></table></section><section><h2>AI 任务模板</h2><div class="grid">{template_cards}</div></section><section class="card"><h2>审计日志</h2><p class="muted">最近终端日志，只展示尾部预览。完整日志在远端 <code>/opt/ai-ops-cockpit/terminal/logs/</code>。</p><table><thead><tr><th>文件</th><th>大小</th><th>更新时间</th><th>预览</th></tr></thead><tbody>{session_rows}</tbody></table></section><section class="card"><h2>护栏</h2><p class="muted">高危关键词：{html.escape(dangerous)}</p><ul>{guardrail_items}</ul></section></main><script>
document.querySelectorAll('[data-copy]').forEach((button) => {{
  button.addEventListener('click', async () => {{
    await navigator.clipboard.writeText(button.dataset.copy);
    const oldText = button.textContent;
    button.textContent = '已复制';
    setTimeout(() => button.textContent = oldText, 1200);
  }});
}});
sessionStorage.setItem('aiopsReadToken', '{READ_TOKEN}');
document.querySelectorAll('[data-token-link="true"]').forEach((link) => {{
  link.addEventListener('click', () => sessionStorage.setItem('aiopsReadToken', '{READ_TOKEN}'));
}});
document.getElementById('clearTaskBtn').addEventListener('click', () => {{
  const input = document.getElementById('taskQuestion');
  input.value = '';
  input.focus();
}});
document.getElementById('clearChatBtn').addEventListener('click', () => {{
  document.getElementById('chatHistory').innerHTML = '<p class="muted">暂无对话。</p>';
  document.getElementById('taskStatus').textContent = '状态：已清空对话';
}});
document.getElementById('sendTaskBtn').addEventListener('click', async () => {{
  const result = document.getElementById('taskResult');
  const input = document.getElementById('taskQuestion');
  const question = input.value.trim() || '请只读检查当前 AI Ops 驾驶舱状态，按异常、风险、建议、验收命令输出。';
  input.value = question;
  const startedAt = Date.now();
  const status = document.getElementById('taskStatus');
  result.textContent = '正在发送给 Grok，通常需要 30-120 秒...';
  status.textContent = '状态：运行中 0s';
  const timer = setInterval(() => {{ status.textContent = `状态：运行中 ${{Math.round((Date.now() - startedAt) / 1000)}}s`; }}, 1000);
  const conversation = Array.from(document.querySelectorAll('[data-chat-line]')).map(node => node.textContent).join('\\n');
  try {{
    const response = await fetch('/vibe/task/run', {{ method: 'POST', credentials: 'same-origin', headers: {{ 'content-type': 'application/json', 'X-AIOps-Read-Token': '{READ_TOKEN}' }}, body: JSON.stringify({{ mode: document.getElementById('taskMode').value, question, conversation, notify: document.getElementById('notifyFeishu').checked }}) }});
    const data = await response.json();
    result.textContent = JSON.stringify(data, null, 2);
    status.textContent = `状态：${{data.ok ? '完成' : '失败'}}，耗时 ${{data.durationMs || (Date.now() - startedAt)}}ms${{data.error ? '，原因：' + data.error : ''}}`;
    appendChat('川哥', question, 'user');
    appendChat('Grok', data.answer || data.error || JSON.stringify(data), 'assistant');
  }} catch (error) {{
    result.textContent = String(error);
    status.textContent = '状态：请求失败，原因：' + error;
  }} finally {{
    clearInterval(timer);
  }}
}});
function appendChat(role, text, kind) {{
  const history = document.getElementById('chatHistory');
  if (history.querySelector('.muted')) history.innerHTML = '';
  const item = document.createElement('div');
  item.setAttribute('data-chat-line', 'true');
  item.className = kind || '';
  item.innerHTML = `<p><strong>${{role}}</strong></p><pre>${{String(text || '').replace(/[&<>]/g, ch => ({{'&':'&amp;','<':'&lt;','>':'&gt;'}}[ch]))}}</pre>`;
  history.appendChild(item);
}}
document.getElementById('restartTerminalBtn').addEventListener('click', async () => {{
  const result = document.getElementById('actionResult');
  result.textContent = '正在重启 ops-terminal...';
  const response = await fetch('/vibe/action/restart-terminal', {{ method: 'POST', credentials: 'same-origin', headers: {{ 'X-AIOps-Action-Token': '{ACTION_TOKEN}' }} }});
  const data = await response.json();
  result.textContent = JSON.stringify(data, null, 2);
}});
async function loadReadonlyStatus() {{
  const response = await fetch('/vibe/readonly-refresh.json', {{ credentials: 'same-origin' }});
  const data = await response.json();
  document.getElementById('readonlyStatus').textContent = `只读快照：${{data.mounted ? '已挂载' : '未就绪'}}，最后刷新：${{data.refreshedAt || data.mountedAt || '未知'}}`;
}}
document.getElementById('runN8nInspectBtn').addEventListener('click', async () => {{
  const result = document.getElementById('actionResult');
  result.textContent = '正在触发内部手动巡检...';
  const response = await fetch('/vibe/action/n8n-inspect', {{ method: 'POST', credentials: 'same-origin', headers: {{ 'X-AIOps-Read-Token': '{READ_TOKEN}' }} }});
  const data = await response.json();
  result.textContent = JSON.stringify(data, null, 2);
}});
document.getElementById('refreshReadonlyBtn').addEventListener('click', async () => {{
  const result = document.getElementById('actionResult');
  result.textContent = '正在刷新只读快照...';
  const response = await fetch('/vibe/action/refresh-readonly', {{ method: 'POST', credentials: 'same-origin', headers: {{ 'X-AIOps-Read-Token': '{READ_TOKEN}' }} }});
  const data = await response.json();
  result.textContent = JSON.stringify(data, null, 2);
  loadReadonlyStatus();
}});
loadReadonlyStatus();
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

    def _read_json_body(self, limit=10000):
        length = int(self.headers.get("content-length") or 0)
        if length <= 0:
            return {}
        if length > limit:
            raise ValueError("request body too large")
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def _is_same_origin_post(self):
        host = self.headers.get("host", "")
        seen_origin_header = False
        for header in ("origin", "referer"):
            value = self.headers.get(header)
            seen_origin_header = seen_origin_header or bool(value)
            if value and urlparse(value).netloc != host:
                return False
        return seen_origin_header

    def _has_read_token(self):
        return self.headers.get(READ_HEADER) == READ_TOKEN

    def _has_action_token(self):
        return self.headers.get(ACTION_HEADER) == ACTION_TOKEN

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
            elif path == "/vibe/harness.json":
                self._send_json(200, harness_payload())
            elif path == "/vibe/harness-prompt":
                self._send_text(200, harness_prompt())
            elif path == "/vibe/status.json":
                self._send_json(200, vibe_status_payload())
            elif path == "/vibe/workspaces-status.json":
                self._send_json(200, workspace_status_payload())
            elif path == "/vibe/assets.json":
                self._send_json(200, assets_payload())
            elif path == "/vibe/readonly-refresh.json":
                self._send_json(200, readonly_refresh_status())
            elif path == "/vibe/allowlist.json":
                self._send_json(200, allowlist_payload())
            elif path == "/vibe/pilot.json":
                self._send_json(200, pilot_payload())
            elif path == "/vibe/pilot/job":
                job_id = parse_qs(urlparse(self.path).query).get("id", [""])[0]
                job = load_pilot_job(job_id)
                self._send_json(200 if job else 404, job or {"ok": False, "error": "pilot job not found"})
            elif path == "/vibe/project.json":
                project_id = parse_qs(urlparse(self.path).query).get("id", [""])[0]
                payload = project_workspace_panel(project_id)
                self._send_json(200 if payload else 404, payload or {"ok": False, "error": "project not found"})
            elif path == "/vibe/project/live.json":
                project_id = parse_qs(urlparse(self.path).query).get("id", [""])[0]
                payload = project_live_check(project_id)
                self._send_json(200 if payload.get("total") else 404, payload)
            elif path == "/vibe/project/daily.json":
                project_id = parse_qs(urlparse(self.path).query).get("id", [""])[0]
                payload = project_daily_status_payload(project_id)
                self._send_json(200 if payload else 404, payload or {"ok": False, "error": "project daily inspection not configured"})
            elif path == "/vibe/project/daily/job":
                job_id = parse_qs(urlparse(self.path).query).get("id", [""])[0]
                job = load_project_daily_job(job_id)
                self._send_json(200 if job else 404, job or {"ok": False, "error": "daily job not found"})
            elif path == "/vibe/project/production.json":
                project_id = parse_qs(urlparse(self.path).query).get("id", [""])[0]
                payload = project_production_status_payload(project_id)
                self._send_json(200 if payload else 404, payload or {"ok": False, "error": "project production maintenance not configured"})
            elif path == "/vibe/project/production/job":
                job_id = parse_qs(urlparse(self.path).query).get("id", [""])[0]
                job = load_project_production_job(job_id)
                self._send_json(200 if job else 404, job or {"ok": False, "error": "production job not found"})
            elif path == "/vibe/todos/job":
                job_id = parse_qs(urlparse(self.path).query).get("id", [""])[0]
                job = load_todo_job(job_id)
                self._send_json(200 if job else 404, job or {"ok": False, "error": "todo job not found"})
            elif path in ("/vibe/project", "/vibe/project/"):
                project_id = parse_qs(urlparse(self.path).query).get("id", [""])[0]
                self._send_text(200, render_vibe_project_page(project_id), "text/html; charset=utf-8")
            elif path in ("/vibe/pilot", "/vibe/pilot/"):
                self._send_text(200, render_vibe_pilot_page(), "text/html; charset=utf-8")
            elif path == "/vibe/kuma-context.json":
                self._send_json(200, kuma_context_payload())
            elif path == "/vibe/report.json":
                kind = parse_qs(urlparse(self.path).query).get("kind", ["daily"])[0]
                self._send_json(200, ops_report_payload(kind))
            elif path in ("/vibe/assets", "/vibe/assets/"):
                self._send_text(200, render_assets_page(), "text/html; charset=utf-8")
            elif path == "/vibe/tasks.json":
                if not self._has_read_token():
                    self._send_json(403, {"ok": False, "error": "read token required"})
                    return
                self._send_json(200, {"tasks": task_history(50)})
            elif path in ("/vibe/tasks", "/vibe/tasks/"):
                self._send_text(200, render_vibe_tasks_page(), "text/html; charset=utf-8")
            elif path == "/vibe/todos.json":
                if not self._has_read_token():
                    self._send_json(403, {"ok": False, "error": "read token required"})
                    return
                self._send_json(200, {"todos": todo_history(100)})
            elif path in ("/vibe/todos", "/vibe/todos/"):
                self._send_text(200, render_vibe_todos_page(), "text/html; charset=utf-8")
            elif path in ("/vibe/todos/detail", "/vibe/todos/detail/"):
                todo_id = parse_qs(urlparse(self.path).query).get("id", [""])[0]
                self._send_text(200, render_vibe_todo_detail_page(todo_id), "text/html; charset=utf-8")
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
                if not self._has_action_token():
                    self._send_json(403, {"ok": False, "error": "action token required"})
                    return
                self._send_json(200, terminal_action_payload("restart"))
            elif path == "/vibe/task/run":
                if not self._has_read_token():
                    self._send_json(403, {"ok": False, "error": "read token required"})
                    return
                payload = self._read_json_body()
                self._send_json(200, run_vibe_task(payload.get("mode"), payload.get("question"), payload.get("conversation"), bool(payload.get("notify"))))
            elif path == "/vibe/action/refresh-readonly":
                if not self._has_read_token():
                    self._send_json(403, {"ok": False, "error": "read token required"})
                    return
                self._send_json(200, refresh_readonly_payload())
            elif path == "/vibe/action/n8n-inspect":
                if not self._has_read_token():
                    self._send_json(403, {"ok": False, "error": "read token required"})
                    return
                self._send_json(200, n8n_manual_inspect_payload())
            elif path == "/vibe/todos/create":
                if not self._has_read_token():
                    self._send_json(403, {"ok": False, "error": "read token required"})
                    return
                payload = self._read_json_body()
                self._send_json(200, create_todo_from_task(payload.get("taskId")))
            elif path == "/vibe/todos/update":
                if not self._has_read_token():
                    self._send_json(403, {"ok": False, "error": "read token required"})
                    return
                payload = self._read_json_body()
                self._send_json(200, update_todo_status(payload.get("todoId"), payload.get("status")))
            elif path == "/vibe/todos/notify":
                if not self._has_read_token():
                    self._send_json(403, {"ok": False, "error": "read token required"})
                    return
                payload = self._read_json_body()
                self._send_json(200, notify_todo(payload.get("todoId")))
            elif path == "/vibe/todos/inspect":
                if not self._has_read_token():
                    self._send_json(403, {"ok": False, "error": "read token required"})
                    return
                payload = self._read_json_body()
                self._send_json(200, inspect_for_todo(payload.get("todoId")))
            elif path == "/vibe/todos/action":
                if not self._has_read_token():
                    self._send_json(403, {"ok": False, "error": "read token required"})
                    return
                payload = self._read_json_body()
                self._send_json(200, start_todo_action(payload))
            elif path == "/vibe/pilot/run":
                if not self._has_read_token():
                    self._send_json(403, {"ok": False, "error": "read token required"})
                    return
                payload = self._read_json_body()
                self._send_json(200, start_pilot_job(payload))
            elif path == "/vibe/project/daily/run":
                if not self._has_read_token():
                    self._send_json(403, {"ok": False, "error": "read token required"})
                    return
                payload = self._read_json_body()
                payload.pop("simulateFailure", None)
                self._send_json(200, start_project_daily_job(payload))
            elif path == "/vibe/project/daily/test":
                if not self._has_action_token():
                    self._send_json(403, {"ok": False, "error": "action token required"})
                    return
                payload = self._read_json_body()
                self._send_json(200, start_project_daily_job(payload))
            elif path == "/vibe/project/production/action":
                payload = self._read_json_body()
                action = (payload.get("action") or "inspect").strip()
                if action == "inspect":
                    if not self._has_read_token():
                        self._send_json(403, {"ok": False, "error": "read token required"})
                        return
                elif action == "restart":
                    if not self._has_action_token():
                        self._send_json(403, {"ok": False, "error": "action token required"})
                        return
                else:
                    self._send_json(400, {"ok": False, "error": "production action not allowed"})
                    return
                self._send_json(200, start_project_production_job(payload))
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
