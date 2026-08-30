#!/usr/bin/env python3
"""home-studio 上的 H 平台每日只读巡检。"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import pathlib
import ssl
import subprocess
import sys
import tempfile
import urllib.request


STATE_DIR = pathlib.Path.home() / ".local/state/h-platform-daily-ops"
LATEST = STATE_DIR / "latest.json"
HISTORY = STATE_DIR / "history.jsonl"
CONTROL_URL = "https://ai.kidshub.cn/healthz"
SSH_HOST = "dev198"

REMOTE_SCRIPT = r'''#!/usr/bin/env bash
set -u
export PATH=/home/chuan/.local/node/bin:$PATH
cd /home/chuan/feishu-grok-bridge || exit 20

export HOPS_BRIDGE="$(systemctl --user is-active feishu-grok-bridge 2>/dev/null || true)"
export HOPS_RUNNER="$(systemctl --user is-active feishu-grok-runner-worker 2>/dev/null || true)"
export HOPS_XRAY="$(systemctl --user is-active xray 2>/dev/null || true)"
export HOPS_PARITY_TIMER="$(systemctl --user is-active h-tenant-parity.timer 2>/dev/null || true)"
export HOPS_SQLITE_TIMER="$(systemctl --user is-active feishu-grok-sqlite-maintenance.timer 2>/dev/null || true)"
export HOPS_REFRESH_RESULT="$(systemctl --user show grok-xai-refresh.service -p Result --value 2>/dev/null || true)"
export HOPS_REFRESH_STATUS="$(systemctl --user show grok-xai-refresh.service -p ExecMainStatus --value 2>/dev/null || true)"
export HOPS_DISK_USED="$(df -P /srv/h-platform | awk 'NR==2 {gsub(/%/,"",$5); print $5}')"
export HOPS_JOURNAL_ERRORS="$(journalctl --user -u feishu-grok-bridge -u feishu-grok-runner-worker --since '24 hours ago' -p err --no-pager 2>/dev/null | grep -v '^-- No entries --$' | wc -l)"
export HOPS_FAILED_UNITS="$(systemctl --user --failed --no-legend 2>/dev/null | awk '{print $1}' | grep -E '^(feishu|grok|h-|ai-memory|xray|ollama)' | paste -sd, - || true)"

t_health="$(mktemp)"
t_parity="$(mktemp)"
t_memory="$(mktemp)"
trap 'rm -f "$t_health" "$t_parity" "$t_memory"' EXIT

python3 - <<'PY' >"$t_health"
import json, urllib.request
with urllib.request.urlopen("http://127.0.0.1:18765/healthz", timeout=15) as response:
    data = json.load(response)
apps = data.get("apps") or {}
values = list(apps.values())
print(json.dumps({
    "ok": data.get("ok") is True,
    "apps": len(apps),
    "connected": sum(app.get("connected") is True for app in values),
    "errors": sum(bool(app.get("lastError")) for app in values),
    "contracts": sorted({str(app.get("behaviorContractVersion")) for app in values}),
    "topContract": data.get("behaviorContractVersion"),
    "outboxPending": int((data.get("deliveryOutbox") or {}).get("pending") or 0),
    "outboxRetrying": int((data.get("deliveryOutbox") or {}).get("retrying") or 0),
    "queueDepth": int(data.get("queueDepthTotal") or 0),
    "runnerConnected": (data.get("runnerWorker") or {}).get("connected") is True,
    "runnerApps": int((data.get("runnerWorker") or {}).get("apps") or 0),
    "rpcOrphaned": int((data.get("runnerRpc") or {}).get("orphaned") or 0),
    "durableEnabled": (data.get("durableStore") or {}).get("enabled") is True,
    "deployCommit": str((data.get("deploy") or {}).get("commit") or "")[:12],
    "deployDirty": (data.get("deploy") or {}).get("dirty"),
}, separators=(",", ":")))
PY
health_rc=$?

set -a
. ./.env
set +a
export NODE_NO_WARNINGS=1
set +e
node ops/tenant-parity-audit.mjs --json >"$t_parity" 2>/dev/null
parity_rc=$?
node ops/memory-health-audit.mjs --json >"$t_memory" 2>/dev/null
memory_rc=$?
set -e

python3 - "$t_health" "$t_parity" "$t_memory" "$health_rc" "$parity_rc" "$memory_rc" <<'PY'
import json, os, sys

health_path, parity_path, memory_path, health_rc, parity_rc, memory_rc = sys.argv[1:]

def load(path):
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except Exception:
        return None

health = load(health_path)
parity = load(parity_path)
memory = load(memory_path)
platform_lag = None
user_lag = None
parity_users = None
if isinstance(parity, dict):
    platform_lag = len(parity.get("platformLags") or [])
    users = parity.get("users") or []
    parity_users = len(users)
    user_lag = sum(bool(user.get("lags")) for user in users)

result = {
    "host": "chuan-HP",
    "services": {
        "bridge": os.environ.get("HOPS_BRIDGE", ""),
        "runner": os.environ.get("HOPS_RUNNER", ""),
        "xray": os.environ.get("HOPS_XRAY", ""),
    },
    "timers": {
        "tenantParity": os.environ.get("HOPS_PARITY_TIMER", ""),
        "sqliteMaintenance": os.environ.get("HOPS_SQLITE_TIMER", ""),
    },
    "refresh": {
        "result": os.environ.get("HOPS_REFRESH_RESULT", ""),
        "status": os.environ.get("HOPS_REFRESH_STATUS", ""),
    },
    "diskUsedPercent": int(os.environ.get("HOPS_DISK_USED") or 0),
    "journalErrorLines24h": int(os.environ.get("HOPS_JOURNAL_ERRORS") or 0),
    "failedPlatformUnits": [x for x in os.environ.get("HOPS_FAILED_UNITS", "").split(",") if x],
    "healthRc": int(health_rc),
    "health": health,
    "tenantParity": {
        "rc": int(parity_rc),
        "users": parity_users,
        "userLag": user_lag,
        "platformLag": platform_lag,
    },
    "memory": {
        "rc": int(memory_rc),
        "total": memory.get("total") if isinstance(memory, dict) else None,
        "checked": memory.get("checked") if isinstance(memory, dict) else None,
        "bad": memory.get("bad") if isinstance(memory, dict) else None,
    },
}
print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
PY
'''


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def parse_time(value: object) -> dt.datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def fetch_control() -> dict:
    request = urllib.request.Request(CONTROL_URL, headers={"User-Agent": "home-studio-h-ops/1"})
    context = ssl.create_default_context()
    with urllib.request.urlopen(request, timeout=20, context=context) as response:
        if response.status != 200:
            raise RuntimeError(f"HTTP {response.status}")
        return json.load(response)


def fetch_execution() -> dict:
    command = [
        "ssh",
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=10",
        "-o", "ServerAliveInterval=15",
        "-o", "ServerAliveCountMax=2",
        SSH_HOST,
        "bash", "-s",
    ]
    completed = subprocess.run(
        command,
        input=REMOTE_SCRIPT,
        text=True,
        capture_output=True,
        timeout=180,
        check=False,
    )
    if completed.returncode != 0:
        tail = completed.stderr.strip().splitlines()[-1:] or [f"exit {completed.returncode}"]
        raise RuntimeError(tail[0][:240])
    lines = [line for line in completed.stdout.splitlines() if line.strip()]
    if not lines:
        raise RuntimeError("远端没有返回巡检结果")
    return json.loads(lines[-1])


def add_issue(issues: list[dict], level: str, code: str, message: str) -> None:
    issues.append({"level": level, "code": code, "message": message})


def evaluate(control: dict | None, execution: dict | None, errors: list[str]) -> list[dict]:
    issues: list[dict] = []
    for message in errors:
        add_issue(issues, "critical", "probe_error", message)

    if control is not None:
        if control.get("ok") is not True:
            add_issue(issues, "critical", "control_not_ok", "控制面 healthz 未通过")
        token = control.get("tokenManager") or {}
        sweep = token.get("lastSweep") or {}
        if int(sweep.get("errors") or 0) or int(sweep.get("revoked") or 0):
            add_issue(issues, "critical", "token_sweep", "订阅凭据 sweep 存在错误或撤销")
        last_sweep = parse_time(token.get("lastSweepAt"))
        if last_sweep is None or utc_now() - last_sweep > dt.timedelta(minutes=35):
            add_issue(issues, "critical", "token_sweep_stale", "控制面 token sweep 超过 35 分钟未更新")
        tunnel = control.get("tunnel") or {}
        if tunnel.get("ok") is not True or tunnel.get("down") is True:
            add_issue(issues, "critical", "control_tunnel", "控制面到执行面的隧道异常")
        release = control.get("release") or {}
        release_state = release.get("state")
        release_mismatches = int(release.get("mismatchCount") or 0)
        if release_state not in (None, "trusted", "in_sync") or release_mismatches:
            add_issue(
                issues,
                "warning",
                "control_release_drift",
                f"控制面发布态 {release_state}，差异 {release_mismatches} 项",
            )

    if execution is not None:
        services = execution.get("services") or {}
        for name in ("bridge", "runner", "xray"):
            if services.get(name) != "active":
                add_issue(issues, "critical", f"service_{name}", f"dev198 {name}={services.get(name) or 'unknown'}")
        timers = execution.get("timers") or {}
        for name, value in timers.items():
            if value != "active":
                add_issue(issues, "warning", f"timer_{name}", f"dev198 定时器 {name}={value or 'unknown'}")

        health = execution.get("health")
        if not isinstance(health, dict) or execution.get("healthRc") != 0:
            add_issue(issues, "critical", "execution_health", "dev198 healthz 读取失败")
        else:
            apps = int(health.get("apps") or 0)
            connected = int(health.get("connected") or 0)
            if health.get("ok") is not True or apps == 0 or connected != apps:
                add_issue(issues, "critical", "apps_disconnected", f"Bot 在线 {connected}/{apps}")
            if int(health.get("errors") or 0):
                add_issue(issues, "critical", "app_errors", f"{health.get('errors')} 个 Bot 有 lastError")
            contracts = health.get("contracts") or []
            if len(contracts) != 1 or str(health.get("topContract")) != str(contracts[0] if contracts else ""):
                add_issue(issues, "critical", "contract_split", "Bot 行为契约不唯一或顶层不一致")
            if int(health.get("outboxPending") or 0) or int(health.get("outboxRetrying") or 0):
                add_issue(issues, "critical", "outbox_pending", "Delivery Outbox 有待送达或重试项")
            if health.get("runnerConnected") is not True or int(health.get("runnerApps") or 0) != apps:
                add_issue(issues, "critical", "runner_worker", "Runner Worker 未连接或 App 数不一致")
            if int(health.get("rpcOrphaned") or 0):
                add_issue(issues, "critical", "rpc_orphaned", f"RPC 孤儿 {health.get('rpcOrphaned')} 条")
            if health.get("durableEnabled") is not True:
                add_issue(issues, "critical", "durable_store", "durable store 未启用")
            if health.get("deployDirty") is True:
                add_issue(issues, "warning", "execution_deploy_dirty", "dev198 部署清单标记 dirty")

        parity = execution.get("tenantParity") or {}
        if parity.get("rc") == 2 or parity.get("userLag") is None:
            add_issue(issues, "critical", "tenant_audit_failed", "租户对等巡检自身失败")
        elif int(parity.get("userLag") or 0) or int(parity.get("platformLag") or 0):
            add_issue(
                issues,
                "warning",
                "tenant_parity_lag",
                f"租户对等差异：用户 {int(parity.get('userLag') or 0)}，平台 {int(parity.get('platformLag') or 0)}",
            )

        memory = execution.get("memory") or {}
        if memory.get("rc") == 2 or memory.get("bad") is None:
            add_issue(issues, "critical", "memory_audit_failed", "记忆巡检自身失败")
        elif int(memory.get("bad") or 0):
            add_issue(issues, "critical", "memory_bad", f"记忆巡检 {memory.get('bad')}/{memory.get('checked')} 未达标")

        refresh = execution.get("refresh") or {}
        if refresh.get("result") == "exit-code":
            add_issue(issues, "warning", "grok_refresh_failed", f"owner Grok 保活失败，状态 {refresh.get('status')}")
        failed = execution.get("failedPlatformUnits") or []
        for unit in failed:
            if unit != "grok-xai-refresh.service":
                add_issue(issues, "warning", "failed_unit", f"dev198 失败 unit：{unit}")
        if int(execution.get("diskUsedPercent") or 0) >= 85:
            add_issue(issues, "critical", "disk_full", f"dev198 /srv/h-platform 磁盘已用 {execution.get('diskUsedPercent')}%")
        if int(execution.get("journalErrorLines24h") or 0):
            add_issue(issues, "warning", "journal_errors", f"Bridge/Runner 24h 错误日志 {execution.get('journalErrorLines24h')} 行")

    return issues


def status_for(issues: list[dict]) -> str:
    if any(item["level"] == "critical" for item in issues):
        return "CRITICAL"
    if issues:
        return "WARNING"
    return "OK"


def notify(status: str, issues: list[dict]) -> None:
    if status == "OK" or not shutil_which("notify-send"):
        return
    headline = "；".join(item["message"] for item in issues[:3])
    if len(issues) > 3:
        headline += f"；另 {len(issues) - 3} 项"
    subprocess.run(
        ["notify-send", "-u", "critical" if status == "CRITICAL" else "normal", f"H 平台每日巡检：{status}", headline],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def shutil_which(command: str) -> str | None:
    for directory in os.environ.get("PATH", "").split(os.pathsep):
        candidate = pathlib.Path(directory) / command
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None


def write_report(report: dict) -> None:
    STATE_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    payload = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    fd, temp_name = tempfile.mkstemp(prefix="latest.", dir=STATE_DIR, text=True)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, LATEST)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)
    line = json.dumps(report, ensure_ascii=False, separators=(",", ":")) + "\n"
    descriptor = os.open(HISTORY, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    with os.fdopen(descriptor, "a", encoding="utf-8") as handle:
        handle.write(line)


def main() -> int:
    errors: list[str] = []
    control = None
    execution = None
    try:
        control = fetch_control()
    except Exception as exc:
        errors.append(f"控制面探测失败：{exc}")
    try:
        execution = fetch_execution()
    except Exception as exc:
        errors.append(f"dev198 探测失败：{exc}")

    issues = evaluate(control, execution, errors)
    status = status_for(issues)
    checked_at = utc_now().isoformat().replace("+00:00", "Z")
    fingerprint = hashlib.sha256(
        json.dumps([(item["level"], item["code"]) for item in issues], separators=(",", ":")).encode()
    ).hexdigest()[:16]
    report = {
        "schemaVersion": 1,
        "checkedAt": checked_at,
        "status": status,
        "fingerprint": fingerprint,
        "issues": issues,
        "summary": {
            "controlVersion": control.get("version") if isinstance(control, dict) else None,
            "controlUsers": control.get("users") if isinstance(control, dict) else None,
            "executionCommit": ((execution or {}).get("health") or {}).get("deployCommit"),
            "apps": ((execution or {}).get("health") or {}).get("apps"),
            "connected": ((execution or {}).get("health") or {}).get("connected"),
            "memoryChecked": ((execution or {}).get("memory") or {}).get("checked"),
            "memoryBad": ((execution or {}).get("memory") or {}).get("bad"),
        },
    }
    write_report(report)
    notify(status, issues)

    print(f"H 平台每日巡检：{status}；问题 {len(issues)} 项；报告 {LATEST}")
    for item in issues:
        print(f"[{item['level']}] {item['message']}")
    if "--systemd" in sys.argv and status == "WARNING":
        return 0
    return 2 if status == "CRITICAL" else (1 if status == "WARNING" else 0)


if __name__ == "__main__":
    sys.exit(main())
