#!/usr/bin/env python3
"""host-stats.py — 单机只读状态快照（运营台「服务器状态」tab 与「设备接入」资源卡共同消费）。

一份脚本三台机同用，按机器角色自动挑采集项（也可 --role 强制）：
  worker  ：64.90 / hk2（voice-worker-rust / -firstturn / -colleague）+ 各 worker 到 LiveKit 的 /agent 连接状态 + 判停/声纹边车（sidecars）
            + 语音控设备 24h 统计（device_cmd：提案/结果/慢路/承接音/误触发嫌疑，D1 W4 2026-09-22）
  livekit ：47.239（livekit-server / nginx）+ worker 注册/注销事件 + 监听端口
  api     ：aliyun-hk（pm2 p003-voice / nginx）+ 本机 /health
输出：单行 JSON。worker 角色保留 stats.sh 的老键（mem_total_mb…max_jobs…ts），/worker-stats 与资源卡零改动。

普通采集只读；env 仅取必要配置键。每项采集独立降级，失败进 errors[]，整体预算 7.5 s。
worker 历史统计由 --refresh-journal-cache 异步刷新，单次 40 s / 每条 journal 15 s；普通采集不扫日志。
缓存只写 /run/p003-host-monitor（0600，聚合数据无孩子原话），过期/刷新失败/进程换代均明确不可用。
手动刷新须用 systemctl start p003-host-journal-cache.service，或持有同一 refresh.lock 的 flock；
不得裸跑刷新 CLI 与已启用的 timer 竞争（timer 的 ExecStart 已持锁）。
forced-command 只读 key 锁死到本脚本（64.90 经 stats.sh 转调；47.239 直接指向本脚本）。
"""
from __future__ import annotations

import json
import os
import re
import socket
import ssl
import subprocess
import sys
import time
import collections
import signal
import contextlib
import tempfile
from pathlib import Path

ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
SUBPROCESS_TIMEOUT_S = 5
JOURNAL_TIMEOUT_S = 15
COLLECTION_BUDGET_S = 7.5
JOURNAL_REFRESH_BUDGET_S = 40
JOURNAL_MAX_LINES = 2000
JOURNAL_CACHE_PATH = "/run/p003-host-monitor/cache.json"
JOURNAL_CACHE_MAX_AGE_S = 180
JOURNAL_WINDOW = "-24h"
# 连接状态看的是「当前这代进程」：注册/断线事件可能远早于 24h（09-15 注册后三天无事件），
# 所以 worker 连接块从 unit 的 ActiveEnterTimestamp 起读日志（封顶 3 天），24h 计数另给。
LINK_WINDOW_CAP_S = 3 * 24 * 3600
LIVEKIT_EVENTS_WINDOW = "-7d"
LIVEKIT_URL_FILES = (
    "/root/rust-worker/rust-worker.env",
    "/root/realtime-voice-agent/.env",
    "/opt/p003/server/.env.local",
)
WORKER_UNITS = ("voice-worker-rust", "voice-worker-firstturn", "voice-worker-colleague", "voice-worker-demo")
LIVEKIT_UNITS = ("livekit-server", "nginx")
API_UNITS = ("nginx",)

errors: list[str] = []
_deadline: float | None = None
_snapshot_now = time.time()
_journal_cache: dict[tuple, "JournalRows"] = {}


class CollectionDeadline(BaseException):
    """Must escape per-section except Exception so the snapshot can be published."""


def remaining_timeout(timeout: float) -> float:
    if _deadline is None:
        return timeout
    remaining = _deadline - time.monotonic()
    if remaining <= 0:
        raise CollectionDeadline("collection deadline exceeded")
    return min(timeout, remaining)


def error_text(exc: BaseException | str) -> str:
    if isinstance(exc, subprocess.TimeoutExpired):
        return f"timed out after {exc.timeout:g}s"
    return str(exc).strip().replace("\n", " ")[:160]


def note_error(where: str, exc: BaseException | str) -> None:
    msg = error_text(exc)
    errors.append(f"{where}: {msg[:160]}")


def run(cmd: list[str], timeout: float = SUBPROCESS_TIMEOUT_S, *, no_match_ok: bool = False) -> str:
    """有界只读命令；失败清理整个进程组，禁止把真实失败变成空数据。"""
    timeout = remaining_timeout(timeout)
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, start_new_session=True)
    try:
        stdout, stderr = proc.communicate(timeout=timeout)
    except BaseException:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.communicate()
        raise
    # journalctl -g 无匹配退出 1；权限/参数错误等 stderr 不能伪装成零事件。
    if proc.returncode and not (no_match_ok and proc.returncode == 1 and not stdout.strip() and not stderr.strip()):
        raise RuntimeError(f"{cmd[0]} exit {proc.returncode}: {stderr.strip()[:160]}")
    if no_match_ok and stderr.strip():
        raise RuntimeError(f"{cmd[0]}: {stderr.strip()[:160]}")
    return ANSI_RE.sub("", stdout)


def to_int(v: str | None) -> int | None:
    if v is None:
        return None
    v = v.strip()
    if not v or v in ("[not set]", "infinity", "18446744073709551615"):
        return None
    try:
        return int(v)
    except ValueError:
        return None


# ── 主机资源 ────────────────────────────────────────────────────────────────────

def host_block() -> dict:
    h: dict = {}
    try:
        with open("/proc/uptime", encoding="utf-8") as f:
            h["uptime_s"] = int(float(f.read().split()[0]))
    except Exception as e:  # noqa: BLE001
        note_error("uptime", e)
    try:
        with open("/proc/loadavg", encoding="utf-8") as f:
            parts = f.read().split()
        h["load1"], h["load5"], h["load15"] = (float(parts[0]), float(parts[1]), float(parts[2]))
    except Exception as e:  # noqa: BLE001
        note_error("loadavg", e)
    try:
        h["nproc"] = os.cpu_count()
    except Exception as e:  # noqa: BLE001
        note_error("nproc", e)
    try:
        mem: dict[str, int] = {}
        with open("/proc/meminfo", encoding="utf-8") as f:
            for line in f:
                k, _, rest = line.partition(":")
                mem[k] = int(rest.split()[0])  # kB
        h["mem_total_mb"] = mem["MemTotal"] // 1024
        h["mem_avail_mb"] = mem["MemAvailable"] // 1024
    except Exception as e:  # noqa: BLE001
        note_error("meminfo", e)
    try:
        st = os.statvfs("/")
        total = st.f_blocks * st.f_frsize
        avail = st.f_bavail * st.f_frsize
        h["disk_root_used_pct"] = round((1 - avail / total) * 100, 1) if total else None
        h["disk_root_avail_gb"] = round(avail / 1024**3, 1)
    except Exception as e:  # noqa: BLE001
        note_error("statvfs", e)
    try:
        h["tz"] = time.strftime("%Z")
    except Exception as e:  # noqa: BLE001
        note_error("tz", e)
    return h


# ── systemd 服务 ────────────────────────────────────────────────────────────────

def unit_exists(unit: str) -> bool:
    try:
        out = run(["systemctl", "show", "-p", "LoadState", "--value", f"{unit}.service"])
        return out.strip() == "loaded"
    except Exception:  # noqa: BLE001
        return False


def service_block(unit: str) -> dict:
    props = "LoadState,ActiveState,SubState,NRestarts,ActiveEnterTimestamp,MainPID,MemoryCurrent,MemoryHigh,MemoryMax,Restart,RestartUSec"
    out = run(["systemctl", "show", "--timestamp=unix", "-p", props, f"{unit}.service"])
    kv: dict[str, str] = {}
    for line in out.splitlines():
        k, _, v = line.partition("=")
        if k:
            kv[k] = v
    since_ms = None
    m = re.search(r"@(\d+)", kv.get("ActiveEnterTimestamp", ""))
    if m:
        since_ms = int(m.group(1)) * 1000
    return {
        "name": unit,
        "load_state": kv.get("LoadState"),
        "active_state": kv.get("ActiveState"),
        "sub_state": kv.get("SubState"),
        "nrestarts": to_int(kv.get("NRestarts")),
        "active_since_ms": since_ms,
        "main_pid": to_int(kv.get("MainPID")),
        "mem_bytes": to_int(kv.get("MemoryCurrent")),
        "mem_high_bytes": to_int(kv.get("MemoryHigh")),
        "mem_max_bytes": to_int(kv.get("MemoryMax")),
        "restart_policy": kv.get("Restart"),
        "restart_usec": to_int(kv.get("RestartUSec")),
    }


def services_block(units: tuple[str, ...], res: list[dict] | None = None) -> list[dict]:
    if res is None:
        res = []
    for u in units:
        try:
            if unit_exists(u):
                res.append(service_block(u))
        except Exception as e:  # noqa: BLE001
            note_error(f"service {u}", e)
    return res


# ── journald 解析（-o short-unix：行首 epoch.us）────────────────────────────────

class JournalRows(list):
    def __init__(self, rows=(), *, error: str | None = None, truncated: bool = False):
        super().__init__(rows)
        self.error = error
        self.truncated = truncated
        self.ok = error is None and not truncated


# 只筛消息短语，不筛 tracing 着色的字段名；字段解析前统一剥 ANSI。
WORKER_JOURNAL_GREP = (
    r"registered worker|worker connection failed|次连接失败,放弃|accepting|connected to livekit|"
    r"EOT sidecar|speaker embed|无可用连接|通道不可用|自愈失败|首次连接失败"
)


def journal_lines(unit: str, since: str = JOURNAL_WINDOW, grep: str | None = None) -> JournalRows:
    key = (unit, since, grep)
    if key in _journal_cache:
        return _journal_cache[key]
    # 新→旧读取，最多 N+1 个匹配事件；多出的一个仅作截断哨兵。
    cmd = ["journalctl", "-u", unit, f"--since={since}", "-o", "short-unix", "--no-pager", "-q",
           "--reverse", f"--lines={JOURNAL_MAX_LINES + 1}"]
    if grep:
        cmd += ["-g", grep]  # journald 侧过滤(PCRE),24h 全量行不过管道
    try:
        out = run(cmd, timeout=JOURNAL_TIMEOUT_S, no_match_ok=bool(grep))
        parsed = []
        for line in out.splitlines():
            m = re.match(r"^(\d+(?:\.\d+)?)\s+(.*)$", line)
            if m:
                parsed.append((float(m.group(1)), m.group(2)))
            elif line.strip():
                raise ValueError("unexpected journal output")
        truncated = len(parsed) > JOURNAL_MAX_LINES
        rows = JournalRows(sorted(parsed[:JOURNAL_MAX_LINES]), truncated=truncated)
        if truncated:
            note_error(f"journal {unit}", f"超过 {JOURNAL_MAX_LINES} 条事件，统计不完整")
    except Exception as exc:  # CollectionDeadline intentionally escapes.
        note_error(f"journal {unit}", exc)
        rows = JournalRows(error=error_text(exc))
    _journal_cache[key] = rows  # 失败也复用；同一快照不重复付出超时预算。
    return rows


def worker_journal(unit: str, active_since_ms: int | None) -> tuple[float, JournalRows]:
    since_s = max(_snapshot_now - LINK_WINDOW_CAP_S,
                  (active_since_ms / 1000) - 5 if active_since_ms else _snapshot_now - 86400)
    return since_s, journal_lines(unit, since=f"@{int(since_s)}", grep=WORKER_JOURNAL_GREP)


def worker_link_block(unit: str, active_since_ms: int | None) -> dict:
    """worker → LiveKit /agent 连接状态。窗口 = 本代进程起（封顶 3 天）；判定用日志锚（worker.rs 原话），不猜。"""
    now = _snapshot_now
    since_s, rows = worker_journal(unit, active_since_ms)
    day_ago = now - 86400
    registered = [t for t, s in rows if "registered worker" in s]
    failed = [(t, s) for t, s in rows if "worker connection failed" in s]
    give_ups = [t for t, s in rows if "次连接失败,放弃" in s]
    accepts = [t for t, s in rows if "accepting job_id" in s]
    last_reg = registered[-1] if registered else None
    last_fail = failed[-1] if failed else None
    consecutive = 0
    if last_fail is not None:
        consecutive = sum(1 for t, _ in failed if last_reg is None or t > last_reg)
    if not rows.ok:
        state = "unknown"
    elif last_reg is not None and (last_fail is None or last_reg > last_fail[0]):
        state = "registered"
    elif last_fail is not None:
        state = "reconnecting"
    else:
        state = "unknown"
    err = None
    if last_fail is not None:
        m = re.search(r"error=(.*?)(?:\s+consecutive_failures=|\s+worker connection failed|$)", last_fail[1])
        if m:
            err = m.group(1).strip()[:120]
    agent = None
    m_agent = next((re.search(r"agent_name=([^\s]+)", s) for _, s in rows if "connected to livekit" in s), None)
    if m_agent:
        agent = m_agent.group(1)
    return {
        "unit": unit,
        "agent_name": agent,
        "state": state,
        "journal_ok": rows.ok,
        "journal_truncated": rows.truncated,
        "journal_error": rows.error,
        "window_since_ms": int(since_s * 1000),
        "registered_at_ms": int(last_reg * 1000) if last_reg else None,
        "last_failure_at_ms": int(last_fail[0] * 1000) if last_fail else None,
        "last_failure_error": err,
        "failures_window": len(failed) if rows.ok else None,
        "failures_24h": sum(1 for t, _ in failed if t >= day_ago) if rows.ok else None,
        "registrations_window": len(registered) if rows.ok else None,
        "give_ups_window": len(give_ups) if rows.ok else None,
        "consecutive_failures_since_register": consecutive if rows.ok else None,
        "job_accepts_24h": sum(1 for t in accepts if t >= day_ago) if rows.ok else None,
        "journal_lines_window": len(rows),
    }


def livekit_events_block() -> dict:
    rows = journal_lines("livekit-server", since=LIVEKIT_EVENTS_WINDOW,
                         grep=r"worker registered|closing worker|last worker deregistered")
    if not rows.ok:
        raise RuntimeError("注册事件采集不完整，计数不可用")
    day_ago = time.time() - 86400
    reg = [(t, s) for t, s in rows if "worker registered" in s]
    closing = [(t, s) for t, s in rows if "closing worker" in s]
    dereg_all = [t for t, s in rows if "last worker deregistered" in s]
    events: list[dict] = []
    for t, s in reg:
        m = re.search(r'"agentName"\s*:\s*"([^"]*)"', s)
        events.append({"ts_ms": int(t * 1000), "type": "registered", "agent": m.group(1) if m else None})
    for t, s in closing:
        m = re.search(r'"agentName"\s*:\s*"([^"]*)"', s)
        events.append({"ts_ms": int(t * 1000), "type": "closing", "agent": m.group(1) if m else None})
    events.sort(key=lambda e: e["ts_ms"])
    return {
        "worker_registered_24h": sum(1 for t, _ in reg if t >= day_ago),
        "worker_closing_24h": sum(1 for t, _ in closing if t >= day_ago),
        "all_deregistered_24h": sum(1 for t in dereg_all if t >= day_ago),
        "worker_registered_7d": len(reg),
        "worker_closing_7d": len(closing),
        "last_events": events[-8:],
        "journal_lines_7d": len(rows),
    }


# ── 网络探针 ────────────────────────────────────────────────────────────────────

def read_livekit_host() -> str | None:
    """只取 LIVEKIT_URL 一行；不加载其它键。"""
    for path in LIVEKIT_URL_FILES:
        try:
            with open(path, encoding="utf-8") as f:
                for line in f:
                    if line.startswith("LIVEKIT_URL="):
                        url = line.split("=", 1)[1].strip().strip('"').strip("'")
                        m = re.match(r"^\w+://([^/:]+)", url)
                        return m.group(1) if m else None
        except OSError:
            continue
    return None


def tls_probe(host: str, port: int = 443, timeout: float = 3.0) -> dict:
    t0 = time.monotonic()
    try:
        timeout = remaining_timeout(timeout)
        ctx = ssl.create_default_context()
        with socket.create_connection((host, port), timeout=timeout) as raw:
            with ctx.wrap_socket(raw, server_hostname=host):
                pass
        return {"host": host, "port": port, "tls_ms": round((time.monotonic() - t0) * 1000, 1), "error": None}
    except Exception as e:  # noqa: BLE001
        return {"host": host, "port": port, "tls_ms": None, "error": str(e)[:120]}


def listening_ports(ports: tuple[int, ...]) -> dict[str, bool]:
    """从 /proc/net/tcp{,6} 读 LISTEN 状态（0A），不依赖 ss。"""
    listen: set[int] = set()
    for path in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            with open(path, encoding="utf-8") as f:
                next(f)
                for line in f:
                    cols = line.split()
                    if len(cols) > 3 and cols[3] == "0A":
                        listen.add(int(cols[1].rsplit(":", 1)[1], 16))
        except OSError:
            continue
    return {str(p): (p in listen) for p in ports}


def http_probe(url: str, timeout: float = 3.0) -> dict:
    import urllib.request

    t0 = time.monotonic()
    try:
        timeout = remaining_timeout(timeout)
        with urllib.request.urlopen(url, timeout=timeout) as resp:  # noqa: S310 - 固定 127.0.0.1
            resp.read(256)
            return {"url": url, "status": resp.status, "ms": round((time.monotonic() - t0) * 1000, 1), "error": None}
    except Exception as e:  # noqa: BLE001
        code = getattr(e, "code", None)
        return {"url": url, "status": code, "ms": round((time.monotonic() - t0) * 1000, 1), "error": str(e)[:120]}


def pm2_block() -> list[dict]:
    out = run(["pm2", "jlist"], timeout=SUBPROCESS_TIMEOUT_S)
    start = out.find("[")
    data = json.loads(out[start:]) if start >= 0 else []
    res = []
    for p in data:
        env = p.get("pm2_env", {}) or {}
        mon = p.get("monit", {}) or {}
        res.append(
            {
                "name": p.get("name"),
                "status": env.get("status"),
                "restarts": env.get("restart_time"),
                "unstable_restarts": env.get("unstable_restarts"),
                "uptime_since_ms": env.get("pm_uptime"),
                "pid": p.get("pid"),
                "mem_bytes": mon.get("memory"),
                "cpu_pct": mon.get("cpu"),
            }
        )
    return res


# ── 判停/声纹边车（EOT sidecar）────────────────────────────────────
# worker 进程自己拉起的 python 边车（eot_sidecar.py <sock>），unix socket 通信；判停 + 声纹都走它。
# 08-14 实证的故障形态：边车死了 worker 不重连（进程级单例）→ 判停变钝 + 声纹全失效，而 systemd 看 worker 一切正常。
# 判据全部用外部可见事实：unit 生效 env 的 EOT_SOCK → ss 有无监听 → 监听进程 pid/rss/存活/是否在本 unit cgroup
# → journal 锚（worker 原话）：最近一次「EOT sidecar connected」/「自愈」、1h 内「不可用」告警计数。
SIDECAR_SCRIPT = "eot_sidecar.py"
SIDECAR_UNAVAILABLE_RE = re.compile(r"无可用连接|通道不可用|自愈失败|首次连接失败")
SIDECAR_CONNECTED_RE = re.compile(r"EOT sidecar connected \((spawned|existing)\)|EOT sidecar 连接已自愈|speaker embed 连接已自愈")


def proc_env_value(pid: int, key: str) -> str | None:
    try:
        with open(f"/proc/{pid}/environ", "rb") as f:
            for item in f.read().split(b"\0"):
                if item.startswith(key.encode() + b"="):
                    return item.split(b"=", 1)[1].decode(errors="replace")
    except OSError:
        return None
    return None


def proc_unit(pid: int) -> str | None:
    try:
        with open(f"/proc/{pid}/cgroup", encoding="utf-8") as f:
            m = re.search(r"/([^/]+)\.service", f.read())
            return m.group(1) if m else None
    except OSError:
        return None


def sidecar_processes() -> list[dict]:
    out = run(["ps", "-eo", "pid,ppid,rss,etimes,args", "--no-headers"])
    res = []
    for line in out.splitlines():
        if SIDECAR_SCRIPT not in line or "grep" in line:
            continue
        parts = line.split(None, 4)
        if len(parts) < 5:
            continue
        args = parts[4]
        sock = args.split()[-1] if args.split() else None
        res.append({"pid": to_int(parts[0]), "ppid": to_int(parts[1]), "rss_bytes": (to_int(parts[2]) or 0) * 1024, "age_s": to_int(parts[3]), "sock": sock, "unit": proc_unit(int(parts[0]))})
    return res


def listening_unix_socks() -> set[str]:
    out = run(["ss", "-xlH"])
    socks = set()
    for line in out.splitlines():
        for tok in line.split():
            if tok.endswith(".sock"):
                socks.add(tok)
    return socks


def sidecar_history(unit: str, active_since_ms: int | None) -> dict:
    _, journal = worker_journal(unit, active_since_ms)
    last_connected_ms = last_connected_mode = None
    unavailable_1h = 0 if journal.ok else None
    for stamp, line in journal:
        match = SIDECAR_CONNECTED_RE.search(line)
        if match:
            last_connected_ms = int(stamp * 1000)
            last_connected_mode = match.group(1) or "healed"
        if journal.ok and stamp >= _snapshot_now - 3600 and SIDECAR_UNAVAILABLE_RE.search(line):
            unavailable_1h += 1
    return {"journal_ok": journal.ok, "journal_truncated": journal.truncated,
            "journal_error": journal.error, "last_connected_ms": last_connected_ms,
            "last_connected_mode": last_connected_mode, "unavailable_1h": unavailable_1h}


def sidecars_block(services: list[dict], histories: dict | None = None) -> list[dict]:
    procs = sidecar_processes()
    listening = listening_unix_socks()
    now = _snapshot_now
    rows = []
    sock_owner: dict[str, list[str]] = {}
    for s in services:
        pid = s.get("main_pid") or 0
        sock = proc_env_value(pid, "EOT_SOCK") if pid else None
        if sock:
            sock_owner.setdefault(sock, []).append(s["name"])
    for s in services:
        unit = s["name"]
        pid = s.get("main_pid") or 0
        if not pid or s.get("active_state") != "active":
            rows.append({"unit": unit, "state": "unit_inactive", "sock": None})
            continue
        sock = proc_env_value(pid, "EOT_SOCK")
        if not sock:
            continue  # 非 rust 池（python 租户线）没有边车
        proc = next((p for p in procs if p["sock"] == sock), None)
        is_listening = sock in listening
        history = sidecar_history(unit, s.get("active_since_ms")) if histories is None else histories.get(unit, {
            "journal_ok": False, "journal_error": "日志缓存不可用", "unavailable_1h": None,
            "last_connected_ms": None, "last_connected_mode": None})
        unavailable_1h = history.get("unavailable_1h")
        if proc and is_listening and not history.get("journal_ok"):
            state = "unknown"
        elif proc and is_listening and unavailable_1h == 0:
            state = "ok"
        elif proc and is_listening:
            state = "degraded"
        else:
            state = "missing"
        rows.append({
            "unit": unit,
            "state": state,
            **history,
            "sock": sock,
            "listening": is_listening,
            "pid": (proc or {}).get("pid"),
            "rss_bytes": (proc or {}).get("rss_bytes"),
            "age_s": (proc or {}).get("age_s"),
            "owner_unit": (proc or {}).get("unit"),
            "spawned_by_this_worker": bool(proc and proc.get("ppid") == pid),
            "shared_with": [u for u in sock_owner.get(sock, []) if u != unit],
        })
    return rows


# ── 语音控设备 24h（D1 W4，2026-09-22）：提案/结果/慢路/承接音/误触发嫌疑，只读 journal 锚（worker 日志原话，不猜）──
DEVICE_CMD_WINDOW = "-24h"
DEVICE_CMD_GREP = r"device command proposed|device command result|llm device intent|fallback hint queued|filler picked|device grammar hit|device grammar veto|received job request, accepting"
ACCEPT_ROOM_RE = re.compile(r"accepting job_id=\S+ room=(sn-[A-Za-z0-9]+-\d+)")
# 「误触发嫌疑」= 慢路(LLM)提案而原话不含任何设备词根(方案 v1.1 §W4);裸「高/低/远/近」太泛不算根,组合词才算
DEVICE_ROOTS = (
    "灯", "亮", "暗", "光", "色温", "模式", "音量", "声音", "大声", "小声", "静音", "吵", "听不清",
    "读写台", "设备", "画面", "虚像", "台子", "升高", "降低", "抬高", "调高", "调低", "太高", "太低",
    "拉远", "拉近", "调远", "调近", "太远", "太近", "暖", "冷",
)
KV_RE = re.compile(r"(\w+)=(\"[^\"]*\"|'[^']*'|\S+)")
PROPOSED_TEXT_RE = re.compile(r"device command proposed: '([^']*)'")
GRAMMAR_TEXT_RE = re.compile(r"device grammar hit: '([^']*)'")  # D2 语法层（observe 只记这行；execute 另有 lane=L1g 提案）
VETO_TEXT_RE = re.compile(r"device grammar veto: '([^']*)'")  # D2.1 带设备词却被语法层否决（reason=守卫名[:词]）
VETO_NEW_REASONS = ("time_future", "place", "statement_le")  # D2.1 万能语法 20 槽体检新增的三道否决


def _kv(s: str) -> dict:
    return {k: v.strip('"').strip("'") for k, v in KV_RE.findall(s)}


def _sn_tail(room: str) -> str:
    """房名 sn-<SN>-<ts> → 只暴露 SN 末 8 位；非设备房原样截 16。"""
    parts = room.split("-")
    if len(parts) >= 3 and parts[0] == "sn":
        return "…" + parts[1][-8:]
    return room[:16]


def _lane_of(p: dict) -> str:
    mt = p.get("match_type", "")
    if mt == "command_word":
        return "chip"
    if mt == "grammar" or (p.get("lane") or "") == "L1g":
        return "L1g"
    if (p.get("lane") or "").upper() == "L2" or mt == "llm":
        return "L2"
    return "L1"


def device_cmd_block(services: list[dict]) -> list[dict]:
    out: list[dict] = []
    for s in services:
        unit = s["name"]
        if s.get("active_state") != "active":
            continue
        rows = journal_lines(unit, since=DEVICE_CMD_WINDOW, grep=DEVICE_CMD_GREP)
        if not rows.ok:
            continue  # 无完整证据时不发布全零 24h 统计；错误已写入 errors。
        props: list[dict] = []
        results: list[dict] = []
        observed = executed = hints = filler_dev = 0
        suppressed: collections.Counter = collections.Counter()
        grammar: list[dict] = []  # D2 语法层命中（observe/execute 都记）
        vetoes: list[dict] = []  # D2.1 语法层否决（只记带设备词的句子）
        sessions: collections.Counter = collections.Counter()  # 24h 设备房数（按 SN 末 8 位）——没发过命令的设备也要在表里
        for t, raw in rows:
            line = ANSI_RE.sub("", raw)
            if "accepting job_id" in line:
                m = ACCEPT_ROOM_RE.search(line)
                if m:
                    sessions[_sn_tail(m.group(1))] += 1
                continue
            if "device command proposed" in line:
                m = PROPOSED_TEXT_RE.search(line)
                d = _kv(line.split("device command proposed", 1)[1])
                d["t"] = t
                d["text"] = m.group(1) if m else ""
                props.append(d)
            elif "device command result" in line:
                d = _kv(line.split("device command result", 1)[1])
                d["t"] = t
                results.append(d)
            elif "llm device intent observed" in line:
                observed += 1
            elif "llm device intent executed" in line:
                executed += 1
            elif "llm device intent suppressed" in line:
                suppressed[_kv(line).get("reason", "?")] += 1
            elif "fallback hint queued" in line:
                hints += 1
            elif "device grammar hit" in line:
                g = _kv(line.split("device grammar hit", 1)[1])
                m = GRAMMAR_TEXT_RE.search(line)
                g["t"] = t
                g["text"] = m.group(1) if m else ""
                grammar.append(g)
            elif "device grammar veto" in line:
                v = _kv(line.split("device grammar veto", 1)[1])
                m = VETO_TEXT_RE.search(line)
                v["t"] = t
                v["text"] = m.group(1) if m else ""
                vetoes.append(v)
            elif "filler picked" in line and "bucket=device" in line:
                filler_dev += 1
        # 提案↔结果配对：同房同标签、提案后 30 s 内；首个非 accepted 为终态
        for p in props:
            same = [
                r for r in results
                if r.get("room") == p.get("room") and r.get("semantic_label") == p.get("semantic_label")
                and p["t"] <= r["t"] <= p["t"] + 30
            ]
            term = next((r for r in same if r.get("status") != "accepted"), None)
            p["status"] = term.get("status") if term else ("accepted" if same else None)
            p["reason"] = term.get("reason") if term else None
        by_lane = collections.Counter(_lane_of(p) for p in props)
        st = collections.Counter((p["status"] or "none") for p in props)
        failed = sum(v for k, v in st.items() if k not in ("succeeded", "already_applied", "none", "accepted"))
        devices: dict[str, dict] = {}
        for k, n in sessions.items():
            devices[k] = {"sn": k, "sessions": n, "proposals": 0, "succeeded": 0, "already_applied": 0, "failed": 0, "none": 0, "last_text": "", "last_ms": 0}
        for p in props:
            k = _sn_tail(p.get("room", ""))
            d = devices.setdefault(k, {"sn": k, "sessions": 0, "proposals": 0, "succeeded": 0, "already_applied": 0, "failed": 0, "none": 0, "last_text": "", "last_ms": 0})
            d["proposals"] += 1
            stt = p["status"] or "none"
            if stt == "succeeded":
                d["succeeded"] += 1
            elif stt == "already_applied":
                d["already_applied"] += 1
            elif stt in ("none", "accepted"):
                d["none"] += 1
            else:
                d["failed"] += 1
            if int(p["t"] * 1000) > d["last_ms"]:
                d["last_ms"] = int(p["t"] * 1000)
                d["last_text"] = p["text"][:40]
        suspects = [
            {"ts_ms": int(p["t"] * 1000), "sn": _sn_tail(p.get("room", "")), "text": p["text"][:60],
             "label": to_int(p.get("semantic_label")), "status": p["status"] or "none"}
            for p in props if _lane_of(p) == "L2" and not any(r in p["text"] for r in DEVICE_ROOTS)
        ]
        # D2 语法层 observe 对账：同房同原话 60 s 内是否出现慢路(L2)提案 = 大模型也认；没有 = 大模型漏（或语法误）
        for g in grammar:
            g["llm_agree"] = any(
                _lane_of(p) == "L2" and p.get("room") == g.get("room") and p["text"] == g["text"] and g["t"] <= p["t"] <= g["t"] + 60
                for p in props
            )
        # D2.1 否决对账：同房同原话 60 s 内出现慢路(L2)提案 = 语法否决了但大模型开火（分歧，人工看）
        for v in vetoes:
            v["reason_key"] = (v.get("reason") or "?").split(":", 1)[0]
            v["llm_fired"] = any(
                _lane_of(p) == "L2" and p.get("room") == v.get("room") and p["text"] == v["text"] and v["t"] <= p["t"] <= v["t"] + 60
                for p in props
            )
        v_reason = collections.Counter(v["reason_key"] for v in vetoes)
        g_mode = collections.Counter((g.get("mode") or "?") for g in grammar)
        g_dom = collections.Counter((g.get("domain") or "?") for g in grammar)
        grammar_block = {
            "hits": len(grammar), "by_mode": dict(g_mode), "by_domain": dict(g_dom),
            "llm_agree": sum(1 for g in grammar if g["llm_agree"]),
            "llm_missed": sum(1 for g in grammar if not g["llm_agree"]),
            "modal_hits": sum(1 for g in grammar if (g.get("modal") or "") == "true"),
            "vetoes": len(vetoes),
            "veto_by_reason": dict(v_reason),
            "veto_new": {k: v_reason.get(k, 0) for k in VETO_NEW_REASONS},
            "veto_llm_fired": sum(1 for v in vetoes if v["llm_fired"]),
            "veto_recent": [
                {"ts_ms": int(v["t"] * 1000), "sn": _sn_tail(v.get("room", "")), "text": v["text"][:40],
                 "reason": v.get("reason"), "llm_fired": v["llm_fired"]}
                for v in sorted(vetoes, key=lambda x: -x["t"])[:8]
            ],
            "recent": [
                {"ts_ms": int(g["t"] * 1000), "sn": _sn_tail(g.get("room", "")), "text": g["text"][:40], "label": to_int(g.get("label")),
                 "domain": g.get("domain"), "mode": g.get("mode"), "llm_agree": g["llm_agree"]}
                for g in sorted(grammar, key=lambda x: -x["t"])[:8]
            ],
        }
        recent = [
            {"ts_ms": int(p["t"] * 1000), "sn": _sn_tail(p.get("room", "")), "text": p["text"][:40],
             "label": to_int(p.get("semantic_label")), "lane": _lane_of(p), "match_type": p.get("match_type"),
             "status": p["status"] or "none", "reason": p.get("reason")}
            for p in sorted(props, key=lambda x: -x["t"])[:10]
        ]
        out.append({
            "unit": unit,
            "window": DEVICE_CMD_WINDOW,
            "proposals": {"total": len(props), "l1": by_lane.get("L1", 0), "l1g": by_lane.get("L1g", 0), "l2": by_lane.get("L2", 0), "chip": by_lane.get("chip", 0)},
            "results": {
                "succeeded": st.get("succeeded", 0), "already_applied": st.get("already_applied", 0),
                "failed": failed, "none": st.get("none", 0) + st.get("accepted", 0),
                "by_status": dict(st),
            },
            "l2": {"observed": observed, "executed": executed, "suppressed": sum(suppressed.values()),
                   "suppressed_by_reason": dict(suppressed), "hints": hints},
            "filler_device_picks": filler_dev,
            "grammar": grammar_block,
            "active_devices": sum(1 for d in devices.values() if d["sessions"] > 0),
            "commanding_devices": sum(1 for d in devices.values() if d["proposals"] > 0),
            "sessions_total": sum(sessions.values()),
            "devices": sorted(devices.values(), key=lambda d: (-d["proposals"], -d["sessions"])),
            "misfire_suspects": suspects,
            "recent": recent,
            "journal_lines": len(rows),
        })
    return out


# ── 角色装配 ────────────────────────────────────────────────────────────────────

@contextlib.contextmanager
def collection_budget(seconds: float, *, catch_term: bool = False):
    global _deadline, _snapshot_now
    errors.clear()
    _journal_cache.clear()
    started = time.monotonic()
    _snapshot_now = time.time()
    _deadline = started + seconds
    def expired(_signum, _frame):
        raise CollectionDeadline("collection deadline exceeded")
    old_alarm = signal.signal(signal.SIGALRM, expired)
    old_term = signal.signal(signal.SIGTERM, expired) if catch_term else None
    old_timer = signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, old_alarm)
        if catch_term:
            signal.signal(signal.SIGTERM, old_term)
        if old_timer[0] or old_timer[1]:
            signal.setitimer(signal.ITIMER_REAL,
                             max(0.000001, old_timer[0] - (time.monotonic() - started)) if old_timer[0] else 0,
                             old_timer[1])
        _deadline = None


def atomic_cache_write(payload: dict) -> None:
    path = Path(JOURNAL_CACHE_PATH)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix=".cache-", delete=False) as stream:
            temporary = stream.name
            os.fchmod(stream.fileno(), 0o600)
            json.dump(payload, stream, ensure_ascii=False, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


def without_child_text(value):
    """缓存只保留计数、状态和必要标识；不持久化原始日志或孩子说的话。"""
    if isinstance(value, dict):
        return {key: without_child_text(item) for key, item in value.items()
                if key not in ("text", "last_text")}
    if isinstance(value, list):
        return [without_child_text(item) for item in value]
    return value


def refresh_journal_cache() -> bool:
    payload = {"schema": "host-journal-cache/1", "ok": False, "units": {}}
    with collection_budget(JOURNAL_REFRESH_BUDGET_S, catch_term=True):
        payload["started_at_ms"] = int(_snapshot_now * 1000)
        try:
            services = services_block(WORKER_UNITS)
            for service in services:
                if service.get("active_state") != "active":
                    continue
                unit = service["name"]
                link = worker_link_block(unit, service.get("active_since_ms"))
                history = sidecar_history(unit, service.get("active_since_ms"))
                commands = device_cmd_block([service])
                payload["units"][unit] = {
                    "main_pid": service.get("main_pid"),
                    "active_since_ms": service.get("active_since_ms"),
                    "worker_link": link, "sidecar": history,
                    "device_cmd": commands[0] if commands else None,
                }
            if not payload["units"]:
                note_error("journal cache", "没有可采集的活动 worker")
        except (Exception, CollectionDeadline) as exc:
            note_error("journal refresh", exc)
        payload["errors"] = list(errors)
        payload["ok"] = not errors
    payload["collected_at_ms"] = int(time.time() * 1000)
    atomic_cache_write(without_child_text(payload))
    return payload["ok"]


def invalidate_failed_refresh() -> None:
    # ExecStopPost also runs after success; only an actual systemd failure invalidates.
    result = os.environ.get("SERVICE_RESULT", "unknown")
    if result == "success":
        return
    details = []
    try:
        with open(JOURNAL_CACHE_PATH, encoding="utf-8") as stream:
            previous = json.load(stream)
        if previous.get("ok") is False and isinstance(previous.get("errors"), list):
            details = [str(item)[:200] for item in previous["errors"][:12]]
    except (OSError, ValueError, AttributeError):
        pass
    message = f"refresh service failed: {result}"
    if message not in details:
        details.append(message)
    try:
        atomic_cache_write({"schema": "host-journal-cache/1", "ok": False,
                            "collected_at_ms": int(time.time() * 1000), "units": {},
                            "errors": details})
    except Exception:
        # 磁盘满等故障下，精确移除旧成功缓存也比继续假健康更诚实。
        try:
            Path(JOURNAL_CACHE_PATH).unlink(missing_ok=True)
        except OSError:
            pass  # 若只读文件系统连删除也失败，非零退出 + 180 秒过期兜底。
        raise


def read_journal_cache(services: list[dict]) -> tuple[dict, dict]:
    info = {"state": "missing", "collected_at_ms": None,
            "max_age_s": JOURNAL_CACHE_MAX_AGE_S, "error": None}
    units = {}
    try:
        with open(JOURNAL_CACHE_PATH, encoding="utf-8") as stream:
            raw = stream.read(2 * 1024 * 1024 + 1)
        if len(raw) > 2 * 1024 * 1024:
            raise ValueError("日志缓存过大")
        data = json.loads(raw)
        if data.get("schema") != "host-journal-cache/1":
            raise ValueError("日志缓存版本无效")
        stamp = data.get("collected_at_ms")
        if not isinstance(stamp, (int, float)) or isinstance(stamp, bool):
            raise ValueError("日志缓存采集时间无效")
        info["collected_at_ms"] = stamp
        age = time.time() - stamp / 1000
        if not data.get("ok"):
            raise ValueError("; ".join(str(e) for e in data.get("errors", [])) or "日志缓存刷新失败")
        if age > JOURNAL_CACHE_MAX_AGE_S or age < -5:
            info.update(state="stale", error="日志统计已过期，等待刷新")
        else:
            info["state"] = "fresh"
            for service in services:
                if service.get("active_state") != "active":
                    continue
                cached = data.get("units", {}).get(service["name"])
                if (not isinstance(cached, dict)
                        or cached.get("main_pid") != service.get("main_pid")
                        or cached.get("active_since_ms") != service.get("active_since_ms")):
                    info.update(state="generation_mismatch", error="worker 进程代次已变化，等待日志刷新")
                    continue
                if not isinstance(cached.get("worker_link"), dict) or not isinstance(cached.get("sidecar"), dict):
                    raise ValueError("日志缓存结构不完整")
                units[service["name"]] = cached
    except FileNotFoundError:
        info["error"] = "日志缓存尚未生成"
    except Exception as exc:
        info.update(state="error", error=error_text(exc))
        units = {}
    if info["state"] != "fresh":
        note_error("journal cache", info["error"] or info["state"])
    return units, info


def unknown_worker_link(unit: str, reason: str | None) -> dict:
    return {"unit": unit, "agent_name": None, "state": "unknown", "journal_ok": False,
            "journal_error": reason, "registered_at_ms": None, "last_failure_at_ms": None,
            "last_failure_error": None, "failures_window": None, "failures_24h": None,
            "registrations_window": None, "give_ups_window": None,
            "consecutive_failures_since_register": None, "job_accepts_24h": None}

def detect_role() -> str:
    if unit_exists("voice-worker-rust"):
        return "worker"
    if unit_exists("livekit-server"):
        return "livekit"
    try:
        if any(p.get("name") == "p003-voice" for p in pm2_block()):
            return "api"
    except Exception:  # noqa: BLE001
        pass
    return "unknown"


def legacy_worker_keys(snap: dict, *, read_capacity: bool = True) -> None:
    """stats.sh 老键（设备接入页资源卡 + /worker-stats 容量卡消费；缺一不可）。"""
    h = snap.get("host", {})
    snap["mem_total_mb"] = h.get("mem_total_mb")
    snap["mem_avail_mb"] = h.get("mem_avail_mb")
    snap["load1"] = h.get("load1")
    snap["nproc"] = h.get("nproc")
    rust = next((s for s in snap.get("services", []) if s["name"] == "voice-worker-rust"), None)
    snap["rust_mem_bytes"] = (rust or {}).get("mem_bytes") or 0
    snap["rust_mem_high_bytes"] = (rust or {}).get("mem_high_bytes") or 0
    snap["rust_active"] = (rust or {}).get("active_state") or "unknown"
    max_jobs = snap.get("max_jobs")
    if read_capacity:
        try:
            with open("/root/rust-worker/rust-worker.env", encoding="utf-8") as f:
                for line in f:
                    if line.startswith("WORKER_MAX_JOBS="):
                        max_jobs = to_int(line.split("=", 1)[1])
        except OSError:
            pass
    snap["max_jobs"] = max_jobs if max_jobs is not None else 6


def collect_role(snap: dict, role: str) -> None:
    if role == "worker":
        legacy_worker_keys(snap)
        snap["services"] = services_block(WORKER_UNITS, snap["services"])
        links = []
        snap["connections"] = {"worker_links": links}
        legacy_worker_keys(snap, read_capacity=False)
        cached_units, info = read_journal_cache(snap["services"])
        snap["journal_cache"] = info
        for service in snap["services"]:
            cached = cached_units.get(service["name"], {})
            links.append(cached.get("worker_link") or unknown_worker_link(service["name"], info.get("error")))
        try:
            snap["sidecars"] = sidecars_block(snap["services"], {
                unit: value["sidecar"] for unit, value in cached_units.items()})
        except Exception as exc:
            note_error("sidecars", exc)
            snap["sidecars"] = []
        snap["device_cmd"] = [value["device_cmd"] for value in cached_units.values() if value.get("device_cmd")]
        lk_host = read_livekit_host()
        snap["connections"] = {
            "worker_links": links,
            "livekit_probe": tls_probe(lk_host) if lk_host else {"host": None, "error": "LIVEKIT_URL not found"},
        }
    elif role == "livekit":
        snap["services"] = services_block(LIVEKIT_UNITS, snap["services"])
        conn = snap["connections"]
        try:
            conn["livekit"] = livekit_events_block()
        except Exception as e:  # noqa: BLE001
            note_error("livekit_events", e)
        conn["listen"] = listening_ports((443, 7880, 7881))
        conn["local_http"] = http_probe("http://127.0.0.1:7880/")
        snap["connections"] = conn
    elif role == "api":
        snap["services"] = services_block(API_UNITS, snap["services"])
        conn = snap["connections"]
        try:
            conn["pm2"] = [p for p in pm2_block() if p.get("name") in ("p003-voice",)]
        except Exception as e:  # noqa: BLE001
            note_error("pm2", e)
        conn["health"] = http_probe("http://127.0.0.1:3001/health")
        conn["listen"] = listening_ports((443, 3001))
        snap["connections"] = conn
    else:
        snap["services"] = []
        snap["connections"] = {}


def collect_snapshot(role: str | None = None) -> dict:
    started = time.monotonic()
    snap: dict = {"schema": "host-stats/1", "ts": int(time.time()),
                  "collected_at_ms": int(time.time() * 1000), "host": {},
                  "services": [], "connections": {}, "role": role or "unknown"}
    with collection_budget(COLLECTION_BUDGET_S):
        try:
            snap["hostname"] = socket.gethostname()
            snap["host"] = host_block()
            role = role or detect_role()
            snap["role"] = role
            collect_role(snap, role)
        except (Exception, CollectionDeadline) as exc:
            note_error("collection", exc)
            snap["partial"] = True
    if snap["role"] == "worker":
        legacy_worker_keys(snap, read_capacity=False)
    snap["errors"] = list(errors)
    snap["collect_ms"] = int((time.monotonic() - started) * 1000)
    return snap


def main() -> None:
    if sys.argv[1:] == ["--refresh-journal-cache"]:
        ok = refresh_journal_cache()
        sys.stdout.write(json.dumps({"ok": ok, "errors": list(errors)}, ensure_ascii=False) + "\n")
        if not ok:
            raise SystemExit(1)
        return
    if sys.argv[1:] == ["--invalidate-failed-refresh"]:
        invalidate_failed_refresh()
        return
    role = sys.argv[2] if len(sys.argv) >= 3 and sys.argv[1] == "--role" else None
    snap = collect_snapshot(role)
    sys.stdout.write(json.dumps(snap, ensure_ascii=False, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001 - 最后防线：仍输出合法 JSON
        sys.stdout.write(json.dumps({"schema": "host-stats/1", "ts": int(time.time()), "role": "unknown", "errors": [f"fatal: {e}"]}) + "\n")
        if sys.argv[1:] in (["--refresh-journal-cache"], ["--invalidate-failed-refresh"]):
            raise SystemExit(1)  # 让 systemd 执行失败失效钩子，不能把缓存写失败当成功。
