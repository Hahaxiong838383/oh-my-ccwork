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

import ops_tool_runtime
from self_monitor import monitor_signature, summarize_audits, summarize_omp_update, summarize_tasks, transition_event
from task_lifecycle import ACTIVE_STATUSES, RevisionedTaskStore, TERMINAL_STATUSES, now_text

KUMA_DB = os.environ.get("KUMA_DB", "/kuma/kuma.db")
NETDATA = os.environ.get("NETDATA_URL", "http://netdata:19999")
DISPLAY_HOSTNAME = os.environ.get("DISPLAY_HOSTNAME", "racknerd-54aa08d")
STATE_DIR = os.environ.get("STATE_DIR", "/tmp/ai-ops-state")
ALERT_STATE_FILE = os.path.join(STATE_DIR, "alert-state.json")
DAILY_STATE_FILE = os.path.join(STATE_DIR, "daily-state.json")
SNAPSHOT_FILE = os.path.join(STATE_DIR, "last-report.json")
SELF_MONITOR_STATE_FILE = os.path.join(STATE_DIR, "self-monitor-state.json")
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
AI_OPS_OMP_MODEL = os.environ.get("AI_OPS_OMP_MODEL", "volcengine-coding/deepseek-v4-pro")
AI_OPS_OMP_MODEL_LABEL = os.environ.get("AI_OPS_OMP_MODEL_LABEL", "DeepSeek V4 Pro")
AI_OPS_INTERNAL_TOKEN = os.environ.get("AI_OPS_INTERNAL_TOKEN", "")
AI_OPS_BRAIN_URL = os.environ.get("AI_OPS_BRAIN_URL", "http://ops-brain:8090").rstrip("/")
AI_OPS_TOOL_RUNNER_URL = os.environ.get("AI_OPS_TOOL_RUNNER_URL", "http://ops-tool-runner:8091").rstrip("/")
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
TOOL_AUDIT_DIR = os.environ.get("TOOL_AUDIT_DIR", "/tool-runner-state/audit")
OMP_UPDATE_STATE_FILE = os.environ.get("OMP_UPDATE_STATE_FILE", "/workspace/ai-ops-root/terminal/runtime/update-state.json")
SELF_MONITOR_TASK_STALE_SECONDS = int(os.environ.get("SELF_MONITOR_TASK_STALE_SECONDS", "900"))
SELF_MONITOR_OMP_MAX_AGE_SECONDS = int(os.environ.get("SELF_MONITOR_OMP_MAX_AGE_SECONDS", "129600"))
SELF_MONITOR_TERMINAL_MAX_CLIENTS = int(os.environ.get("SELF_MONITOR_TERMINAL_MAX_CLIENTS", "1"))
WORKSPACE_ROOT = os.environ.get("WORKSPACE_ROOT", "/workspace/projects")
READONLY_ROOT = os.environ.get("READONLY_ROOT", "/workspace/readonly")
ALLOWLIST_DIR = os.environ.get("ALLOWLIST_DIR", "/config")
PRODUCTION_SSH_DIR = os.environ.get("PRODUCTION_SSH_DIR", "/run/secrets/chenchuan-maintenance")
PROJECT_CONTEXT_MAX_CHARS = int(os.environ.get("PROJECT_CONTEXT_MAX_CHARS", "420000"))
PROJECT_CONTEXT_FILE_MAX_CHARS = int(os.environ.get("PROJECT_CONTEXT_FILE_MAX_CHARS", "90000"))
TASK_LOCK = threading.Lock()
TASK_STATE = {"last_run": 0}
TASK_COOLDOWN_SECONDS = int(os.environ.get("TASK_COOLDOWN_SECONDS", "20"))
TASK_STORE = RevisionedTaskStore(TASKS_DIR)
TASK_WORKERS_LOCK = threading.Lock()
TASK_WORKERS = {}
PILOT_JOB_LOCK = threading.Lock()
TODO_JOB_LOCK = threading.Lock()
PROJECT_DAILY_LOCK = threading.Lock()
PROJECT_DAILY_ACTIVE = set()
PROJECT_PRODUCTION_LOCK = threading.Lock()
PROJECT_PRODUCTION_ACTIVE = set()
OPS_RUNTIME_LOCK = threading.Lock()
SELF_MONITOR_LOCK = threading.Lock()
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
    "cpa-smart-router": [
        {"id": "direct-models", "name": "CPA Direct 鉴权边界", "url": "https://api-direct.hahaxiong.top/v1/models", "path": "/v1/models", "kind": "http", "expectedStatuses": [401]},
        {"id": "smart-models", "name": "CPA Smart Router 鉴权边界", "url": "https://smart-api.hahaxiong.top/v1/models", "path": "/v1/models", "kind": "http", "expectedStatuses": [401]},
    ],
    "realtime-voice-agent": [
        {"id": "voice-worker", "name": "企航云香港 Voice Worker", "url": "http://64.90.13.117:8081/", "path": "/", "kind": "http", "expectedStatuses": [200]},
    ],
}

PROJECT_DAILY_PUSH_URLS = {
    "chenchuan-site": os.environ.get("CHENCHUAN_DAILY_PUSH_URL", ""),
    "cpa-smart-router": os.environ.get("CPA_DAILY_PUSH_URL", ""),
    "realtime-voice-agent": os.environ.get("VOICE_DAILY_PUSH_URL", ""),
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

CPA_SMART_ROUTER_FALLBACK_ALLOWLIST = [
    "README.md",
    "go.mod",
    "config/router.example.json",
    "cmd/router/main.go",
    "cmd/router/main_test.go",
    "scripts/cpa-resource-guard.sh",
    "deploy/cpa-resource-guard.service",
    "deploy/cpa-resource-guard.timer",
    "deploy/cpa-resource-guard.logrotate",
]

REALTIME_VOICE_AGENT_FALLBACK_ALLOWLIST = [
    "README.md",
    "Makefile",
    "pyproject.toml",
    "docs/ARCHITECTURE.md",
    "docs/PRODUCT-DEFINITION-v3.3.md",
    "src/voice_agent/app.py",
    "src/voice_agent/contract/events.py",
    "src/voice_agent/kernel/memory_kernel.py",
    "src/voice_agent/pipeline/session.py",
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
    "cpa-smart-router": load_allowlist_file("cpa-smart-router", CPA_SMART_ROUTER_FALLBACK_ALLOWLIST),
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
    "realtime-voice-agent": load_allowlist_file("realtime-voice-agent", REALTIME_VOICE_AGENT_FALLBACK_ALLOWLIST),
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
        "risk": "低风险：只读巡检公开页面、组件、雷达服务和安全业务逻辑；后台、API 鉴权、数据库、运行态、环境变量与媒体原文件保持隔离。",
        "goal": "持续维护个人站与 Theory Radar：结合公开探测、限权生产状态和安全源码快照定位故障，优先恢复日报发布并保护 last-good。",
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
            "maintenanceSecretDir": PRODUCTION_SSH_DIR,
            "maintenanceActions": ["inspect", "refresh-radar", "run-theory-radar", "restart-theory-radar-timers", "restart"],
            "maintenanceConfirmations": {
                "refresh-radar": "REFRESH_RADAR",
                "run-theory-radar": "RUN_THEORY_RADAR",
                "restart-theory-radar-timers": "RESTART_THEORY_RADAR_TIMERS",
                "restart": "RESTART_CHENCHUAN_SITE",
            },
            "maintenanceLabels": {
                "inspect": "巡检生产状态",
                "refresh-radar": "确认后修复雷达刷新",
                "run-theory-radar": "确认后立即执行 Theory Radar",
                "restart-theory-radar-timers": "确认后重载 Theory Radar 定时器",
                "restart": "确认后重启个人站",
            },
            "maintenanceTimeoutSeconds": 900,
            "verifiedAt": "2026-07-14",
        },
    },
    "cpa-smart-router": {
        "name": "个人 CPA / Smart Router",
        "path": "/workspace/readonly/cpa-smart-router",
        "risk": "中风险：仅允许读取路由器核心实现、测试和脱敏示例配置；生产密钥、OAuth 凭据、数据库和真实配置保持隔离。",
        "goal": "持续验证 CPA Direct 与 Smart Router 的公网鉴权边界、核心服务状态、模型列表可用性和低成本真实请求链路。",
        "firstWorkflow": "readonly_inspect",
        "production": {
            "domain": "https://smart-api.hahaxiong.top",
            "directDomain": "https://api-direct.hahaxiong.top",
            "sshAlias": "aliyun-jp",
            "address": "47.74.43.55",
            "maintenanceUser": "aiops",
            "maintenancePort": 52022,
            "path": "/opt/cliproxy",
            "processManager": "systemd",
            "services": ["cliproxy", "cpa-smart-router"],
            "maintenanceSecretDir": "/run/secrets/cpa-jp-maintenance",
            "maintenanceActions": ["inspect", "restart-cliproxy", "restart-router"],
            "maintenanceConfirmations": {
                "restart-cliproxy": "RESTART_CPA_CORE",
                "restart-router": "RESTART_CPA_ROUTER",
            },
            "maintenanceLabels": {
                "inspect": "巡检生产状态",
                "restart-cliproxy": "确认后重启 CPA 核心",
                "restart-router": "确认后重启 Smart Router",
            },
            "maintenanceTimeoutSeconds": 300,
            "verifiedAt": "2026-07-14",
        },
    },
    "MyJavis": {
        "name": "MyJavis",
        "path": "/workspace/readonly/MyJavis",
        "risk": "中风险：仅允许读 README/HANDOFF/package/tsconfig/vite/index，禁止数据库和 secrets。",
        "goal": "确认 MyJavis 当前结构、备份关联点、可观测性缺口和下一步方案。",
        "firstWorkflow": "readonly_inspect",
    },
    "realtime-voice-agent": {
        "name": "Realtime Voice Agent",
        "path": "/workspace/readonly/realtime-voice-agent",
        "risk": "中风险：仅允许读取架构、稳定契约、记忆内核、编排代码与安全测试；环境变量、音频、模型、声纹、事件日志、数据库和运行数据保持隔离。",
        "goal": "持续验证企航云香港 Voice Worker 的服务状态、8081 端口、公网入口、资源余量和安全源码快照。",
        "firstWorkflow": "readonly_inspect",
        "production": {
            "domain": "http://64.90.13.117:8081",
            "sshAlias": "qihang-hk",
            "address": "64.90.13.117",
            "maintenanceUser": "aiops",
            "maintenancePort": 22,
            "path": "/root/realtime-voice-agent",
            "processManager": "systemd",
            "services": ["voice-worker"],
            "maintenanceSecretDir": "/run/secrets/qihang-hk-maintenance",
            "maintenanceActions": ["inspect", "restart-voice-worker"],
            "maintenanceConfirmations": {
                "restart-voice-worker": "RESTART_VOICE_WORKER",
            },
            "maintenanceLabels": {
                "inspect": "巡检 Voice Worker",
                "restart-voice-worker": "确认后重启 Voice Worker",
            },
            "maintenanceTimeoutSeconds": 60,
            "verifiedAt": "2026-07-22",
        },
    },
}



def run(cmd):
    return subprocess.check_output(cmd, text=True, timeout=10).strip()


def run_quiet(cmd, timeout=10):
    return subprocess.check_output(cmd, text=True, stderr=subprocess.STDOUT, timeout=timeout).strip()


def internal_service_json(base_url, path, payload=None, timeout=12, require_token=False):
    url = base_url.rstrip("/") + path
    headers = {"User-Agent": "AI-Ops-Cockpit/1.0"}
    data = None
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["content-type"] = "application/json"
    if require_token:
        if not AI_OPS_INTERNAL_TOKEN:
            return {"ok": False, "error": "internal_auth_unavailable"}
        headers["x-aiops-internal-token"] = AI_OPS_INTERNAL_TOKEN
    try:
        request = urllib.request.Request(url, data=data, headers=headers, method="POST" if data is not None else "GET")
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        try:
            payload = json.loads(exc.read().decode("utf-8"))
        except Exception:
            payload = None
        if isinstance(payload, dict):
            payload = dict(payload)
            payload.setdefault("ok", False)
            payload["httpStatus"] = exc.code
            return payload
        return {"ok": False, "error": "internal_http_error", "status": exc.code}
    except Exception as exc:
        return {"ok": False, "error": type(exc).__name__}


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
    os.chmod(tmp_path, 0o600)
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


def parse_feishu_webhook_response(status, body):
    if not 200 <= status < 300:
        raise RuntimeError("feishu_http_error")
    try:
        payload = json.loads(body)
    except (TypeError, ValueError) as exc:
        raise RuntimeError("feishu_invalid_response") from exc
    provider_code = payload.get("code")
    if provider_code is None:
        provider_code = payload.get("StatusCode")
    if provider_code not in (0, "0"):
        raise RuntimeError("feishu_rejected")
    return {
        "status": status,
        "providerCode": int(provider_code),
        "providerStatus": payload.get("msg") or payload.get("StatusMessage") or "success",
    }


def send_feishu_text(text):
    webhook = os.environ.get("FEISHU_WEBHOOK_URL")
    if not webhook:
        raise RuntimeError("FEISHU_WEBHOOK_URL is not configured")
    payload = json.dumps({"msg_type": "text", "content": {"text": text}}, ensure_ascii=False).encode()
    request = urllib.request.Request(webhook, data=payload, headers={"content-type": "application/json"}, method="POST")
    with urllib.request.urlopen(request, timeout=15) as response:
        body = response.read().decode("utf-8", "replace")
    return parse_feishu_webhook_response(response.status, body)


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


def brain_status():
    payload = internal_service_json(AI_OPS_BRAIN_URL, "/health", timeout=6)
    if payload.get("dockerSocket") or payload.get("productionSsh"):
        payload = dict(payload)
        payload["ok"] = False
        payload["error"] = "brain boundary violated"
    return payload


def tool_runner_status():
    return internal_service_json(AI_OPS_TOOL_RUNNER_URL, "/health", timeout=6)


def omp_status(sessions=None):
    sessions = sessions if sessions is not None else terminal_sessions(5)
    brain = brain_status()
    try:
        version = run(["docker", "exec", "ops-brain", "/usr/local/bin/omp-aiops", "--version"])
        version_error = None
    except Exception as exc:
        version = None
        version_error = type(exc).__name__
    recent = ""
    for item in sessions[:5]:
        if item.get("preview"):
            recent = item["preview"]
            break
    payload = {
        "ok": bool(brain.get("ok") and version and version.startswith("omp/")),
        "brain": brain,
        "version": version,
        "autoModel": AI_OPS_OMP_MODEL,
        "recentSessionHasProviderSetup": "Set up your providers" in recent or "Select provider to login" in recent,
        "recentSessionHasReconnectSignal": "process exited with code 1" in recent,
    }
    if version_error:
        payload["error"] = version_error
    return payload


def vibe_status_payload():
    terminal = terminal_status()
    sessions = terminal_sessions(8)
    omp = omp_status(sessions)
    runner = tool_runner_status()
    return {
        "ok": terminal.get("ok") and omp.get("ok") and runner.get("ok"),
        "terminal": terminal,
        "omp": omp,
        "brain": omp.get("brain"),
        "toolRunner": runner,
        "sessions": sessions,
        "dangerousPatterns": DANGEROUS_PATTERNS,
        "generatedAt": time.strftime("%Y-%m-%d %H:%M:%S %Z"),
    }


def self_monitor_notification_text(report, event):
    failed_labels = [item["label"] for item in report["components"] if not item.get("ok")]
    audit = report["policyAudit"]
    tasks = report["taskQueue"]
    if event == "recovery":
        title = "✅ AI Ops 自监控恢复"
        state_text = "核心组件已恢复正常"
    else:
        title = "⚠️ AI Ops 自监控告警"
        state_text = "异常组件：" + "、".join(failed_labels)
    return "\n".join([
        title,
        state_text,
        f"任务队列：活动 {tasks['activeCount']}，超时 {tasks['staleCount']}",
        f"网页终端：OMP 会话 {report['terminalSessions']['count']} / 上限 {report['terminalSessions']['maxClients']}",
        f"策略门 24h：审计 {audit['records24h']}，允许 {audit['allowed24h']}，阻断 {audit['blocked24h']}",
        f"OMP 更新：{report['ompUpdate']['outcome']}，最近检查 {report['ompUpdate']['checkedAt'] or '未知'}",
        f"时间：{report['generatedAt']}",
        "入口：https://ops.hahaxiong.top/vibe/ops-runtime",
    ])


def build_self_monitor_report():
    generated_at = time.strftime("%Y-%m-%d %H:%M:%S %Z")
    brain = brain_status()
    runner = tool_runner_status()
    audit = summarize_audits(TOOL_AUDIT_DIR)
    tasks = summarize_tasks(TASK_STORE.list(500), stale_seconds=SELF_MONITOR_TASK_STALE_SECONDS)
    omp_update = summarize_omp_update(load_json_file(OMP_UPDATE_STATE_FILE, {}), max_age_seconds=SELF_MONITOR_OMP_MAX_AGE_SECONDS)
    try:
        terminal_session_count = int(run(["docker", "exec", "ops-terminal", "sh", "-lc", "ps -eo comm= | grep -cx omp || true"]) or 0)
        terminal_sessions = {
            "ok": terminal_session_count <= SELF_MONITOR_TERMINAL_MAX_CLIENTS,
            "count": terminal_session_count,
            "maxClients": SELF_MONITOR_TERMINAL_MAX_CLIENTS,
        }
    except Exception as exc:
        terminal_sessions = {
            "ok": False,
            "count": -1,
            "maxClients": SELF_MONITOR_TERMINAL_MAX_CLIENTS,
            "error": type(exc).__name__,
        }
    try:
        n8n_probe = probe_url("http://n8n:5678/healthz")
        n8n_ok = bool(n8n_probe.get("ok") and "ok" in n8n_probe.get("bodyPreview", ""))
    except Exception as exc:
        n8n_probe = {"ok": False, "error": type(exc).__name__}
        n8n_ok = False
    components = [
        {"id": "brain", "label": "AI Brain", "ok": bool(brain.get("ok")), "status": "ready" if brain.get("ok") else brain.get("error", "unavailable")},
        {"id": "runner", "label": "只读 Runner", "ok": bool(runner.get("ok")), "status": "ready" if runner.get("ok") else runner.get("error", "unavailable")},
        {"id": "policy-audit", "label": "Tool Policy 审计", "ok": bool(audit["readable"] and audit["malformedFiles"] == 0 and audit["secretExposure24h"] == 0), "status": "ready" if audit["readable"] else "audit_unavailable"},
        {"id": "task-queue", "label": "权威任务队列", "ok": bool(tasks["activeCount"] <= 1 and tasks["staleCount"] == 0), "status": "ready" if tasks["staleCount"] == 0 else "stale_task"},
        {"id": "terminal-sessions", "label": "网页终端会话", "ok": bool(terminal_sessions["ok"]), "status": "ready" if terminal_sessions["ok"] else "session_limit_exceeded"},
        {"id": "omp-update", "label": "OMP 自动更新", "ok": bool(omp_update["ok"]), "status": omp_update["outcome"]},
        {"id": "n8n", "label": "n8n 调度", "ok": n8n_ok, "status": "ready" if n8n_ok else n8n_probe.get("error", "unavailable")},
    ]
    report = {
        "ok": all(item["ok"] for item in components),
        "generatedAt": generated_at,
        "components": components,
        "policyAudit": audit,
        "taskQueue": tasks,
        "terminalSessions": terminal_sessions,
        "ompUpdate": omp_update,
    }
    report["signature"] = monitor_signature(report)
    return report


def run_self_monitor(notify=True):
    with SELF_MONITOR_LOCK:
        previous = load_json_file(SELF_MONITOR_STATE_FILE, {})
        report = build_self_monitor_report()
        event = transition_event(previous, report)
        notification = {"status": "deduped"}
        if notify and event:
            try:
                result = send_feishu_text(self_monitor_notification_text(report, event))
                notification = {"status": result.get("status"), "event": event}
            except Exception as exc:
                return {"ok": False, "error": "notification_failed", "errorType": type(exc).__name__, "report": report, "event": event}
        state = {
            "ok": report["ok"],
            "signature": report["signature"],
            "updatedAt": report["generatedAt"],
            "lastEvent": event or previous.get("lastEvent"),
            "lastNotifiedAt": report["generatedAt"] if notify and event else previous.get("lastNotifiedAt"),
        }
        save_json_file(SELF_MONITOR_STATE_FILE, state)
        return {"ok": report["ok"], "report": report, "event": event, "notification": notification}


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
    runner = tool_runner_status()
    for project in workspace_payload()["projects"]:
        path = project["path"]
        exists = False
        git = False
        status = "not_mounted"
        details = ""
        if path.startswith(READONLY_ROOT):
            try:
                exists = os.path.isdir(path)
                git = os.path.isdir(os.path.join(path, ".git"))
                if exists and runner.get("ok") and runner.get("mountReadonly"):
                    status = "ready_readonly" if git else "mounted_readonly_no_git"
                    details = "Brain 仅可经 readonly_safe Tool Policy Gate 访问；不直接挂载工作区。"
                elif exists:
                    status = "error"
                    details = "只读快照存在，但 Tool Runner 只读挂载或策略服务未就绪。"
            except Exception as exc:
                status = "error"
                details = type(exc).__name__
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
    cpa_status = project_production_status_payload("cpa-smart-router") or {}
    cpa_latest = cpa_status.get("latest") or {}
    cpa_ready = bool(cpa_status.get("configured") and cpa_latest.get("ok"))
    cpa_server = {
        "name": "阿里云日本 CPA",
        "role": "个人 CPA / Smart Router 生产节点",
        "status": "已巡检" if cpa_ready else ("待巡检" if cpa_status.get("configured") else "待接入"),
        "containers": None,
        "unhealthy": None,
        "maxDiskUsedPercent": ((cpa_latest.get("result") or {}).get("host") or {}).get("diskUsedPercent"),
        "monitorsDown": None,
        "lastChecked": cpa_latest.get("updatedAt"),
        "readinessScore": 90 if cpa_ready else (60 if cpa_status.get("configured") else None),
        "risk": "最近限权巡检通过（非业务健康结论）" if cpa_ready else "维护通道已配置，等待巡检证据" if cpa_status.get("configured") else "限权维护通道未配置",
    }
    voice_status = project_production_status_payload("realtime-voice-agent") or {}
    voice_latest = voice_status.get("latest") or {}
    voice_ready = bool(voice_status.get("configured") and voice_latest.get("ok"))
    voice_server = {
        "name": "企航云香港 Voice Worker",
        "role": "Realtime Voice Agent 生产节点",
        "status": "已巡检" if voice_ready else ("待巡检" if voice_status.get("configured") else "待接入"),
        "containers": None,
        "unhealthy": None,
        "maxDiskUsedPercent": ((voice_latest.get("result") or {}).get("host") or {}).get("diskUsedPercent"),
        "monitorsDown": None,
        "lastChecked": voice_latest.get("updatedAt"),
        "readinessScore": 90 if voice_ready else (60 if voice_status.get("configured") else None),
        "risk": "最近限权巡检通过（非业务健康结论）" if voice_ready else "维护通道已配置，等待巡检证据" if voice_status.get("configured") else "限权维护通道未配置",
    }
    return {"servers": [racknerd, cpa_server, voice_server] + planned, "generatedAt": time.strftime("%Y-%m-%d %H:%M:%S %Z")}


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
        risk = "Brain 容器不持有 SSH；待接入资产必须走 ops-inspector 的专用限权维护通道。"
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
        stat_result = os.stat(os.path.join(READONLY_ROOT, "mycc"))
        state["mountedAt"] = time.strftime("%Y-%m-%d %H:%M:%S %Z", time.localtime(stat_result.st_mtime))
        state["mounted"] = True
    except Exception as exc:
        state["mounted"] = False
        state["error"] = type(exc).__name__
    state["toolRunner"] = tool_runner_status()
    return state


def refresh_readonly_payload():
    if not READONLY_REFRESH_LOCK.acquire(blocking=False):
        return {"ok": False, "error": "refresh already running"}
    started = time.time()
    try:
        try:
            env = os.environ.copy()
            env.update({
                "AI_OPS_ROOT": "/workspace/ai-ops-root",
                "AI_OPS_READONLY_SRC": "/opt/ai-ops-workspaces",
                "AI_OPS_READONLY_DEST": READONLY_ROOT,
            })
            output = subprocess.check_output(
                ["bash", "/workspace/ai-ops-root/scripts/sync-readonly-workspaces.sh"],
                env=env,
                text=True,
                stderr=subprocess.STDOUT,
                timeout=120,
            )
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
            id=key,
            allowlist=PROJECT_ALLOWLIST.get(key, []),
            context={name: value for name, value in context.items() if name != "prompt"},
        ))
    return {
        "policy": "实战试点默认只读；先跑低风险项目巡检，再由 Codex/cc 收口执行任何写入。",
        "acceptance": [
            "AI 模型输出必须包含 O1/O2、Plan、Check、Action。",
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
    target_url = spec.get("url") or (base_url.rstrip("/") + spec["path"])
    request = urllib.request.Request(target_url, headers=headers)
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
        expected_statuses = spec.get("expectedStatuses") or list(range(200, 300))
        status_ok = result["status"] in expected_statuses
        if spec.get("kind") == "binary":
            result["ok"] = status_ok and result["contentType"].startswith(spec.get("contentTypePrefix", ""))
        elif spec.get("kind") == "json":
            try:
                parsed = json.loads(body.decode("utf-8"))
                field_ok = bool(parsed.get(spec.get("jsonOkField", "ok")))
            except Exception:
                field_ok = False
            result["jsonFieldOk"] = field_ok
            result["ok"] = status_ok and field_ok
        elif spec.get("marker"):
            marker_ok = spec.get("marker", "").encode("utf-8") in body
            result["markerOk"] = marker_ok
            result["ok"] = status_ok and marker_ok
        else:
            result["ok"] = status_ok
    except urllib.error.HTTPError as exc:
        result["status"] = exc.code
        result["contentType"] = (exc.headers.get("content-type") or "").split(";", 1)[0]
        result["bytes"] = len(exc.read(4096))
        expected_statuses = spec.get("expectedStatuses") or []
        result["ok"] = exc.code in expected_statuses
        if not result["ok"]:
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


def production_channel_files(project_id):
    project = PILOT_PROJECTS.get(project_id) or {}
    production = project.get("production") or {}
    secret_dir = production.get("maintenanceSecretDir") or PRODUCTION_SSH_DIR
    return {
        "identity": os.path.join(secret_dir, "id_ed25519"),
        "knownHosts": os.path.join(secret_dir, "known_hosts"),
    }


def production_channel_configured(project_id):
    project = PILOT_PROJECTS.get(project_id) or {}
    production = project.get("production") or {}
    files = production_channel_files(project_id)
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
    sanitized = {
        "ok": bool(payload.get("ok")),
        "generatedAt": payload.get("generatedAt"),
        "hostname": str(payload.get("hostname") or "")[:120],
        "host": {
            "load1": host.get("load1"),
            "diskUsedPercent": host.get("diskUsedPercent"),
            "diskFreeGB": host.get("diskFreeGB"),
            "memoryAvailableMB": host.get("memoryAvailableMB"),
        },
    }
    if process:
        sanitized["process"] = {
            "name": str(process.get("name") or "")[:120],
            "status": str(process.get("status") or "")[:40],
            "pid": process.get("pid"),
            "restartCount": process.get("restartCount"),
            "uptimeSeconds": process.get("uptimeSeconds"),
            "cpuPercent": process.get("cpuPercent"),
            "memoryMB": process.get("memoryMB"),
        }
    if deployment:
        sanitized["deployment"] = {
            "path": str(deployment.get("path") or "")[:240],
            "buildId": str(deployment.get("buildId") or "")[:100] or None,
            "deployedAt": deployment.get("deployedAt"),
        }
    radar = payload.get("radar") or {}
    if isinstance(radar, dict) and radar:
        sanitized["radar"] = {
            "ok": bool(radar.get("ok")),
            "checkedAt": str(radar.get("checkedAt") or "")[:120] or None,
            "ageSeconds": radar.get("ageSeconds"),
            "feedItemCount": radar.get("feedItemCount"),
            "latestPublishedAt": str(radar.get("latestPublishedAt") or "")[:120] or None,
            "aihotOk": bool(radar.get("aihotOk")),
            "aihotCount": radar.get("aihotCount"),
            "yuweiwanOk": bool(radar.get("yuweiwanOk")),
            "yuweiwanCount": radar.get("yuweiwanCount"),
            "endpointIp": str(radar.get("endpointIp") or "")[:64] or None,
            "monitorState": str(radar.get("monitorState") or "")[:120] or None,
        }
    theory_radar = payload.get("theoryRadar") or {}
    if isinstance(theory_radar, dict) and theory_radar:
        source = theory_radar.get("source") or {}
        sanitized["theoryRadar"] = {
            "ok": bool(theory_radar.get("ok")),
            "publishEnabled": bool(theory_radar.get("publishEnabled")),
            "status": str(theory_radar.get("status") or "")[:40] or None,
            "stage": str(theory_radar.get("stage") or "")[:40] or None,
            "runDate": str(theory_radar.get("runDate") or "")[:40] or None,
            "updatedAt": str(theory_radar.get("updatedAt") or "")[:120] or None,
            "ageSeconds": theory_radar.get("ageSeconds"),
            "provider": str(theory_radar.get("provider") or "")[:120] or None,
            "paperCount": theory_radar.get("paperCount"),
            "published": bool(theory_radar.get("published")),
            "publishOk": bool(theory_radar.get("publishOk")),
            "dailyTimer": str(theory_radar.get("dailyTimer") or "")[:40] or None,
            "dailyNext": str(theory_radar.get("dailyNext") or "")[:120] or None,
            "reconcileTimer": str(theory_radar.get("reconcileTimer") or "")[:40] or None,
            "reconcileNext": str(theory_radar.get("reconcileNext") or "")[:120] or None,
            "serviceResult": str(theory_radar.get("serviceResult") or "")[:40] or None,
            "latestPublicReport": str(theory_radar.get("latestPublicReport") or "")[:160] or None,
            "lastErrorType": str(theory_radar.get("lastErrorType") or "")[:120] or None,
            "source": {
                "rssOk": bool(source.get("rssOk")),
                "rssCount": source.get("rssCount"),
                "rssCategories": source.get("rssCategories"),
                "openAlexOk": bool(source.get("openAlexOk")),
                "openAlexCount": source.get("openAlexCount"),
                "uniqueCandidates": source.get("uniqueCandidates"),
            },
        }
    analytics = payload.get("analytics") or {}
    if isinstance(analytics, dict) and analytics:
        yesterday = analytics.get("yesterday") or {}
        seven_days = analytics.get("sevenDays") or {}
        top_paths = analytics.get("topPaths") or []
        sanitized["analytics"] = {
            "ok": bool(analytics.get("ok")),
            "date": str(analytics.get("date") or "")[:20] or None,
            "scope": "human_only",
            "yesterday": {
                "pv": yesterday.get("pv"),
                "uv": yesterday.get("uv"),
                "pagesPerVisitor": yesterday.get("pagesPerVisitor"),
            },
            "sevenDays": {
                "pv": seven_days.get("pv"),
                "uv": seven_days.get("uv"),
            },
            "topPaths": [
                {
                    "path": str(item.get("path") or "")[:160],
                    "pv": item.get("pv"),
                }
                for item in top_paths[:3]
                if isinstance(item, dict)
            ],
            "excludedPv": analytics.get("excludedPv"),
            "error": str(analytics.get("error") or "")[:80] or None,
        }
    scheduler = payload.get("scheduler") or {}
    if isinstance(scheduler, dict) and scheduler:
        sanitized["scheduler"] = {
            "ok": bool(scheduler.get("ok")),
            "enabled": str(scheduler.get("enabled") or "")[:40] or None,
            "active": str(scheduler.get("active") or "")[:40] or None,
            "nextElapse": str(scheduler.get("nextElapse") or "")[:120] or None,
            "lastResult": str(scheduler.get("lastResult") or "")[:40] or None,
        }
    services = payload.get("services") or {}
    if isinstance(services, dict) and services:
        sanitized["services"] = {}
        for name in ("cliproxy", "cpa-smart-router", "voice-worker"):
            if name not in services:
                continue
            service = services.get(name) or {}
            sanitized["services"][name] = {
                "active": str(service.get("active") or "")[:40],
                "subState": str(service.get("subState") or "")[:40],
                "pid": service.get("pid"),
                "restartCount": service.get("restartCount"),
                "activeSince": str(service.get("activeSince") or "")[:120] or None,
            }
    ports = payload.get("ports") or {}
    if isinstance(ports, dict) and ports:
        sanitized["ports"] = {str(port): bool(ports.get(str(port))) for port in (8081, 8317, 8327) if str(port) in ports}
    probes = payload.get("probes") or {}
    if isinstance(probes, dict) and probes:
        sanitized["probes"] = {}
        for name in ("directModels", "smartModels", "directChat", "smartChat", "playlist", "voiceWorker"):
            if name not in probes:
                continue
            probe = probes.get(name) or {}
            sanitized["probes"][name] = {
                "ok": bool(probe.get("ok")),
                "status": probe.get("status"),
                "modelCount": probe.get("modelCount"),
                "channelCount": probe.get("channelCount"),
                "samplePassed": probe.get("samplePassed"),
                "sampleTotal": probe.get("sampleTotal"),
                "ageSeconds": probe.get("ageSeconds"),
                "latencyMs": probe.get("latencyMs"),
                "updatedAt": str(probe.get("updatedAt") or "")[:120] or None,
                "bytes": probe.get("bytes"),
            }
    logs = payload.get("logs") or {}
    if isinstance(logs, dict) and logs:
        sanitized["logs"] = {"warning24h": logs.get("warning24h")}
    versions = payload.get("versions") or {}
    if isinstance(versions, dict) and versions:
        sanitized["versions"] = {
            "cliproxy": str(versions.get("cliproxy") or "")[:120] or None,
            "smartRouter": str(versions.get("smartRouter") or "")[:120] or None,
        }
    for key in ("teamPresent", "xaiCount"):
        if key in payload:
            sanitized[key] = payload.get(key)
    if payload.get("note"):
        sanitized["note"] = str(payload.get("note"))[:240]
    if payload.get("ts"):
        sanitized["ts"] = str(payload.get("ts"))[:80]
    return sanitized


def production_allowed_actions(project_id):
    production = (PILOT_PROJECTS.get(project_id) or {}).get("production") or {}
    return list(production.get("maintenanceActions") or [])


def production_action_confirmation(project_id, action):
    production = (PILOT_PROJECTS.get(project_id) or {}).get("production") or {}
    return (production.get("maintenanceConfirmations") or {}).get(action)


def production_action_requires_confirmation(project_id, action):
    return bool(production_action_confirmation(project_id, action))


def production_action_label(project_id, action):
    production = (PILOT_PROJECTS.get(project_id) or {}).get("production") or {}
    return (production.get("maintenanceLabels") or {}).get(action) or action


def production_service_summary(result):
    process = result.get("process") or {}
    if process:
        return f"{process.get('name') or 'process'}={process.get('status') or '-'}"
    services = result.get("services") or {}
    if services:
        return ", ".join(f"{name}={item.get('active') or '-'}" for name, item in services.items())
    return "待巡检"


def run_production_command(project_id, action):
    if action not in production_allowed_actions(project_id):
        return {"ok": False, "error": "production action not allowed"}
    project = PILOT_PROJECTS.get(project_id) or {}
    production = project.get("production") or {}
    if not production_channel_configured(project_id):
        return {"ok": False, "error": "maintenance channel not configured"}
    files = production_channel_files(project_id)
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
        result = subprocess.run(command, text=True, capture_output=True, timeout=int(production.get("maintenanceTimeoutSeconds") or 60), check=False)
    except Exception as exc:
        return {"ok": False, "error": type(exc).__name__, "durationMs": round((time.time() - started) * 1000)}
    if result.returncode != 0:
        return {"ok": False, "error": "maintenance command failed", "returnCode": result.returncode, "durationMs": round((time.time() - started) * 1000)}
    try:
        raw_payload = parse_maintenance_response(result.stdout)
    except ValueError:
        return {"ok": False, "error": "invalid maintenance response", "durationMs": round((time.time() - started) * 1000)}
    payload = sanitize_production_inspection(raw_payload)
    payload["durationMs"] = round((time.time() - started) * 1000)
    payload["channel"] = "restricted_ssh"
    return payload


def parse_maintenance_response(stdout):
    raw = (stdout or "").strip()
    if not raw:
        raise ValueError("empty maintenance response")
    candidates = [raw]
    lines = raw.splitlines()
    if len(lines) > 1:
        candidates.append(lines[-1].strip())
    for candidate in candidates:
        try:
            payload = json.loads(candidate)
        except Exception:
            continue
        if isinstance(payload, dict):
            return payload
    raise ValueError("invalid maintenance response")


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
        "allowedActions": production_allowed_actions(project_id),
        "actionLabels": {action: production_action_label(project_id, action) for action in production_allowed_actions(project_id)},
        "policy": "inspect is read-only; state-changing actions require action token and exact confirmation; deploy and shell are not allowed",
        "generatedAt": time.strftime("%Y-%m-%d %H:%M:%S %Z"),
    }


def production_action_notification_text(project_id, job):
    result = job.get("result") or {}
    live = job.get("live") or {}
    return "\n".join([
        f"AI Ops {project_id} 生产维护动作",
        f"动作：{job.get('action')}",
        f"状态：{'成功' if job.get('ok') else '失败'}",
        f"服务：{production_service_summary(result)}",
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
        result = before if action == "inspect" else run_production_command(project_id, action)
        live = project_live_check(project_id)
        ok = bool(result.get("ok") and live.get("ok"))
        job.update({
            "ok": ok,
            "status": "done" if ok else "failed",
            "before": before if action != "inspect" else None,
            "result": result,
            "live": live,
            "durationMs": round((time.time() - started) * 1000),
            "updatedAt": time.strftime("%Y-%m-%d %H:%M:%S %Z"),
        })
        if production_action_requires_confirmation(project_id, action):
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
    if action not in production_allowed_actions(project_id):
        return {"ok": False, "error": "production action not allowed"}
    required_confirmation = production_action_confirmation(project_id, action)
    if required_confirmation and payload.get("confirmation") != required_confirmation:
        return {"ok": False, "error": "action confirmation required"}
    if not production_channel_configured(project_id):
        return {"ok": False, "error": "maintenance channel not configured"}
    if required_confirmation:
        restart_state_path = os.path.join(project_production_root(project_id), "last-" + re.sub(r"[^a-z0-9-]", "-", action.lower()) + ".json")
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
        if required_confirmation:
            restart_state_path = os.path.join(project_production_root(project_id), "last-" + re.sub(r"[^a-z0-9-]", "-", action.lower()) + ".json")
            ensure_private_dir(project_production_root(project_id))
            save_json_file(restart_state_path, {"jobId": job_id, "requestedTs": time.time(), "requestedAt": job["createdAt"]})
        thread = threading.Thread(target=run_project_production_worker, args=(job_id, project_id, action), daemon=True)
        thread.start()
    except Exception:
        with PROJECT_PRODUCTION_LOCK:
            PROJECT_PRODUCTION_ACTIVE.discard(project_id)
        raise
    return {"ok": True, "status": "queued", "jobId": job_id, "pollUrl": f"/vibe/project/production/job?id={job_id}"}


def ops_runtime_execution_root():
    return ops_tool_runtime.execution_dir(STATE_DIR)


def save_ops_runtime_execution(record):
    root = ops_runtime_execution_root()
    ensure_private_dir(root)
    save_json_file(os.path.join(root, record["id"] + ".json"), record)


def load_ops_runtime_execution(execution_id):
    execution_id = (execution_id or "").strip()
    if not re.match(r"^ort-[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$", execution_id):
        return None
    return load_json_file(os.path.join(ops_runtime_execution_root(), execution_id + ".json"), None)


def ops_runtime_executions(limit=20):
    root = ops_runtime_execution_root()
    ensure_private_dir(root)
    items = []
    for name in os.listdir(root):
        if not name.endswith(".json"):
            continue
        item = load_json_file(os.path.join(root, name), None)
        if item:
            if "result" in item:
                item = dict(item)
                item.pop("result", None)
            items.append(item)
    return sorted(items, key=lambda item: item.get("createdAt", ""), reverse=True)[:limit]


def ops_runtime_profiles():
    return ops_tool_runtime.project_profiles(
        PILOT_PROJECTS,
        PROJECT_ALLOWLIST,
        PROJECT_LIVE_PROBES,
        production_allowed_actions,
        production_action_label,
        production_action_confirmation,
        production_channel_configured,
    )


def ops_runtime_payload():
    executions = ops_runtime_executions(12)
    return {
        "ok": True,
        "runtime": ops_tool_runtime.runtime_summary(PILOT_PROJECTS, executions),
        "architecture": {
            "brain": brain_status(),
            "readonlyRunner": tool_runner_status(),
            "hands": "ops-inspector controlled actions only",
        },
        "readonlySafe": {
            "workflow": "readonly_safe",
            "tools": ["aiops_read", "aiops_grep", "aiops_find", "aiops_ls"],
            "policy": "registered project + relative realpath + no symlink + sensitive-path deny + bounded output",
        },
        "projects": ops_runtime_profiles(),
        "tools": ops_tool_runtime.tool_specs(PILOT_PROJECTS),
        "executions": executions,
    }


def ops_runtime_tool_spec(tool_name):
    return ops_tool_runtime.tool_map(PILOT_PROJECTS).get((tool_name or "").strip())


def ops_runtime_tool_requires_action(tool_name):
    spec = ops_runtime_tool_spec(tool_name)
    return bool(spec and spec.get("permission") == "action_token")


def run_ops_runtime_tool(payload):
    payload = payload or {}
    tool_name = (payload.get("tool") or "").strip()
    project_id = (payload.get("project") or "").strip()
    spec = ops_runtime_tool_spec(tool_name)
    if not spec:
        return {"ok": False, "error": "unknown runtime tool"}
    if spec.get("risk") == ops_tool_runtime.RISK_BLOCKED:
        return {"ok": False, "error": "tool blocked by policy", "policy": "deploy, shell, file write and secret access are not exposed to the AI model"}
    if project_id not in PILOT_PROJECTS:
        return {"ok": False, "error": "project not found"}
    if project_id not in (spec.get("projects") or []):
        return {"ok": False, "error": "tool not enabled for project"}

    started = time.time()
    result = None
    try:
        if tool_name == "list-project-profile":
            profile = [item for item in ops_runtime_profiles() if item.get("id") == project_id][0]
            result = {"ok": True, "profile": profile}
        elif tool_name == "inspect-live-probes":
            result = project_live_check(project_id)
        elif tool_name == "inspect-production-channel":
            if not production_channel_configured(project_id):
                result = {"ok": False, "error": "maintenance channel not configured"}
            else:
                result = run_production_command(project_id, "inspect")
        elif tool_name == "inspect-latest-production-record":
            result = project_production_status_payload(project_id) or {"ok": False, "error": "project production maintenance not configured"}
        elif tool_name == "run-controlled-action":
            action = (payload.get("action") or "").strip()
            if not action or action == "inspect":
                result = {"ok": False, "error": "controlled action required"}
            else:
                result = start_project_production_job({
                    "project": project_id,
                    "action": action,
                    "confirmation": payload.get("confirmation"),
                })
        else:
            result = {"ok": False, "error": "tool handler not implemented"}
    except Exception as exc:
        result = {"ok": False, "error": type(exc).__name__}

    record = ops_tool_runtime.make_execution_record(
        tool_name,
        project_id,
        spec.get("risk"),
        payload,
        result,
        started,
    )
    with OPS_RUNTIME_LOCK:
        save_ops_runtime_execution(record)
    public_record = dict(record)
    public_record.pop("result", None)
    return {"ok": bool(result.get("ok")) if isinstance(result, dict) else False, "execution": public_record, "result": result}


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
    lines = [
        f"请执行 {project['name']} 每日只读 AI 巡检。",
        "请同时使用系统注入的文件级 allowlist 源码快照、本轮公网实时探测和生产限权巡检 JSON。",
        "输出必须按 BRO-PDCA：O1/O2、Plan、Do/观察、Check、Action。",
        "重点判断：公网入口与鉴权边界是否符合预期、源码快照是否完整且新鲜、生产服务/资源/真实低成本探测是否需要人工处理。",
        "只能分析和给建议；不得执行写文件、重启、部署、commit、push，也不得输出或索要任何 secret。",
    ]
    if project_id == "chenchuan-site":
        lines.insert(4, "访问统计必查：读取仅含 human 聚合的昨日 UV/PV、近 7 日 UV/PV 和热门页面；不得输出 IP、UA、referrer 或任何访问明细。")
        lines.insert(4, "Theory Radar 必查：publish 是否启用、日报/周度 timer、运行日期与阶段、Grok 模型、论文数、RSS/OpenAlex 计数、publish_result、公网当日归档和双生产者覆盖风险。")
    if project_id == "realtime-voice-agent":
        lines.insert(4, "Voice Worker 必查：voice-worker.service 必须 active/running、8081 必须监听、本机与公网探测必须 200、NRestarts 不应异常增长，并关注最近 24 小时 warning 数与资源余量。")
    return "\n".join(lines)


def project_daily_signature(live, snapshot, production, task):
    analytics = production.get("analytics") or {}
    payload = {
        "failedIds": sorted(live.get("failedIds") or []),
        "snapshot": None if snapshot.get("ok") else "stale_or_incomplete",
        "production": None if production.get("ok") else "maintenance_unavailable",
        "analytics": None if analytics.get("ok") else "aggregate_unavailable",
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
            "answer": "每日巡检链路未能完成 AI 模型分析，请查看实时探测与任务审计。",
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
    channel_ok = production.get("channel") == "restricted_ssh"
    labels = {"normal": "每日简报", "alert": "异常告警", "recovery": "恢复通知"}
    lines = [
        f"AI Ops {project_id} {labels.get(event, event)}",
        f"状态：{'通过' if job.get('ok') else '需要关注'}",
        f"实时探测：{live.get('passed', 0)}/{live.get('total', 0)}",
        f"失败项：{','.join(live.get('failedIds') or []) or '-'}",
        f"源码快照：{'可用' if snapshot.get('ok') else '过期或不完整'} / {snapshot.get('ageHours')} 小时",
        f"生产维护通道：{'可用' if channel_ok else '不可用'}",
        f"生产服务：{production_service_summary(production)}",
        f"任务ID：{job.get('taskId') or '-'}",
        f"待办ID：{job.get('todoId') or '-'}",
        f"审计：https://ops.hahaxiong.top/vibe/project?id={project_id}",
    ]
    if project_id == "chenchuan-site":
        radar = production.get("radar") or {}
        theory_radar = production.get("theoryRadar") or {}
        analytics = production.get("analytics") or {}
        lines[0] = f"个人站真实访客{labels.get(event, event)}"
        lines[7:7] = [
            f"实时资讯雷达：{'正常' if radar.get('ok') else '异常'}",
            f"Theory Radar：{'正常' if theory_radar.get('ok') else '异常'} / 最新 {theory_radar.get('latestPublicReport') or '-'}",
            f"真实访客统计：{'正常' if analytics.get('ok') else '不可用'}",
        ]
        if analytics.get("ok"):
            yesterday = analytics.get("yesterday") or {}
            seven_days = analytics.get("sevenDays") or {}
            top_paths = analytics.get("topPaths") or []
            top_paths_text = "、".join(
                f"{item.get('path') or '/'}（{item.get('pv') or 0} PV）"
                for item in top_paths[:3]
                if isinstance(item, dict)
            ) or "-"
            lines[2:2] = [
                f"统计日期（前一完整自然日）：{analytics.get('date') or '-'}",
                f"真实访客：{yesterday.get('uv') or 0} 人 / {yesterday.get('pv') or 0} PV / 人均 {yesterday.get('pagesPerVisitor') or 0} 页",
                f"近 7 日真实访客：{seven_days.get('uv') or 0} 人 / {seven_days.get('pv') or 0} PV",
                f"热门页面：{top_paths_text}",
                "统计口径：仅 human；已排除本人调试、AI Ops、预加载、机器人和旧版未验证流量",
            ]
        else:
            lines[2:2] = [
                f"统计日期（前一完整自然日）：{analytics.get('date') or '-'}",
                "真实访客：聚合数据暂不可用",
                "统计口径：不降级使用系统流量或旧版未验证数据",
            ]
    return "\n".join(lines)


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
                job["notification"] = {
                    "status": notification.get("status"),
                    "providerCode": notification.get("providerCode"),
                    "sent": True,
                }
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
        "title": (task.get("question") or "AI 模型任务待办")[:120],
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
    result["note"] = "已基于待办触发内部巡检；未外发待办标题、摘要或 AI 模型输出。"
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
    return TASK_STORE.list(limit)


def prepare_vibe_task(mode, question, conversation=None, project_id=None, runtime_context=None):
    mode = (mode or "readonly_inspect").strip()
    question = (question or "").strip()
    conversation = (conversation or "").strip()[-4000:]
    bound_project = (project_id or "mycc").strip()
    workflows = {item["id"]: item for item in harness_payload()["workflows"]}
    workflow = workflows.get(mode) or workflows["readonly_inspect"]
    if not question:
        return {"ok": False, "error": "empty question"}
    if len(question) > 1600:
        return {"ok": False, "error": "question too long"}
    context = build_project_context(bound_project)
    if not context.get("ok"):
        return {"ok": False, "error": "project context not ready", "project": bound_project, "context": {key: value for key, value in context.items() if key != "prompt"}}
    return {
        "ok": True,
        "mode": mode,
        "question": question,
        "conversation": conversation,
        "project": bound_project,
        "workflow": workflow,
        "context": context,
        "runtimeContext": runtime_context,
    }


def execute_vibe_task(task_id, prepared, notify=False):
    workflow = prepared["workflow"]
    question = prepared["question"]
    conversation = prepared["conversation"]
    bound_project = prepared["project"]
    context = prepared["context"]
    runtime_context = prepared.get("runtimeContext")
    started = time.time()
    prompt = harness_prompt() + "\n\n当前工作模式：" + workflow["prompt"]
    if conversation:
        prompt += "\n\n网页端连续对话上下文（已脱敏，仅供理解当前轮）：\n" + conversation
    prompt += "\n\n川哥发来的任务：" + question
    prompt += "\n\n本轮已绑定只读项目：" + bound_project
    prompt += "\n允许读取的文件清单：" + json.dumps(context.get("files") or [], ensure_ascii=False)
    prompt += "\n源码正文未注入 prompt；需要核对时必须调用 aiops_read、aiops_grep、aiops_find 或 aiops_ls。"
    if runtime_context:
        runtime_text = redact_sensitive_text(json.dumps(runtime_context, ensure_ascii=False, indent=2))[:12000]
        prompt += "\n\n本轮实时运行上下文如下；它比源码快照更新，应优先用于判断当前状态：\n```json\n" + runtime_text + "\n```"
    brain_result = internal_service_json(
        AI_OPS_BRAIN_URL,
        "/run",
        {
            "taskId": task_id,
            "project": bound_project,
            "workflow": "readonly_safe",
            "prompt": prompt,
        },
        timeout=210,
        require_token=True,
    )
    output = brain_result.get("output") or brain_result.get("error") or "brain returned no output"
    ok = bool(brain_result.get("ok"))
    item = {
        "ok": ok,
        "mode": workflow["id"],
        "modeName": workflow["name"],
        "project": bound_project,
        "question": redact_sensitive_text(question),
        "conversationPreview": redact_sensitive_text(conversation)[-1000:],
        "answer": compact_task_answer(output),
        "durationMs": round((time.time() - started) * 1000),
        "toolMode": "readonly_safe",
        "brainBoundary": "model-only-no-docker-no-ssh",
    }
    if brain_result.get("error"):
        item["error"] = brain_result.get("error")
    if context:
        item["context"] = {key: value for key, value in context.items() if key != "prompt"}
    if runtime_context:
        item["runtimeContext"] = runtime_context
    if notify:
        try:
            notify_text = f"AI Ops {AI_OPS_OMP_MODEL_LABEL} 任务完成\n" + f"状态：{'成功' if item['ok'] else '失败'}\n模式：{item['modeName']}\n任务ID：{task_id}\n耗时：{item['durationMs']}ms\n审计：请在 /vibe/tasks 查看脱敏结果。"
            item["feishu"] = send_feishu_text(notify_text)
        except Exception as exc:
            item["feishu"] = {"status": "error", "body": sanitize_terminal_text(str(exc))}
    return item


def run_vibe_task(mode, question, conversation=None, notify=False, project_id=None, runtime_context=None):
    prepared = prepare_vibe_task(mode, question, conversation, project_id, runtime_context)
    if not prepared.get("ok"):
        return prepared
    if not TASK_LOCK.acquire(blocking=False):
        return {"ok": False, "error": "task already running"}
    task_id = time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(3)
    try:
        now = time.time()
        elapsed = now - TASK_STATE["last_run"]
        if elapsed < TASK_COOLDOWN_SECONDS:
            return {"ok": False, "error": "cooldown", "retryAfterSeconds": round(TASK_COOLDOWN_SECONDS - elapsed)}
        created = TASK_STORE.create({
            "id": task_id,
            "ok": None,
            "mode": prepared["workflow"]["id"],
            "modeName": prepared["workflow"]["name"],
            "project": prepared["project"],
            "question": redact_sensitive_text(prepared["question"]),
            "conversationPreview": redact_sensitive_text(prepared["conversation"])[-1000:],
            "answer": "",
            "toolMode": "readonly_safe",
            "brainBoundary": "model-only-no-docker-no-ssh",
        })
        TASK_STORE.update(task_id, {"status": "running", "startedAt": now_text()}, expected_revision=created["revision"])
        item = execute_vibe_task(task_id, prepared, notify)
        status = "completed" if item.get("ok") else "failed"
        result = TASK_STORE.update(task_id, {**item, "status": status, "finishedAt": now_text()})
        TASK_STATE["last_run"] = time.time()
        return result.get("task") or item
    finally:
        TASK_LOCK.release()


def run_vibe_task_worker(task_id, prepared, notify):
    try:
        if not TASK_LOCK.acquire(timeout=5):
            TASK_STORE.update(task_id, {"ok": False, "status": "failed", "error": "task_lock_unavailable", "finishedAt": now_text()})
            return
        try:
            current = TASK_STORE.load(task_id) or {}
            if current.get("status") in TERMINAL_STATUSES:
                return
            if current.get("status") == "aborting":
                TASK_STORE.update(task_id, {"ok": False, "status": "aborted", "error": "aborted_before_start", "answer": "任务已终止。", "finishedAt": now_text()})
                return
            running_result = TASK_STORE.update(task_id, {"status": "running", "startedAt": now_text()})
            if not running_result.get("ok"):
                return
            item = execute_vibe_task(task_id, prepared, notify)
            current = TASK_STORE.load(task_id) or {}
            aborted = current.get("status") in {"aborting", "aborted"} or item.get("error") == "brain_aborted"
            status = "aborted" if aborted else ("completed" if item.get("ok") else "failed")
            if aborted:
                item.update({"ok": False, "error": "aborted", "answer": "任务已由用户终止。"})
            TASK_STORE.update(task_id, {**item, "status": status, "finishedAt": now_text()})
            TASK_STATE["last_run"] = time.time()
        finally:
            TASK_LOCK.release()
    except Exception as exc:
        TASK_STORE.update(task_id, {"ok": False, "status": "failed", "error": type(exc).__name__, "answer": "任务执行失败，请查看审计状态。", "finishedAt": now_text()})
    finally:
        with TASK_WORKERS_LOCK:
            TASK_WORKERS.pop(task_id, None)


def start_vibe_task(payload):
    payload = payload if isinstance(payload, dict) else {}
    client_request_id = str(payload.get("clientRequestId") or "").strip()
    if client_request_id and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,119}", client_request_id):
        return {"ok": False, "error": "invalid client request id"}
    existing = TASK_STORE.find_by_client_request_id(client_request_id) if client_request_id else None
    if existing:
        return {"ok": True, "accepted": not existing.get("terminal"), "duplicate": True, "task": existing, "pollUrl": f"/vibe/task?id={existing['id']}"}
    active = TASK_STORE.active()
    if TASK_LOCK.locked() or active:
        return {"ok": False, "error": "task already running", "activeTask": active[0] if active else None}
    elapsed = time.time() - TASK_STATE["last_run"]
    if elapsed < TASK_COOLDOWN_SECONDS:
        return {"ok": False, "error": "cooldown", "retryAfterSeconds": round(TASK_COOLDOWN_SECONDS - elapsed)}
    prepared = prepare_vibe_task(payload.get("mode"), payload.get("question"), payload.get("conversation"), payload.get("project"), payload.get("runtimeContext"))
    if not prepared.get("ok"):
        return prepared
    task_id = time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(3)
    snapshot = TASK_STORE.create({
        "id": task_id,
        "clientRequestId": client_request_id or None,
        "ok": None,
        "mode": prepared["workflow"]["id"],
        "modeName": prepared["workflow"]["name"],
        "project": prepared["project"],
        "question": redact_sensitive_text(prepared["question"]),
        "conversationPreview": redact_sensitive_text(prepared["conversation"])[-1000:],
        "answer": "",
        "toolMode": "readonly_safe",
        "brainBoundary": "model-only-no-docker-no-ssh",
    })
    worker = threading.Thread(target=run_vibe_task_worker, args=(task_id, prepared, bool(payload.get("notify"))), daemon=True)
    with TASK_WORKERS_LOCK:
        TASK_WORKERS[task_id] = worker
    worker.start()
    return {"ok": True, "accepted": True, "duplicate": False, "task": snapshot, "pollUrl": f"/vibe/task?id={task_id}"}


def abort_vibe_task(task_id, expected_revision=None):
    snapshot = TASK_STORE.load(task_id)
    if not snapshot:
        return {"ok": False, "error": "task_not_found"}
    if snapshot.get("status") in TERMINAL_STATUSES:
        return {"ok": True, "alreadyTerminal": True, "task": snapshot}
    result = TASK_STORE.update(task_id, {"status": "aborting", "abortRequestedAt": now_text()}, expected_revision=expected_revision)
    if not result.get("ok"):
        return result
    brain = internal_service_json(AI_OPS_BRAIN_URL, "/abort", {"taskId": task_id}, timeout=12, require_token=True)
    if brain.get("error") == "task_not_running":
        final = TASK_STORE.update(task_id, {"ok": False, "status": "aborted", "error": "aborted_before_start", "answer": "任务已终止。", "finishedAt": now_text()})
        return {"ok": True, "brain": brain, "task": final.get("task")}
    return {"ok": bool(brain.get("ok")), "brain": brain, "task": TASK_STORE.load(task_id)}


def render_vibe_tasks_page():
    return f"""<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Grok 任务审计 - AI Ops</title><style>{cockpit_page_style()}</style></head><body><main>{nav_html('vibe')}<section class=\"card\"><h1>Grok 任务审计</h1><p class=\"muted\">只展示脱敏后的最近任务输入与输出；支持筛选、复制结果、失败高亮，可一键沉淀为待办。</p><div class=\"toolbar\"><label>状态 <select id=\"statusFilter\"><option value=\"all\">全部</option><option value=\"ok\">成功</option><option value=\"fail\">失败</option></select></label><button id=\"reloadTasks\">刷新</button><a href=\"/vibe/todos\">查看待办</a><span id=\"taskSummary\" class=\"muted\"></span></div><table><thead><tr><th>时间</th><th>模式</th><th>任务</th><th>状态</th><th>输出</th></tr></thead><tbody id=\"taskRows\"><tr><td colspan=5>加载中...</td></tr></tbody></table></section></main><script>
const token = sessionStorage.getItem('aiopsReadToken') || '';
let allTasks = [];
function escapeHtml(value) {{ return String(value || '').replace(/[&<>\"']/g, ch => ({{'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}}[ch])); }}
function auditStatus(item) {{
  const status = item.status || (item.ok ? 'completed' : 'failed');
  return ({{queued:'⏳ 排队',running:'🔄 运行中',aborting:'⏹️ 终止中',completed:'✅ 成功',failed:'⚠️ 失败',aborted:'⏹️ 已终止'}})[status] || status;
}}
function renderTasks() {{
  const body = document.getElementById('taskRows');
  const filter = document.getElementById('statusFilter').value;
  const tasks = allTasks.filter(item => filter === 'all' || (filter === 'ok' ? (item.status === 'completed' || item.ok === true) : ((item.terminal !== false && item.status !== 'completed') || item.ok === false)));
  document.getElementById('taskSummary').textContent = `共 ${{allTasks.length}} 条，当前显示 ${{tasks.length}} 条`;
  body.innerHTML = tasks.map((item, index) => `<tr class="${{item.status === 'completed' || item.ok ? 'ok' : (item.terminal === false ? '' : 'fail')}}"><td>${{escapeHtml(item.createdAt)}}<br><span class="muted">rev ${{item.revision || 0}}</span></td><td>${{escapeHtml(item.modeName)}}</td><td>${{escapeHtml(item.question)}}</td><td>${{auditStatus(item)}}</td><td><button data-copy-index="${{index}}">复制结果</button><button data-todo-id="${{escapeHtml(item.id)}}" ${{item.status && item.status !== 'completed' ? 'disabled' : ''}}>转待办</button><details><summary>查看</summary><pre>${{escapeHtml(item.answer || item.error || '任务仍在运行')}}</pre></details></td></tr>`).join('') || '<tr><td colspan=5>暂无任务</td></tr>';
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
setInterval(() => {{ if (allTasks.some(item => item.terminal === false)) loadTasks(); }}, 5000);
</script></body></html>"""


def render_vibe_todos_page():
    return f"""<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>AI Ops 待办 - Vibe</title><style>{cockpit_page_style()}</style></head><body><main>{nav_html('vibe')}<section class=\"card\"><h1>AI Ops 待办</h1><p class=\"muted\">由 Grok 任务审计一键沉淀，默认只保存脱敏摘要和任务 ID；用于后续转工单/周报。</p><input id=\"todoSearch\" placeholder=\"搜索标题/摘要/ID\"><select id=\"todoStatusFilter\"><option value=\"all\">全部</option><option value=\"open\">open</option><option value=\"doing\">doing</option><option value=\"done\">done</option></select><button id=\"reloadTodos\">刷新</button><span id=\"todoSummary\" class=\"muted\"></span><table><thead><tr><th>时间</th><th>状态</th><th>标题</th><th>摘要</th><th>来源</th></tr></thead><tbody id=\"todoRows\"><tr><td colspan=5>加载中...</td></tr></tbody></table></section></main><script>
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
    return f"""<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>待办详情 - AI Ops</title><style>{cockpit_page_style()}</style></head><body><main>{nav_html('vibe')}<section class=\"card\"><h1>{html.escape(todo.get('title') or 'AI Ops 待办')}</h1><p class=\"muted\">ID：<code>{html.escape(todo.get('id'))}</code> · 状态：{html.escape(todo.get('status'))} · 来源任务：<code>{html.escape(todo.get('taskId'))}</code></p><h2>脱敏摘要</h2><pre>{html.escape(todo.get('summary') or '')}</pre><h2>处理记录</h2><ul><li>创建：{html.escape(todo.get('createdAt') or '-')}</li><li>更新：{html.escape(todo.get('updatedAt') or '-')}</li><li>最后通知：{html.escape(todo.get('lastNotifiedAt') or '-')}</li></ul><h2>来源任务元信息</h2><pre>{html.escape(json.dumps(task, ensure_ascii=False, indent=2))}</pre><p><a href=\"/vibe/todos\">返回待办列表</a></p></section></main></body></html>"""


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
    return f"""<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>资产矩阵 - AI Ops</title><style>{cockpit_page_style()}</style></head><body><main>{nav_html('vibe')}<section class=\"card\"><h1>服务器资产矩阵</h1><p class=\"muted\">就绪度为启发式运维信号，不代表项目业务质量；异常以 Kuma/日志/审计为准。</p><table><thead><tr><th>资产</th><th>角色</th><th>状态</th><th>就绪度</th><th>风险</th><th>容器</th><th>磁盘%</th><th>Down</th></tr></thead><tbody>{server_rows}</tbody></table></section><section class=\"card\"><h1>项目工作区</h1><p class=\"muted\">当前只允许只读探测；未挂载项目保持待接入，避免 Grok 乱改真实项目。就绪度仅表示挂载/只读/git 状态。</p><table><thead><tr><th>项目</th><th>路径</th><th>状态</th><th>就绪度</th><th>风险</th><th>详情</th></tr></thead><tbody>{workspace_rows}</tbody></table></section><section class="card"><h1>项目文件级 Allowlist</h1><p class="muted">真实项目默认只占位；接入前必须明确文件级 allowlist，禁止目录级同步整仓。</p><table><thead><tr><th>项目</th><th>状态</th><th>文件数</th><th>允许文件</th></tr></thead><tbody>{allowlist_rows}</tbody></table></section></main></body></html>"""


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
            {"name": "HOME AGENTS", "path": "aiops_read(mycc, AGENTS.md)", "scope": "HOME 白名单、secret、并发、git 权限"},
            {"name": "mycc CLAUDE", "path": "aiops_read(mycc, CLAUDE.md)", "scope": "BRO-PDCA、记忆系统、归档、验收"},
            {"name": "project AGENTS", "path": "aiops_read(mycc, AGENTS.md)", "scope": "Codex/mycc 项目规则"},
            {"name": "AI Ops README", "path": "aiops_read(mycc, 2-Projects/ai-ops-cockpit/README.md)", "scope": "本项目部署、踩坑、验收记录"},
        ],
        "memorySources": [
            {"name": "recent_events", "path": "仅在 mycc 文件级 allowlist 登记后通过 aiops_read", "mode": "read_before_work", "secretPolicy": "no_secret"},
            {"name": "memory_items", "path": "仅在 mycc 文件级 allowlist 登记后通过 aiops_grep/read", "mode": "query_relevant_only", "secretPolicy": "no_secret"},
            {"name": "status", "path": "仅在 mycc 文件级 allowlist 登记后通过 aiops_read", "mode": "current_snapshot", "secretPolicy": "no_secret"},
        ],
        "methodology": {
            "name": "BRO-PDCA",
            "minimum": ["O1 目标", "O2 约束", "Plan 步骤", "Do 执行", "Check 验收", "Action 复盘/沉淀"],
            "stopRules": ["缺关键约束先问", "发现 secret 立即停止", "发现并发冲突立即停止", "真实项目写入前先给计划和验收标准"],
        },
        "permissions": {
            "defaultMode": "readonly_safe",
            "allowedTools": ["aiops_read", "aiops_grep", "aiops_find", "aiops_ls"],
            "writeRequires": "Brain 不具备文件写入、Docker、SSH、部署、commit 或 push 能力；生产动作只能走网页受控动作入口",
            "commitPushOwner": "Codex/cc 收口，OMP/Grok 默认不直接 commit/push",
            "dangerousActions": DANGEROUS_PATTERNS,
        },
        "executionBoundary": {
            "brain": "OMP + 模型密钥；无 Docker Socket、生产 SSH、真实项目写挂载",
            "readonlyRunner": "仅挂载文件级 allowlist 只读快照；无模型密钥、Webhook、Push URL、SSH、Docker Socket",
            "hands": "ops-inspector 保留人工受控动作、确认票据、冷却、审计和动作后验收",
            "policy": "未知项目、未知 workflow、未知工具、敏感路径、绝对路径、.. 和软链接全部 fail closed",
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
2. 默认 readonly_safe；只能使用 aiops_read/grep/find/ls 读取已登记文件级快照。Brain 没有写文件、Docker、SSH、部署、commit 或 push 能力。
3. 真实项目接入前，不能凭空假设路径、密钥、部署方式；先读项目规则和 README。
4. secret、Webhook、Kuma Push URL、OAuth code/token、密码、cookie、API key 不得输出到文档、git、记忆或日志摘要。
5. 遇到 UI 白屏/接口异常/服务不响应，必须先做根因检查和真实页面验收，不能只看 HTTP 200。
6. 需要生产动作时只能输出建议和验收方案，等待川哥在网页受控动作入口确认；不要尝试绕过 Tool Policy Gate。
7. 输出按 BRO-PDCA：O1/O2 → Plan → Do/建议 → Check 验收 → Action 沉淀。

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


def cockpit_page_style():
    return """
:root{--bg:#070b10;--panel:#101821;--panel2:#14202b;--line:rgba(148,163,184,.18);--text:#e7edf5;--muted:#8b9aae;--dim:#607083;--green:#55d68b;--yellow:#f4c95d;--orange:#ff9a5c;--red:#ff6b6b;--blue:#65a9ff;--cyan:#49d4d4;--violet:#a48cff}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:radial-gradient(circle at 10% 0%,rgba(73,212,212,.13),transparent 26%),radial-gradient(circle at 90% 10%,rgba(101,169,255,.13),transparent 30%),linear-gradient(180deg,#091017,#070b10 62%);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI","PingFang SC",sans-serif}
main{max-width:1240px;margin:0 auto;padding:28px}
h1{font-size:34px;line-height:1.05;letter-spacing:-.055em;margin:0 0 8px}
h2{font-size:19px;letter-spacing:-.025em;margin:0 0 10px}
h3{margin:0 0 8px}
p{line-height:1.55}
.hero,.card{position:relative;background:linear-gradient(180deg,rgba(20,32,43,.94),rgba(12,18,26,.94));border:1px solid var(--line);border-radius:22px;padding:22px;margin:16px 0;box-shadow:0 24px 80px rgba(0,0,0,.34);overflow:hidden}
.hero{background:radial-gradient(circle at top right,rgba(73,212,212,.16),transparent 34%),linear-gradient(135deg,rgba(16,24,33,.96),rgba(18,49,58,.86) 58%,rgba(23,37,84,.76));border-radius:26px;padding:28px}
.hero:before,.card:before{content:"";position:absolute;inset:0;background:radial-gradient(circle at top right,rgba(101,169,255,.08),transparent 36%);pointer-events:none}
.hero>* ,.card>*{position:relative}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:16px}
.muted{color:var(--muted)}
.ok{color:var(--green)}.warn{color:var(--yellow)}.fail{color:var(--red)}
a{color:#9bd7ff;text-decoration:none}
a:hover{text-decoration:underline}
button,a.btn{display:inline-block;border:1px solid rgba(73,212,212,.38);background:linear-gradient(135deg,rgba(73,212,212,.20),rgba(101,169,255,.16));color:var(--text);border-radius:12px;padding:9px 13px;text-decoration:none;cursor:pointer;margin:4px 8px 4px 0;font-weight:650}
button:hover,a.btn:hover{filter:brightness(1.08);text-decoration:none}
button:disabled{opacity:.45;cursor:not-allowed}
input,textarea,select{background:#071018;color:var(--text);border:1px solid var(--line);border-radius:12px;padding:10px 12px;margin:4px;outline:none}
input:focus,textarea:focus,select:focus{border-color:rgba(73,212,212,.52);box-shadow:0 0 0 3px rgba(73,212,212,.09)}
input,textarea{width:100%}
code{background:#050a0f;border:1px solid rgba(148,163,184,.16);padding:2px 6px;border-radius:7px;word-break:break-all}
pre{white-space:pre-wrap;background:#050a0f;border:1px solid rgba(73,212,212,.14);border-radius:16px;padding:13px;max-height:360px;overflow:auto;color:#b8c7d7;font-size:12px;line-height:1.55}
table{width:100%;border-collapse:collapse;font-size:12px}
td,th{border-bottom:1px solid rgba(148,163,184,.14);padding:10px;text-align:left;vertical-align:top}
th{color:var(--dim);font-size:10px;text-transform:uppercase;letter-spacing:.08em}
tr.fail{background:rgba(255,107,107,.08)}
tr.ok{background:rgba(85,214,139,.07)}
.topnav{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px}
.topnav a{color:#cbd5e1;text-decoration:none;background:rgba(255,255,255,.035);border:1px solid var(--line);border-radius:999px;padding:8px 12px}
.topnav a.active{background:linear-gradient(135deg,rgba(73,212,212,.20),rgba(101,169,255,.16));border-color:rgba(73,212,212,.34);color:white}
.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.pill{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:6px 10px;margin:4px;background:rgba(255,255,255,.035)}
.terminal{height:58vh;border:1px solid var(--line);border-radius:18px;overflow:hidden;background:#020617}
iframe{border:0;width:100%;height:100%}
.chat div{border:1px solid var(--line);border-radius:14px;padding:12px;margin:10px 0}
.chat .user{background:rgba(101,169,255,.12)}
.chat .assistant{background:rgba(255,255,255,.035)}
ul{line-height:1.65}
details summary{cursor:pointer;color:#9bd7ff}
@media(max-width:760px){main{padding:16px}.hero,.card{padding:18px;border-radius:18px}h1{font-size:28px}}
"""


def cockpit_frame_style():
    return """
html,body{margin:0;height:100%;background:#070b10;color:#e7edf5;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI","PingFang SC",sans-serif}
body{display:flex;flex-direction:column}
.topbar{padding:12px 16px;background:rgba(16,24,33,.92);border-bottom:1px solid rgba(148,163,184,.18);z-index:10;box-shadow:0 16px 50px rgba(0,0,0,.28)}
.topnav{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.topnav a{color:#cbd5e1;text-decoration:none;background:rgba(255,255,255,.035);border:1px solid rgba(148,163,184,.18);border-radius:999px;padding:8px 12px}
.topnav a.active{background:linear-gradient(135deg,rgba(73,212,212,.20),rgba(101,169,255,.16));border-color:rgba(73,212,212,.34);color:white}
iframe{border:0;flex:1;width:100%;min-height:0}
.hint{color:#8b9aae;margin-left:auto}
"""


def nav_html(active="home"):
    links = [
        ("首页", "/", "home"),
        ("总览", "/ops-dashboard/", "dashboard"),
        ("AI 详情", "/ai/", "ai"),
        ("Vibe Coding", "/vibe/", "vibe"),
        ("Tool Runtime", "/vibe/ops-runtime", "runtime"),
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


def render_ops_runtime_page():
    payload = ops_runtime_payload()
    runtime = payload["runtime"]
    projects = payload["projects"]
    tools = payload["tools"]
    executions = payload["executions"]
    readonly_safe = payload["readonlySafe"]
    architecture = payload["architecture"]
    project_options = "".join(f"<option value='{html.escape(item['id'])}'>{html.escape(item['name'])}</option>" for item in projects)
    action_options = {}
    for project in projects:
        action_options[project["id"]] = [
            {"id": action["id"], "label": action["label"], "risk": action["risk"], "confirmationRequired": action["confirmationRequired"]}
            for action in project.get("actions", [])
            if action["id"] != "inspect"
        ]
    sidebar_projects = "".join(
        f"""<button class=\"side-item\" data-select-project=\"{html.escape(item['id'])}\"><span><i class=\"status-dot {'green' if item['productionConfigured'] else 'yellow'}\"></i>{html.escape(item['name'])}</span><em>{item['allowlistCount']}</em></button>"""
        for item in projects
    )
    tool_cards = "".join(
        f"""<article class=\"tool-card\"><div><p>{html.escape(item['name'])}</p><h3>{html.escape(item['title'])}</h3><span>{html.escape(item['description'])}</span></div><div class=\"tool-foot\"><b class=\"risk {html.escape(item['risk'])}\">{html.escape(item['risk'])}</b><button data-tool=\"{html.escape(item['name'])}\" {'disabled' if item['risk'] == 'blocked' else ''}>运行</button></div></article>"""
        for item in tools
    )
    project_rows = "".join(
        f"""<tr><td><strong>{html.escape(item['name'])}</strong><small>{html.escape(item['id'])}</small></td><td>{item['allowlistCount']} 文件<br><small>{item['liveProbeCount']} 探针</small></td><td>{'已接入' if item['productionConfigured'] else '未接入'}</td><td>{html.escape('、'.join(action['label'] for action in item.get('actions', [])))}</td></tr>"""
        for item in projects
    )
    execution_cards = "".join(
        f"""<div class=\"record\"><strong>{html.escape(item.get('tool') or '')}</strong><span>{html.escape(item.get('project') or '')} · {html.escape(item.get('createdAt') or '')}</span><em class=\"{'ok' if (item.get('resultSummary') or {}).get('ok') else 'warn'}\">{'OK' if (item.get('resultSummary') or {}).get('ok') else 'WARN'}</em><code>{html.escape(item.get('id') or '')}</code></div>"""
        for item in executions[:6]
    ) or "<div class=\"record empty\"><strong>暂无执行记录</strong><span>运行任意只读工具后会出现 ExecutionRecord。</span></div>"
    latest = executions[0] if executions else {}
    latest_summary = latest.get("resultSummary") or {}
    tools_json = json.dumps({item["name"]: item for item in tools}, ensure_ascii=False)
    actions_json = json.dumps(action_options, ensure_ascii=False)
    brain = architecture.get("brain") or {}
    runner = architecture.get("readonlyRunner") or {}
    brain_state = "隔离正常" if brain.get("ok") and not brain.get("directWorkspace") and not brain.get("dockerSocket") and not brain.get("productionSsh") else "边界异常"
    runner_state = "策略门正常" if runner.get("ok") and runner.get("mountReadonly") else "策略门异常"
    architecture_card = f"""<div class=\"card\" style=\"margin-bottom:14px\"><div class=\"label\">Brain / Hands 安全架构 <span>enforced boundary</span></div><div class=\"grid-2\"><div><h3>Brain：{html.escape(brain_state)}</h3><p class=\"sub\">OMP + 模型密钥；无 Docker Socket、生产 SSH 和真实项目挂载。</p></div><div><h3>Readonly Runner：{html.escape(runner_state)}</h3><p class=\"sub\">{html.escape(readonly_safe.get('workflow') or 'readonly_safe')} · {html.escape('、'.join(readonly_safe.get('tools') or []))}</p></div></div><p class=\"sub\" style=\"margin-top:12px\">Hands：{html.escape(architecture.get('hands') or '')}。未知项目、未知工具、绝对路径、..、软链接和敏感路径全部 fail closed。</p></div>"""
    page = f"""<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Ops Tool Runtime - AI Ops</title><style>
:root{{--bg:#070b10;--panel:#101821;--panel2:#14202b;--line:rgba(148,163,184,.18);--text:#e7edf5;--muted:#8b9aae;--dim:#607083;--green:#55d68b;--yellow:#f4c95d;--orange:#ff9a5c;--red:#ff6b6b;--blue:#65a9ff;--cyan:#49d4d4;--violet:#a48cff}}*{{box-sizing:border-box}}body{{margin:0;min-height:100vh;background:radial-gradient(circle at 10% 0%,rgba(73,212,212,.14),transparent 26%),radial-gradient(circle at 90% 10%,rgba(101,169,255,.14),transparent 30%),linear-gradient(180deg,#091017,#070b10 62%);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI','PingFang SC',sans-serif}}.app{{display:grid;grid-template-columns:270px minmax(720px,1fr) 340px;gap:16px;min-height:100vh;padding:16px}}.sidebar,.main,.right{{background:rgba(16,24,33,.86);border:1px solid var(--line);box-shadow:0 24px 80px rgba(0,0,0,.38);backdrop-filter:blur(20px);overflow:hidden}}.sidebar{{border-radius:24px;display:flex;flex-direction:column}}.brand{{padding:22px 20px;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:center}}.logo{{width:40px;height:40px;border-radius:13px;background:linear-gradient(145deg,var(--cyan),var(--blue) 65%,var(--violet));display:grid;place-items:center;color:#041118;font-weight:900}}h1,h2,h3,p{{margin:0}}.brand h1{{font-size:17px}}.brand p,.muted{{color:var(--muted)}}.nav{{padding:14px 10px;display:grid;gap:6px}}.side-item{{border:0;color:var(--muted);background:transparent;border-radius:14px;min-height:42px;padding:0 12px;display:flex;align-items:center;justify-content:space-between;text-align:left;font:inherit}}.side-item.primary,.side-item:hover{{color:var(--text);background:linear-gradient(90deg,rgba(73,212,212,.16),rgba(101,169,255,.08));outline:1px solid rgba(73,212,212,.22)}}.side-item span{{display:flex;align-items:center;gap:10px}}.side-item em{{font-style:normal;border:1px solid var(--line);border-radius:999px;padding:3px 8px;color:var(--muted);font-size:11px}}.status-dot{{width:8px;height:8px;border-radius:99px;background:var(--dim);box-shadow:0 0 0 3px rgba(136,152,170,.08)}}.status-dot.green{{background:var(--green)}}.status-dot.yellow{{background:var(--yellow)}}.safe-card{{margin:auto 14px 14px;border:1px solid rgba(85,214,139,.2);background:rgba(85,214,139,.06);border-radius:18px;padding:14px;color:var(--muted);font-size:12px;line-height:1.55}}.safe-card b{{display:block;color:var(--text);font-size:13px;margin-bottom:6px}}.main{{border-radius:24px;display:flex;flex-direction:column}}.topbar{{min-height:78px;padding:17px 22px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:18px}}.topbar h2{{font-size:24px;letter-spacing:-.04em}}.badges{{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}}.badge{{border:1px solid var(--line);background:rgba(255,255,255,.035);border-radius:999px;padding:8px 11px;color:var(--muted);font-size:12px}}.badge strong{{color:var(--text)}}.content{{padding:18px;overflow:auto}}.hero-grid{{display:grid;grid-template-columns:1.25fr .75fr .75fr;gap:14px;margin-bottom:14px}}.card,.tool-card{{position:relative;background:linear-gradient(180deg,rgba(20,32,43,.94),rgba(12,18,26,.94));border:1px solid var(--line);border-radius:18px;padding:16px;overflow:hidden}}.card:before,.tool-card:before{{content:'';position:absolute;inset:0;background:radial-gradient(circle at top right,rgba(101,169,255,.08),transparent 36%);pointer-events:none}}.card>* ,.tool-card>*{{position:relative}}.label{{color:var(--muted);font-size:12px;margin-bottom:12px;display:flex;justify-content:space-between}}.big{{font-size:38px;font-weight:780;letter-spacing:-.06em;line-height:1.05}}.sub{{color:var(--muted);font-size:12px;line-height:1.55;margin-top:10px}}.flow{{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-top:15px}}.step{{border:1px solid var(--line);background:rgba(255,255,255,.035);border-radius:13px;padding:10px;min-height:76px}}.step b{{display:block;font-size:12px;margin:5px 0}}.step i{{font-style:normal;color:var(--cyan);font-weight:800;font-size:11px}}.step span{{display:block;color:var(--muted);font-size:11px;line-height:1.35}}.metric{{font-size:36px;font-weight:780;letter-spacing:-.05em}}.tool-grid{{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}}.tool-card{{min-height:150px;display:flex;flex-direction:column;justify-content:space-between}}.tool-card p{{color:var(--cyan);font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}}.tool-card h3{{font-size:16px;margin:7px 0 8px}}.tool-card span{{color:var(--muted);font-size:12px;line-height:1.5}}.tool-foot{{display:flex;align-items:center;justify-content:space-between;margin-top:14px}}button,a.btn{{border:1px solid rgba(73,212,212,.38);background:linear-gradient(135deg,rgba(73,212,212,.20),rgba(101,169,255,.16));color:var(--text);border-radius:12px;padding:9px 12px;text-decoration:none;font-weight:650;cursor:pointer}}button:disabled{{opacity:.35;cursor:not-allowed}}select{{background:#071018;color:var(--text);border:1px solid var(--line);border-radius:12px;padding:10px;margin-right:8px}}pre,code{{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}}pre{{white-space:pre-wrap;background:#050a0f;border:1px solid rgba(73,212,212,.14);border-radius:16px;padding:14px;max-height:280px;overflow:auto;color:#b8c7d7;font-size:12px;line-height:1.55}}.risk{{border-radius:999px;padding:5px 9px;font-size:11px;border:1px solid var(--line)}}.risk.readonly{{color:var(--green);background:rgba(85,214,139,.08);border-color:rgba(85,214,139,.22)}}.risk.confirm{{color:var(--yellow);background:rgba(244,201,93,.08);border-color:rgba(244,201,93,.22)}}.risk.blocked{{color:var(--red);background:rgba(255,107,107,.08);border-color:rgba(255,107,107,.22)}}.grid-2{{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px}}table{{width:100%;border-collapse:collapse;font-size:12px}}td,th{{border-bottom:1px solid rgba(148,163,184,.14);padding:10px;text-align:left;vertical-align:top}}th{{color:var(--dim);font-size:10px;text-transform:uppercase;letter-spacing:.08em}}td small{{display:block;color:var(--muted);margin-top:3px}}.right{{border-radius:24px;display:flex;flex-direction:column}}.right-head{{padding:18px;border-bottom:1px solid var(--line)}}.right-head h3{{font-size:16px}}.right-body{{padding:14px;display:grid;gap:12px;overflow:auto}}.panel{{border:1px solid var(--line);border-radius:18px;background:rgba(255,255,255,.035);padding:14px}}.panel h4{{margin:0 0 10px;font-size:13px;display:flex;justify-content:space-between}}.kv{{display:grid;gap:8px;font-size:12px}}.kv div{{display:flex;justify-content:space-between;gap:10px;color:var(--muted)}}.kv strong{{color:var(--text);text-align:right}}.approval{{border:1px solid rgba(255,154,92,.24);background:rgba(255,154,92,.06);border-radius:14px;padding:12px;color:var(--muted);font-size:12px;line-height:1.5}}.record{{display:grid;gap:5px;border:1px solid var(--line);border-radius:14px;background:rgba(255,255,255,.035);padding:11px;font-size:12px}}.record span{{color:var(--muted)}}.record em{{font-style:normal;font-weight:700}}.record em.ok{{color:var(--green)}}.record em.warn{{color:var(--yellow)}}.record code{{color:var(--dim);word-break:break-all}}.topnav{{display:none}}@media(max-width:1180px){{.app{{grid-template-columns:240px 1fr}}.right{{display:none}}.hero-grid,.grid-2{{grid-template-columns:1fr}}.tool-grid{{grid-template-columns:1fr}}}}
</style></head><body><div class=\"app\"><aside class=\"sidebar\"><div class=\"brand\"><div class=\"logo\">OPS</div><div><h1>AI Ops Cockpit</h1><p>Grok Build style runtime</p></div></div><div class=\"nav\"><a class=\"side-item\" href=\"/\"><span><i class=\"status-dot green\"></i>首页</span><em>home</em></a><a class=\"side-item primary\" href=\"/vibe/ops-runtime\"><span><i class=\"status-dot green\"></i>Ops Tool Runtime</span><em>new</em></a><a class=\"side-item\" href=\"/vibe/\"><span><i class=\"status-dot green\"></i>Vibe Coding</span><em>grok</em></a>{sidebar_projects}</div><div class=\"safe-card\"><b>安全边界</b>Grok 只能调用白名单工具。重启、修复、回滚必须 action token、确认词、冷却和动作后验收。</div></aside><main class=\"main\"><header class=\"topbar\"><div><h2>Ops Tool Runtime</h2><p class=\"muted\">把巡检、证据、受控动作统一成 Grok 可调用的工具运行时</p></div><div class=\"badges\"><span class=\"badge\"><strong>Grok 4.5</strong> online</span><span class=\"badge\"><strong>Mode</strong> {html.escape(runtime['mode'])}</span><span class=\"badge\"><strong>Trace</strong> enabled</span></div></header><section class=\"content\"><div class=\"hero-grid\"><div class=\"card\"><div class=\"label\">当前智能体闭环 <span>runtime turn</span></div><div class=\"big\">Inspect → Evidence → Act</div><p class=\"sub\">Grok 不直接拿 shell；它只看到工具定义、风险等级、参数 schema 和执行后的证据包。</p><div class=\"flow\"><div class=\"step\"><i>01</i><b>Goal</b><span>用户或定时任务发起目标</span></div><div class=\"step\"><i>02</i><b>Inspect</b><span>调用只读工具收集状态</span></div><div class=\"step\"><i>03</i><b>Evidence</b><span>生成可追溯证据包</span></div><div class=\"step\"><i>04</i><b>Confirm</b><span>高风险动作请求确认</span></div><div class=\"step\"><i>05</i><b>Verify</b><span>动作后公网验收</span></div></div></div><div class=\"card\"><div class=\"label\">Registered Tools <span>schema</span></div><div class=\"metric\">{runtime['toolCount']}</div><p class=\"sub\">只读 {runtime['readonlyToolCount']} 个，受控动作 {runtime['confirmToolCount']} 个，高风险阻断 {runtime['blockedToolCount']} 个。</p></div><div class=\"card\"><div class=\"label\">Projects <span>profile</span></div><div class=\"metric\">{runtime['projectCount']}</div><p class=\"sub\">每个项目都有独立 allowlist、生产通道和动作边界。</p></div></div><div class=\"card\"><div class=\"label\">运行工具 <span>ToolRegistry</span></div><p class=\"sub\" style=\"margin-bottom:12px\">选择项目与动作后运行；结果会写入 ExecutionRecord。</p><select id=\"runtimeProject\">{project_options}</select><select id=\"runtimeAction\"></select><pre id=\"runtimeResult\">等待运行。</pre><div class=\"tool-grid\">{tool_cards}</div></div><div class=\"grid-2\"><div class=\"card\"><div class=\"label\">项目工具矩阵 <span>ProjectProfile</span></div><table><thead><tr><th>项目</th><th>Allowlist / 探针</th><th>生产通道</th><th>动作</th></tr></thead><tbody>{project_rows}</tbody></table></div><div class=\"card\"><div class=\"label\">最近执行轨迹 <span>ExecutionRecord</span></div>{execution_cards}</div></div></section></main><aside class=\"right\"><div class=\"right-head\"><h3>证据与确认队列</h3><p>给人看的“为什么要动”和“动完是否好了”。</p></div><div class=\"right-body\"><div class=\"panel\"><h4>最新证据包 <span class=\"risk readonly\">verified</span></h4><div class=\"kv\"><div><span>Execution ID</span><strong>{html.escape(latest.get('id') or '-')}</strong></div><div><span>Tool</span><strong>{html.escape(latest.get('tool') or '-')}</strong></div><div><span>Project</span><strong>{html.escape(latest.get('project') or '-')}</strong></div><div><span>Duration</span><strong>{html.escape(str(latest.get('durationMs') or '-'))}ms</strong></div><div><span>Secret Exposure</span><strong>0</strong></div><div><span>Result</span><strong>{'OK' if latest_summary.get('ok') else '等待'}</strong></div></div></div><div class=\"panel\"><h4>待确认动作 <span class=\"risk confirm\">safe gate</span></h4><div class=\"approval\"><b>run-controlled-action</b><br>仅允许项目 profile 内的固定动作；确认词不匹配则不会执行。</div></div><div class=\"panel\"><h4>安全策略 <span>PermissionPolicy</span></h4><div class=\"kv\"><div><span>Readonly</span><strong style=\"color:var(--green)\">auto</strong></div><div><span>Restart / Repair</span><strong style=\"color:var(--yellow)\">confirm</strong></div><div><span>Deploy / Shell</span><strong style=\"color:var(--red)\">blocked</strong></div><div><span>Secret</span><strong style=\"color:var(--red)\">never echo</strong></div></div></div></div></aside></div><script>
const tools = {tools_json};
const actionsByProject = {actions_json};
const readToken = {json.dumps(READ_TOKEN)};
const actionToken = {json.dumps(ACTION_TOKEN)};
sessionStorage.setItem('aiopsReadToken', readToken);
function refreshActions() {{
  const project = document.getElementById('runtimeProject').value;
  const select = document.getElementById('runtimeAction');
  select.innerHTML = '';
  (actionsByProject[project] || []).forEach((action) => {{
    const option = document.createElement('option');
    option.value = action.id;
    option.textContent = action.label + ' / ' + action.risk;
    select.appendChild(option);
  }});
}}
function setProject(project) {{
  document.getElementById('runtimeProject').value = project;
  refreshActions();
}}
async function runRuntimeTool(toolName) {{
  const spec = tools[toolName];
  const result = document.getElementById('runtimeResult');
  const project = document.getElementById('runtimeProject').value;
  const body = {{tool: toolName, project}};
  const headers = {{'content-type': 'application/json'}};
  if (spec.permission === 'action_token') {{
    body.action = document.getElementById('runtimeAction').value;
    body.confirmation = window.prompt('请输入该动作的精确确认词。未匹配则不会执行。') || '';
    headers['X-AIOps-Action-Token'] = actionToken;
  }} else {{
    headers['X-AIOps-Read-Token'] = readToken;
  }}
  result.textContent = '正在运行 ' + toolName + ' ...';
  try {{
    const response = await fetch('/vibe/ops-runtime/run', {{method: 'POST', credentials: 'same-origin', headers, body: JSON.stringify(body)}});
    const data = await response.json();
    result.textContent = JSON.stringify(data, null, 2);
  }} catch (error) {{
    result.textContent = '执行失败：' + error;
  }}
}}
document.getElementById('runtimeProject').addEventListener('change', refreshActions);
document.querySelectorAll('[data-tool]').forEach((button) => button.addEventListener('click', () => runRuntimeTool(button.dataset.tool)));
document.querySelectorAll('[data-select-project]').forEach((button) => button.addEventListener('click', () => setProject(button.dataset.selectProject)));
refreshActions();
</script></body></html>"""
    return page.replace('<section class="content">', '<section class="content">' + architecture_card, 1)


def render_vibe_pilot_page():
    payload = pilot_payload()
    project_options = "".join(
        f"<option value='{html.escape(item['id'])}'>{html.escape(item['name'])}</option>"
        for item in payload["projects"]
    )
    workflow_options = "".join(
        f"<option value='{html.escape(item['id'])}'>{html.escape(item['name'])} / {html.escape(item['permission'])}</option>"
        for item in payload["workflowMatrix"]
        if item["id"] in ("readonly_inspect", "plan_design")
    )
    project_rows = "".join(
        f"<tr><td><a href='/vibe/project?id={html.escape(item['id'])}'>{html.escape(item['name'])}</a></td><td><code>{html.escape(item['path'])}</code></td><td>{html.escape(item['risk'])}</td><td>{len(item['allowlist'])}</td><td>{'已就绪' if item['context'].get('ok') else '未就绪'} / {len(item['context'].get('files', []))} 文件</td></tr>"
        for item in payload["projects"]
    )
    workflow_rows = "".join(
        f"<tr><td>{html.escape(item['name'])}</td><td>{html.escape(item['permission'])}</td><td>{html.escape('、'.join(item['allowed']))}</td><td>{html.escape('、'.join(item['blocked']))}</td></tr>"
        for item in payload["workflowMatrix"]
    )
    acceptance_items = "".join(f"<li>{html.escape(item)}</li>" for item in payload["acceptance"])
    return f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>实战试点 - AI Ops</title><style>{cockpit_page_style()}</style></head><body><main>{nav_html('pilot')}<section class="hero"><h1>真实项目实战试点</h1><p class="muted">先跑低风险只读/方案任务，验证 Harness、记忆、BRO-PDCA、工作流和权限矩阵，再逐步开放更高权限。</p><p><a class="btn" href="/vibe/">返回 Vibe</a><a class="btn" href="/vibe/pilot.json">查看 JSON</a><a class="btn" href="/vibe/tasks" data-token-link="true">任务审计</a><a class="btn" href="/vibe/todos" data-token-link="true">AI 待办</a></p></section><section class="card"><h2>一键试点</h2><p class="muted">当前只允许“只读巡检”和“方案设计”；补丁草案/部署验收仅展示权限矩阵，不开放一键执行。</p><select id="pilotProject">{project_options}</select><select id="pilotWorkflow">{workflow_options}</select><label><input id="pilotNotify" type="checkbox"> 完成后飞书通知</label><p><button id="runPilotBtn">发送试点任务给 Grok</button></p><pre id="pilotResult">等待试点任务。</pre></section><section class="card"><h2>项目级 Allowlist</h2><table><thead><tr><th>项目</th><th>只读路径</th><th>风险说明</th><th>清单文件数</th><th>上下文状态</th></tr></thead><tbody>{project_rows}</tbody></table></section><section class="card"><h2>Workflow 权限矩阵</h2><table><thead><tr><th>Workflow</th><th>权限</th><th>允许</th><th>禁止</th></tr></thead><tbody>{workflow_rows}</tbody></table></section><section class="card"><h2>验收标准</h2><ul>{acceptance_items}</ul></section></main><script>
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
        for label, key in [("主域名", "domain"), ("直连域名", "directDomain"), ("SSH 别名", "sshAlias"), ("地址", "address"), ("部署目录", "path"), ("进程管理", "processManager"), ("进程", "process"), ("服务", "services"), ("核实日期", "verifiedAt")]
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
    allowed_actions = maintenance.get("allowedActions") or production_allowed_actions(project_id)
    action_labels = maintenance.get("actionLabels") or {action: production_action_label(project_id, action) for action in allowed_actions}
    action_config = {
        action: {
            "label": action_labels.get(action) or action,
            "confirmation": production_action_confirmation(project_id, action),
        }
        for action in allowed_actions
    }
    action_buttons = []
    for action in allowed_actions:
        button_id = "inspectProductionBtn" if action == "inspect" else ("restartProductionBtn" if action == "restart" else "productionAction-" + action)
        action_buttons.append(f'<button id="{html.escape(button_id)}" data-production-action="{html.escape(action)}">{html.escape(action_labels.get(action) or action)}</button>')
    maintenance_summary = production_service_summary(maintenance_result)
    public_probe_count = len(PROJECT_LIVE_PROBES.get(project_id) or [])
    return f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{html.escape(project['name'])} - 项目工作区</title><style>{cockpit_page_style()}</style></head><body><main>{nav_html('pilot')}<section class="card"><h1>{html.escape(project['name'])} 项目工作区</h1><p class="muted">只读路径：<code>{html.escape(project['path'])}</code></p><p>{html.escape(project['risk'])}</p><p><strong>真实上下文：</strong>{'已就绪' if context.get('ok') else '未就绪'}，已注入 {len(context.get('files', []))} 个文件 / {context.get('chars', 0)} 字符，截断：{'是' if context.get('truncated') else '否'}。</p><p><a href="/vibe/pilot">返回实战试点</a> · <a href="/vibe/tasks" data-token-link="true">任务审计</a> · <a href="/vibe/todos" data-token-link="true">AI 待办</a></p></section><section class="card"><h2>每日 AI 巡检</h2><p>最近状态：<strong class="{'ok' if daily.get('ok') else 'warn'}">{html.escape(daily_status)}</strong> · 实时探测 {daily_live.get('passed', 0)}/{daily_live.get('total', 0)} · 快照 {daily_snapshot.get('ageHours', '-')} 小时</p><p class="muted">每日由 n8n 自动触发；包含公网入口探测、生产服务限权巡检、Grok 4.5 源码分析、异常待办、飞书通知和 Kuma 心跳。</p><button id="runDailyBtn">立即执行一次只读巡检</button><pre id="dailyResult">{html.escape(json.dumps(daily, ensure_ascii=False, indent=2) if daily else '等待首次执行。')}</pre></section><section class="card"><h2>生产维护通道</h2><p>通道：<strong class="{'ok' if maintenance.get('configured') else 'warn'}">{'已限权接入' if maintenance.get('configured') else '未接入'}</strong> · 服务：{html.escape(maintenance_summary)}</p><p class="muted">专用 SSH key 只能执行页面列出的固定动作；禁止任意 shell、部署、文件写入。状态变更需要动作权限、明确确认、10 分钟冷却，并在完成后自动跑 {public_probe_count} 项公网验收。</p>{''.join(action_buttons)}<pre id="productionResult">{html.escape(json.dumps(maintenance_latest, ensure_ascii=False, indent=2) if maintenance_latest else '等待首次生产巡检。')}</pre></section><section class="card"><h2>已核实生产目标</h2><table><tbody>{production_rows}</tbody></table></section><section class="card"><h2>Allowlist 文件</h2><table><tbody>{allowlist_rows}</tbody></table></section><section class="card"><h2>最近任务</h2><table><thead><tr><th>时间</th><th>模式</th><th>状态</th><th>ID</th></tr></thead><tbody>{task_rows}</tbody></table></section><section class="card"><h2>未完成待办</h2><table><thead><tr><th>时间</th><th>状态</th><th>标题</th><th>入口</th></tr></thead><tbody>{todo_rows}</tbody></table></section><section class="card"><h2>Workflow 权限矩阵</h2><table><thead><tr><th>Workflow</th><th>权限</th><th>允许</th><th>禁止</th></tr></thead><tbody>{workflow_rows}</tbody></table></section></main><script>
sessionStorage.setItem('aiopsReadToken', '{READ_TOKEN}');
const productionActions = {json.dumps(action_config, ensure_ascii=False)};
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
  const config = productionActions[action] || {{label: action, confirmation: null}};
  const isMutation = Boolean(config.confirmation);
  let confirmation = '';
  if (isMutation) {{
    confirmation = window.prompt('这是生产状态变更。请输入 ' + config.confirmation + ' 确认；系统不会部署或修改文件。') || '';
    if (confirmation !== config.confirmation) {{ result.textContent = '已取消：确认文字不匹配。'; return; }}
  }}
  result.textContent = isMutation ? '已提交“' + config.label + '”，完成后会自动验收公网 {public_probe_count} 项...' : '正在读取生产服务、探测与主机资源状态...';
  const tokenHeader = isMutation ? {{'X-AIOps-Action-Token':'{ACTION_TOKEN}'}} : {{'X-AIOps-Read-Token':'{READ_TOKEN}'}};
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
document.querySelectorAll('[data-production-action]').forEach((button) => {{
  button.addEventListener('click', () => runProductionAction(button.dataset.productionAction));
}});
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
    return f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI 运维助手 v0</title><style>{cockpit_page_style()}</style></head><body><main>
{nav_html("ai")}
<h1>AI 运维助手 v0</h1><p class="muted">只读上下文 + Grok/OMP 提示词入口。当前不执行任何运维动作。</p>
<section class="card grid"><div><div class="muted">总状态</div><h2 class="{status_class}">{status}</h2></div><div><div class="muted">备份</div><h2 class="{backup_class}">{html.escape(str((backup.get('items') or [{'statusText':'未知'}])[0].get('statusText')))}</h2><p class="muted">{backup_message}</p></div><div><div class="muted">主机</div><h2>{html.escape(context['summary']['host']['hostname'])}</h2></div><div><div class="muted">Load</div><h2>{context['summary']['host']['load1']} / {context['summary']['host']['load5']} / {context['summary']['host']['load15']}</h2></div><div><div class="muted">监控数</div><h2>{context['summary']['monitorCount']}</h2></div><div><div class="muted">最后日报</div><h2>{daily_text}</h2></div></section>
<section class="card"><h2>怎么用</h2><p>复制下方提示词，粘到本机 <code>Grok</code> 或 <code>OMP</code> 对话里，即可让 AI 基于当前真实状态做只读分析。</p><button onclick="navigator.clipboard.writeText(document.querySelector('textarea').value)">复制提示词</button><a class="btn" href="/ai/context" target="_blank">查看 JSON</a><a class="btn" href="/ai/prompt" target="_blank">纯文本 Prompt</a><a class="btn" href="/ops-health/ai" target="_blank">健康端点</a></section>
<section class="card"><h2>本机 OMP Bridge 自检</h2><p class="muted">用于确认本机一键问 Grok 的桥接服务是否在线。只访问本机 <code>127.0.0.1:18777</code>，不会把凭据发到服务器。</p><button id="checkBridgeBtn">检测 Bridge</button><span id="bridgeStatus" class="muted">尚未检测</span><pre id="bridgeDetail" style="white-space:pre-wrap;background:#020617;border:1px solid #334155;border-radius:12px;padding:14px"></pre></section>
<section class="card"><h2>站内只读问答 v0</h2><p class="muted">规则化问答，不调用模型、不执行命令。可问：当前有哪些异常？备份正常吗？磁盘空间怎么样？</p><input id="q" style="width:70%;padding:10px;border-radius:10px;border:1px solid #334155;background:#020617;color:#e5e7eb" value="当前有哪些异常？"><button onclick="fetch('/ai/ask?q='+encodeURIComponent(document.getElementById('q').value)).then(r=>r.text()).then(t=>document.getElementById('answer').textContent=t)">规则问答</button><pre id="answer" style="white-space:pre-wrap;background:#020617;border:1px solid #334155;border-radius:12px;padding:14px"></pre></section>
<section class="card"><h2>一键问 OMP / Grok</h2><p class="muted">需要本机先启动 OMP Bridge：<code>python3 /Users/rayman.chen/mycc/2-Projects/ai-ops-cockpit/local-omp-bridge/server.py</code>。Bridge 只监听 127.0.0.1，不把 OMP/Grok 凭据放到服务器。</p><input id="grokq" style="width:70%;padding:10px;border-radius:10px;border:1px solid #334155;background:#020617;color:#e5e7eb" value="请分析当前运维状态，并告诉我最应该关注哪三项。"><button id="askGrokBtn">问 OMP/Grok</button><pre id="grokAnswer" style="white-space:pre-wrap;background:#020617;border:1px solid #334155;border-radius:12px;padding:14px"></pre></section>
<section class="card"><h2>推荐本机命令</h2><p class="muted">为减少 Grok 扫描 mycc 大仓库和 MCP 配置噪音，建议先保存 Prompt 到 /tmp，再从 /tmp 运行。</p><pre style="white-space:pre-wrap;background:#020617;border:1px solid #334155;border-radius:12px;padding:14px">curl -u chuan:你的外层密码 https://ops.hahaxiong.top/ai/prompt -o /tmp/ai-ops-prompt.txt
cd /tmp && grok -p "$(cat /tmp/ai-ops-prompt.txt)" --no-subagents --disable-web-search --max-turns 1
cd /tmp && omp --model {html.escape(AI_OPS_OMP_MODEL)} -p "$(cat /tmp/ai-ops-prompt.txt)"</pre></section>
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
    return f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI 运维驾驶舱</title><style>{cockpit_page_style()}</style></head><body><main>{nav_html("home")}<section class="hero"><h1>AI 运维驾驶舱</h1><p class="muted">一屏看状态，直接问 AI。当前 AI 只读分析，不会执行重启、删除、升级或改配置。</p><div class="grid"><div><div class="muted">总状态</div><h2 class="{status_class}">{html.escape(data['statusText'])}</h2></div><div><div class="muted">备份</div><h2>{html.escape(str(backup.get('message') or '未知'))}</h2></div><div><div class="muted">磁盘</div><h2>{metrics.get('maxDiskUsedPercent')}%</h2></div><div><div class="muted">容器/Kuma</div><h2>异常 {metrics.get('unhealthyCount')} / DOWN {metrics.get('downCount')}</h2></div></div></section><section class="card"><h2>问 AI 运维助手</h2><p class="muted">直接问当前风险、备份、磁盘、容器。调用本机 OMP/Grok Bridge。</p><input id="homeQuestion" value="{html.escape(default_question)}"><p><button id="homeAskBtn">问 AI</button><button id="homeCheckBridgeBtn">检测 Bridge</button><span id="homeBridgeStatus" class="muted">尚未检测</span></p><pre id="homeAnswer">等待提问。提示：页面状态卡会快速显示；AI 回答需要调用 Grok，通常 30-90 秒。</pre></section><section class="grid"><a class="card" href="/ops-dashboard/"><h2>AI Ops 总览</h2><p class="muted">更完整状态卡和 JSON</p></a><a class="card" href="/vibe/ops-runtime"><h2>Ops Tool Runtime</h2><p class="muted">Grok 可调用的白名单工具、证据包与确认队列</p></a><a class="card" href="/vibe/"><h2>Vibe Coding 终端</h2><p class="muted">网页终端、项目工作区、远程开发</p></a><a class="card" href="/ops-app/kuma"><h2>Uptime Kuma</h2><p class="muted">监控红绿灯</p></a><a class="card" href="/ops-app/n8n"><h2>n8n 自动化</h2><p class="muted">日报与工作流</p></a><a class="card" href="/ops-app/netdata"><h2>Netdata</h2><p class="muted">资源趋势</p></a><a class="card" href="/ops-app/dockge"><h2>Dockge</h2><p class="muted">服务管理</p></a></section><section class="card"><h2>最后日报</h2><p>{html.escape(str(daily.get('sentAt') or '尚未发送'))}</p><p class="muted">{html.escape(cache_text)}</p></section><textarea id="homePrompt" style="display:none">{html.escape(ai_prompt())}</textarea><script>
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
    return f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI Ops 总览</title><style>{cockpit_page_style()}</style></head><body><main>{nav_html("dashboard")}<h1>AI Ops 总览</h1><p class="muted">低代码总览页：正常/异常、备份、磁盘、容器、日报。</p><section class="grid"><div class="card"><div class="muted">总状态</div><h2 class="{status_class}">{html.escape(data['statusText'])}</h2></div><div class="card"><div class="muted">备份状态</div><h2>{html.escape(str(backup.get('message') or '未知'))}</h2></div><div class="card"><div class="muted">磁盘最高使用率</div><h2>{metrics.get('maxDiskUsedPercent')}%</h2></div><div class="card"><div class="muted">容器</div><h2>{metrics.get('containerCount')} 个 / 异常 {metrics.get('unhealthyCount')}</h2></div><div class="card"><div class="muted">Kuma</div><h2>{metrics.get('monitorCount')} 个 / DOWN {metrics.get('downCount')}</h2></div><div class="card"><div class="muted">最后日报</div><h2>{html.escape(str(daily.get('sentAt') or '尚未发送'))}</h2></div></section><p class="muted">{html.escape(cache_text)}</p><p><a href="/ai/">进入 AI 运维助手</a> · <a href="/ops-dashboard.json">查看 JSON</a></p></main></body></html>"""

def workspace_payload():
    projects = [
        {"name": "mycc", "path": "/workspace/readonly/mycc", "purpose": "本机 AI 协作中枢文件级只读快照", "start": "请使用 aiops_ls(project=mycc, path=.)"},
        {"name": "个人站", "path": "/workspace/readonly/chenchuan-site", "purpose": "个人站文件级只读快照", "start": "请使用 aiops_read(project=chenchuan-site, path=README.md)"},
        {"name": "个人 CPA", "path": "/workspace/readonly/cpa-smart-router", "purpose": "CPA 路由器文件级只读快照", "start": "请使用 aiops_read(project=cpa-smart-router, path=README.md)"},
        {"name": "MyJavis", "path": "/workspace/readonly/MyJavis", "purpose": "MyJavis 文件级只读快照", "start": "请使用 aiops_read(project=MyJavis, path=README.md)"},
        {"name": "Voice Agent", "path": "/workspace/readonly/realtime-voice-agent", "purpose": "实时语音 Agent 文件级只读快照", "start": "请使用 aiops_read(project=realtime-voice-agent, path=README.md)"},
        {"name": "P003", "path": "/workspace/readonly/P003GameDemo20260513", "purpose": "P003 实验项目文件级只读快照", "start": "请使用 aiops_ls(project=P003GameDemo20260513, path=.)"},
    ]
    servers = [
        {"name": "RackNerd", "target": "当前 AI Ops 宿主", "command": "请在资产矩阵查看实时状态"},
        {"name": "已接入生产节点", "target": "专用限权维护通道", "command": "请在项目页使用受控巡检/动作按钮"},
    ]
    commands = [
        {"label": "列只读文件", "command": "让 OMP 使用 aiops_ls，并明确 project 与相对 path"},
        {"label": "读取文件", "command": "让 OMP 使用 aiops_read；禁止绝对路径、..、软链接和敏感路径"},
        {"label": "搜索源码", "command": "让 OMP 使用 aiops_grep 或 aiops_find；结果自动限长并审计"},
        {"label": "生产动作", "command": "返回网页项目页，使用带确认词、冷却和验收的受控动作"},
    ]
    guardrails = [
        "Brain/Terminal 不挂载 Docker Socket、生产 SSH、真实项目目录或远端 stacks。",
        "Tool Runner 不持有模型密钥、Webhook、Kuma Push URL、SSH 或 Docker Socket。",
        "readonly_safe 仅允许 aiops_read、aiops_grep、aiops_find、aiops_ls，未知工具和未知项目默认拒绝。",
        "终端会话记录在 /var/log/ops-terminal/session-*.log，用于复盘。",
        f"OMP 已安装，模型固定为 {AI_OPS_OMP_MODEL_LABEL}；模型密钥仅存在 Brain 边界。",
        "不要在终端里粘贴或保存密码、Webhook、Push URL token、API key。",
        "需要生产变更时先说明目标、备份点、回滚方式和验收命令，再回网页受控动作入口确认。",
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
        omp_command = "omp --model " + AI_OPS_OMP_MODEL + " -p " + json.dumps(prompt_text, ensure_ascii=False)
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
        f"""<div class="card"><h2>{html.escape(item['label'])}</h2><p class="muted">{html.escape(item['prompt'])}</p><button data-copy="{html.escape('omp --model ' + AI_OPS_OMP_MODEL + ' -p ' + json.dumps(item['prompt'], ensure_ascii=False))}">复制 OMP 命令</button></div>"""
        for item in payload["templates"]
    )
    session_rows = "".join(
        f"""<tr><td>{html.escape(item['name'])}</td><td>{item['sizeBytes']}</td><td>{html.escape(item['updatedAt'])}</td><td><details><summary>预览</summary><pre>{html.escape(item['preview'])}</pre></details></td></tr>"""
        for item in status["sessions"]
    ) or "<tr><td colspan=4>暂无日志</td></tr>"
    guardrail_items = "".join(f"<li>{html.escape(item)}</li>" for item in payload["guardrails"])
    dangerous = "、".join(DANGEROUS_PATTERNS)
    status_class = "ok" if status["ok"] else "warn"
    return f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vibe Coding - AI Ops</title><style>{cockpit_page_style()}</style></head><body><main>{nav_html('vibe')}<section class="hero"><h1>Vibe Coding 工作台</h1><p class="muted">打开终端会自动进入带 Harness 的 {html.escape(AI_OPS_OMP_MODEL_LABEL)} 版 OMP；Brain 与生产 Hands 已隔离，源码核验只走 readonly_safe 策略门。</p><p><span class="pill {status_class}">终端/OMP：{html.escape('正常' if status['ok'] else '需要关注')}</span><span class="pill">Harness：AI Ops Harness v1</span><span class="pill">readonly_safe</span><span class="pill">日志 {len(status['sessions'])} 条</span></p><p><a class="btn" href="/terminal/" target="_blank">新窗口打开终端</a><button id="restartTerminalBtn">重启终端容器</button><a class="btn" href="/vibe/ops-runtime">Tool Runtime</a><a class="btn" href="/vibe/pilot">实战试点</a><a class="btn" href="/vibe/harness.json">Harness JSON</a><a class="btn" href="/vibe/harness-prompt">Harness Prompt</a><a class="btn" href="/vibe/tasks" data-token-link="true">任务审计</a><a class="btn" href="/vibe/todos" data-token-link="true">AI 待办</a><a class="btn" href="/vibe/assets">资产矩阵</a><button id="refreshReadonlyBtn">刷新只读快照</button><button id="runN8nInspectBtn">触发手动巡检</button></p><pre id="actionResult">等待操作。</pre><p class="muted" id="readonlyStatus">只读快照：检查中...</p></section><section class="card"><h2>实战前护栏</h2><p class="muted">先从低风险项目开始：选择项目、选择只读/方案 workflow、发送给 AI 模型，结果进入任务审计并可转待办。</p><p><a class="btn" href="/vibe/pilot">进入真实项目实战试点</a></p></section><section class="card"><h2>连续对话</h2><p class="muted">保留本页上下文继续问 AI 模型；刷新页面会清空上下文。</p><div id="chatHistory" class="chat"><p class="muted">暂无对话。</p></div></section><section class="card"><h2>发任务给 Grok</h2><p class="muted">无需进入终端，选择工作模式后直接发送任务。模型只能使用 aiops_read/grep/find/ls 核验已登记只读快照，不能写入、SSH、Docker、部署或提交。</p><select id="taskMode"><option value="readonly_inspect">只读巡检</option><option value="plan_design">方案设计</option><option value="patch_draft">补丁草案</option><option value="deploy_verify">部署验收</option></select><textarea id="taskQuestion" rows="4" placeholder="例如：请只读检查 AI Ops 当前状态，并列出风险和下一步。">请只读检查当前 AI Ops 驾驶舱状态，按异常、风险、建议、验收命令输出。</textarea><p><label><input id="notifyFeishu" type="checkbox"> 完成后飞书通知</label></p><p><button id="sendTaskBtn">发送给 AI 模型</button><button id="clearTaskBtn" type="button">清空重写</button><button id="clearChatBtn" type="button">清空对话</button><a class="btn" href="/vibe/tasks" data-token-link="true">查看任务审计</a></p><p class="muted" id="taskStatus">状态：待发送</p><pre id="taskResult">等待任务。</pre></section><section class="card"><h2>内嵌终端</h2><p class="muted">为保护 2GB 运维主机，终端默认不自动启动。点击后才加载 Harness 并启动 <code>omp --model {html.escape(AI_OPS_OMP_MODEL)}</code>；关闭或离开页面会结束本次会话。终端是 Brain 沙箱，不挂载真实项目、Docker Socket 或生产 SSH。</p><p><button id="startTerminalBtn" type="button">启动内嵌终端</button><span class="muted" id="terminalLaunchStatus">尚未启动</span></p><div class="terminal"><iframe id="terminalFrame" src="about:blank" data-src="/terminal/" title="Vibe Terminal" loading="lazy"></iframe></div></section><section><h2>工作模式</h2><div class="grid">{workflow_cards}</div></section><section><h2>项目入口</h2><div class="grid">{project_cards}</div></section><section class="card"><h2>服务器入口</h2><table><thead><tr><th>服务器</th><th>说明</th><th>操作方式</th><th>复制</th></tr></thead><tbody>{server_rows}</tbody></table></section><section class="card"><h2>安全工具</h2><table><thead><tr><th>用途</th><th>方式</th><th>操作</th></tr></thead><tbody>{command_rows}</tbody></table></section><section><h2>AI 任务模板</h2><div class="grid">{template_cards}</div></section><section class="card"><h2>审计日志</h2><p class="muted">最近终端日志，只展示尾部预览。完整日志在远端 <code>/opt/ai-ops-cockpit/terminal/logs/</code>。</p><table><thead><tr><th>文件</th><th>大小</th><th>更新时间</th><th>预览</th></tr></thead><tbody>{session_rows}</tbody></table></section><section class="card"><h2>护栏</h2><p class="muted">高危关键词：{html.escape(dangerous)}</p><ul>{guardrail_items}</ul></section></main><script>
document.querySelectorAll('[data-copy]').forEach((button) => {{
  button.addEventListener('click', async () => {{
    await navigator.clipboard.writeText(button.dataset.copy);
    const oldText = button.textContent;
    button.textContent = '已复制';
    setTimeout(() => button.textContent = oldText, 1200);
  }});
}});
const startTerminalBtn = document.getElementById('startTerminalBtn');
const terminalFrame = document.getElementById('terminalFrame');
const terminalLaunchStatus = document.getElementById('terminalLaunchStatus');
startTerminalBtn.addEventListener('click', () => {{
  if (terminalFrame.dataset.started === 'true') return;
  terminalFrame.dataset.started = 'true';
  terminalFrame.src = terminalFrame.dataset.src;
  startTerminalBtn.disabled = true;
  startTerminalBtn.textContent = '终端已启动';
  terminalLaunchStatus.textContent = '正在加载，只允许 1 个网页终端会话';
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
function appendChat(role, text, kind) {{
  const history = document.getElementById('chatHistory');
  if (history.querySelector('.muted')) history.innerHTML = '';
  const item = document.createElement('div');
  item.setAttribute('data-chat-line', 'true');
  item.className = kind || '';
  item.innerHTML = `<p><strong>${{role}}</strong></p><pre>${{String(text || '').replace(/[&<>]/g, ch => ({{'&':'&amp;','<':'&lt;','>':'&gt;'}}[ch]))}}</pre>`;
  history.appendChild(item);
}}
const sendTaskBtn = document.getElementById('sendTaskBtn');
const abortTaskBtn = document.createElement('button');
abortTaskBtn.id = 'abortTaskBtn';
abortTaskBtn.type = 'button';
abortTaskBtn.textContent = '终止当前任务';
abortTaskBtn.disabled = true;
sendTaskBtn.insertAdjacentElement('afterend', abortTaskBtn);
let activeTaskId = sessionStorage.getItem('aiopsActiveTaskId') || '';
let activeTaskRevision = Number(sessionStorage.getItem('aiopsActiveTaskRevision') || 0);
let taskPollTimer = null;
let taskPollBackoff = 2000;
function taskStatusLabel(task) {{
  return ({{queued:'排队中',running:'运行中',aborting:'终止中',completed:'完成',failed:'失败',aborted:'已终止'}})[task.status] || task.status || '未知';
}}
function rememberActiveTask(task) {{
  activeTaskId = task.id;
  activeTaskRevision = Number(task.revision || 0);
  sessionStorage.setItem('aiopsActiveTaskId', activeTaskId);
  sessionStorage.setItem('aiopsActiveTaskRevision', String(activeTaskRevision));
  sendTaskBtn.disabled = !task.terminal;
  abortTaskBtn.disabled = Boolean(task.terminal);
}}
function clearActiveTask() {{
  activeTaskId = '';
  activeTaskRevision = 0;
  sessionStorage.removeItem('aiopsActiveTaskId');
  sessionStorage.removeItem('aiopsActiveTaskRevision');
  sessionStorage.removeItem('aiopsPendingRequestId');
  sendTaskBtn.disabled = false;
  abortTaskBtn.disabled = true;
}}
function renderTaskSnapshot(task) {{
  if (!task || !task.id) return;
  const revision = Number(task.revision || 0);
  if (task.id === activeTaskId && revision <= activeTaskRevision) return;
  rememberActiveTask(task);
  document.getElementById('taskStatus').textContent = `状态：${{taskStatusLabel(task)}} · 任务 ${{task.id}} · revision ${{revision}}${{task.error ? ' · ' + task.error : ''}}`;
  document.getElementById('taskResult').textContent = task.terminal ? JSON.stringify(task, null, 2) : `任务已进入权威状态存储。\nID：${{task.id}}\n状态：${{taskStatusLabel(task)}}\nrevision：${{revision}}\n页面刷新或网络闪断后会自动恢复。`;
  if (task.terminal) {{
    const renderedTaskId = sessionStorage.getItem('aiopsRenderedTaskId');
    if (renderedTaskId !== task.id) {{
      appendChat('川哥', task.question || '', 'user');
      appendChat('{html.escape(AI_OPS_OMP_MODEL_LABEL)}', task.answer || task.error || '任务无输出', 'assistant');
      sessionStorage.setItem('aiopsRenderedTaskId', task.id);
    }}
    clearActiveTask();
    if (taskPollTimer) clearTimeout(taskPollTimer);
    return;
  }}
  scheduleTaskPoll(2000);
}}
function scheduleTaskPoll(delay) {{
  if (taskPollTimer) clearTimeout(taskPollTimer);
  taskPollTimer = setTimeout(pollActiveTask, delay);
}}
async function pollActiveTask() {{
  if (!activeTaskId) return;
  try {{
    const response = await fetch(`/vibe/task?id=${{encodeURIComponent(activeTaskId)}}`, {{ credentials: 'same-origin', headers: {{ 'X-AIOps-Read-Token': '{READ_TOKEN}' }} }});
    const data = await response.json();
    if (!response.ok || !data.ok || !data.task) throw new Error(data.error || `HTTP ${{response.status}}`);
    taskPollBackoff = 2000;
    renderTaskSnapshot(data.task);
    if (!data.task.terminal) scheduleTaskPoll(taskPollBackoff);
  }} catch (error) {{
    document.getElementById('taskStatus').textContent = `状态：连接中断，${{Math.round(taskPollBackoff / 1000)}} 秒后重连 · ${{error}}`;
    taskPollBackoff = Math.min(15000, taskPollBackoff * 2);
    scheduleTaskPoll(taskPollBackoff);
  }}
}}
async function submitTaskRequest(body, attempt=0) {{
  try {{
    const response = await fetch('/vibe/task/run', {{ method: 'POST', credentials: 'same-origin', headers: {{ 'content-type': 'application/json', 'X-AIOps-Read-Token': '{READ_TOKEN}' }}, body: JSON.stringify(body) }});
    const data = await response.json();
    if (!data.ok) {{
      if (data.activeTask) renderTaskSnapshot(data.activeTask);
      else {{
        document.getElementById('taskResult').textContent = JSON.stringify(data, null, 2);
        document.getElementById('taskStatus').textContent = '状态：未启动 · ' + (data.error || '未知错误');
        sendTaskBtn.disabled = false;
        sessionStorage.removeItem('aiopsPendingRequestId');
      }}
      return;
    }}
    sessionStorage.removeItem('aiopsPendingRequestId');
    activeTaskRevision = 0;
    renderTaskSnapshot(data.task);
  }} catch (error) {{
    if (attempt < 2) {{
      document.getElementById('taskStatus').textContent = `状态：发送响应中断，正在按相同请求 ID 重试（${{attempt + 1}}/2）`;
      await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
      return submitTaskRequest(body, attempt + 1);
    }}
    document.getElementById('taskResult').textContent = String(error);
    document.getElementById('taskStatus').textContent = '状态：发送失败，可再次点击；服务端会按请求 ID 去重。';
    sendTaskBtn.disabled = false;
  }}
}}
sendTaskBtn.addEventListener('click', async () => {{
  if (activeTaskId) {{ pollActiveTask(); return; }}
  const input = document.getElementById('taskQuestion');
  const question = input.value.trim() || '请只读检查当前 AI Ops 驾驶舱状态，按异常、风险、建议、验收命令输出。';
  input.value = question;
  const conversation = Array.from(document.querySelectorAll('[data-chat-line]')).map(node => node.textContent).join('\\n');
  const requestId = sessionStorage.getItem('aiopsPendingRequestId') || `web-${{Date.now()}}-${{Math.random().toString(16).slice(2, 10)}}`;
  sessionStorage.setItem('aiopsPendingRequestId', requestId);
  sendTaskBtn.disabled = true;
  document.getElementById('taskResult').textContent = '正在创建权威任务快照...';
  document.getElementById('taskStatus').textContent = '状态：提交中';
  await submitTaskRequest({{ clientRequestId: requestId, mode: document.getElementById('taskMode').value, question, conversation, notify: document.getElementById('notifyFeishu').checked }});
}});
abortTaskBtn.addEventListener('click', async () => {{
  if (!activeTaskId) return;
  abortTaskBtn.disabled = true;
  const response = await fetch('/vibe/task/abort', {{ method: 'POST', credentials: 'same-origin', headers: {{ 'content-type': 'application/json', 'X-AIOps-Read-Token': '{READ_TOKEN}' }}, body: JSON.stringify({{ taskId: activeTaskId, expectedRevision: activeTaskRevision }}) }});
  const data = await response.json();
  if (data.task) {{
    activeTaskRevision = Math.max(0, Number(data.task.revision || 0) - 1);
    renderTaskSnapshot(data.task);
  }} else {{
    document.getElementById('taskStatus').textContent = '状态：终止失败 · ' + (data.error || '未知错误');
    abortTaskBtn.disabled = false;
  }}
}});
if (activeTaskId) {{
  sendTaskBtn.disabled = true;
  abortTaskBtn.disabled = false;
  activeTaskRevision = 0;
  pollActiveTask();
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
    return f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{html.escape(config['title'])} - AI Ops</title><style>{cockpit_frame_style()}</style></head><body><div class="topbar">{nav_html(config['active'])}<span class="hint">如果子应用显示异常，可用浏览器返回或从导航重新进入。</span></div><iframe src="{html.escape(config['src'])}" title="{html.escape(config['title'])}"></iframe></body></html>"""



class Handler(BaseHTTPRequestHandler):
    def _send_json(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_text(self, code, text, content_type="text/plain; charset=utf-8"):
        if isinstance(text, str) and content_type.startswith("text/html"):
            text = text.replace("Grok 4.5", AI_OPS_OMP_MODEL_LABEL)
            replacements = (
                ("Grok 版 OMP", f"{AI_OPS_OMP_MODEL_LABEL} 版 OMP"),
                ("Grok 任务审计", f"{AI_OPS_OMP_MODEL_LABEL} 任务审计"),
                ("Grok 任务", f"{AI_OPS_OMP_MODEL_LABEL} 任务"),
                ("发送给 Grok", "发送给 AI 模型"),
                ("正在发送给 Grok", f"正在发送给 {AI_OPS_OMP_MODEL_LABEL}"),
                ("继续问 Grok", "继续问 AI 模型"),
                ("Grok 输出", "AI 模型输出"),
                ("OMP / Grok", f"OMP / {AI_OPS_OMP_MODEL_LABEL}"),
                ("OMP/Grok", f"OMP/{AI_OPS_OMP_MODEL_LABEL}"),
                ("问 OMP/Grok", f"问 OMP/{AI_OPS_OMP_MODEL_LABEL}"),
                ("appendChat('Grok'", f"appendChat('{AI_OPS_OMP_MODEL_LABEL}'"),
            )
            for old, new in replacements:
                text = text.replace(old, new)
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
            elif path == "/vibe/ops-runtime.json":
                if not self._has_read_token():
                    self._send_json(403, {"ok": False, "error": "read token required"})
                    return
                self._send_json(200, ops_runtime_payload())
            elif path == "/vibe/ops-runtime/execution":
                if not self._has_read_token():
                    self._send_json(403, {"ok": False, "error": "read token required"})
                    return
                execution_id = parse_qs(urlparse(self.path).query).get("id", [""])[0]
                execution = load_ops_runtime_execution(execution_id)
                self._send_json(200 if execution else 404, execution or {"ok": False, "error": "execution not found"})
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
            elif path == "/vibe/self-monitor.json":
                if not self._has_read_token():
                    self._send_json(403, {"ok": False, "error": "read token required"})
                    return
                self._send_json(200, {"ok": True, "report": build_self_monitor_report(), "state": load_json_file(SELF_MONITOR_STATE_FILE, {})})
            elif path in ("/vibe/assets", "/vibe/assets/"):
                self._send_text(200, render_assets_page(), "text/html; charset=utf-8")
            elif path in ("/vibe/ops-runtime", "/vibe/ops-runtime/"):
                self._send_text(200, render_ops_runtime_page(), "text/html; charset=utf-8")
            elif path == "/vibe/task":
                if not self._has_read_token():
                    self._send_json(403, {"ok": False, "error": "read token required"})
                    return
                task_id = parse_qs(urlparse(self.path).query).get("id", [""])[0]
                task = TASK_STORE.load(task_id)
                self._send_json(200 if task else 404, {"ok": True, "task": task} if task else {"ok": False, "error": "task not found"})
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
                self._send_json(200, start_vibe_task(payload))
            elif path == "/vibe/task/abort":
                if not self._has_read_token():
                    self._send_json(403, {"ok": False, "error": "read token required"})
                    return
                payload = self._read_json_body()
                expected_revision = payload.get("expectedRevision")
                if expected_revision is not None:
                    try:
                        expected_revision = int(expected_revision)
                    except (TypeError, ValueError):
                        self._send_json(400, {"ok": False, "error": "invalid revision"})
                        return
                self._send_json(200, abort_vibe_task(payload.get("taskId"), expected_revision))
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
            elif path == "/vibe/ops-runtime/run":
                payload = self._read_json_body()
                tool_name = (payload.get("tool") or "").strip()
                if ops_runtime_tool_requires_action(tool_name):
                    if not self._has_action_token():
                        self._send_json(403, {"ok": False, "error": "action token required"})
                        return
                else:
                    if not self._has_read_token():
                        self._send_json(403, {"ok": False, "error": "read token required"})
                        return
                self._send_json(200, run_ops_runtime_tool(payload))
            elif path == "/vibe/project/daily/run":
                if not self._has_read_token():
                    self._send_json(403, {"ok": False, "error": "read token required"})
                    return
                payload = self._read_json_body()
                payload.pop("simulateFailure", None)
                self._send_json(200, start_project_daily_job(payload))
            elif path == "/vibe/self-monitor/run":
                if not self._has_read_token():
                    self._send_json(403, {"ok": False, "error": "read token required"})
                    return
                self._read_json_body()
                self._send_json(200, run_self_monitor(notify=True))
            elif path == "/vibe/project/daily/test":
                if not self._has_action_token():
                    self._send_json(403, {"ok": False, "error": "action token required"})
                    return
                payload = self._read_json_body()
                self._send_json(200, start_project_daily_job(payload))
            elif path == "/vibe/project/production/action":
                payload = self._read_json_body()
                action = (payload.get("action") or "inspect").strip()
                project_id = (payload.get("project") or "").strip()
                if action not in production_allowed_actions(project_id):
                    self._send_json(400, {"ok": False, "error": "production action not allowed"})
                    return
                if production_action_requires_confirmation(project_id, action):
                    if not self._has_action_token():
                        self._send_json(403, {"ok": False, "error": "action token required"})
                        return
                elif not self._has_read_token():
                    self._send_json(403, {"ok": False, "error": "read token required"})
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
    TASK_STORE.reconcile_interrupted()
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
