#!/usr/bin/env python3
"""host-stats.py — 单机只读状态快照（运营台「服务器状态」tab 与「设备接入」资源卡共同消费）。

一份脚本三台机同用，按机器角色自动挑采集项（也可 --role 强制）：
  worker  ：64.90 / hk2（voice-worker-rust / -firstturn / -colleague）+ 各 worker 到 LiveKit 的 /agent 连接状态 + 判停/声纹边车（sidecars）
  livekit ：47.239（livekit-server / nginx）+ worker 注册/注销事件 + 监听端口
  api     ：aliyun-hk（pm2 p003-voice / nginx）+ 本机 /health
输出：单行 JSON。worker 角色保留 stats.sh 的老键（mem_total_mb…max_jobs…ts），/worker-stats 与资源卡零改动。

纪律：只读；不读任何密钥（env 文件只取 LIVEKIT_URL 一行）；每项采集独立 try/except，失败进 errors[]，
永不让整份快照失败；单个外部命令 ≤ 5 s，整体目标 < 8 s（server 侧 ssh 超时 12 s）。
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

ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
SUBPROCESS_TIMEOUT_S = 5
JOURNAL_TIMEOUT_S = 6
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


def note_error(where: str, exc: BaseException | str) -> None:
    msg = str(exc).strip().replace("\n", " ")
    errors.append(f"{where}: {msg[:160]}")


def run(cmd: list[str], timeout: int = SUBPROCESS_TIMEOUT_S) -> str:
    """跑一条只读命令，返回 stdout（去 ANSI）。非零退出码也返回 stdout（systemctl show 对不存在的 unit 也退 0）。"""
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=False)
    return ANSI_RE.sub("", out.stdout)


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


def services_block(units: tuple[str, ...]) -> list[dict]:
    res = []
    for u in units:
        try:
            if unit_exists(u):
                res.append(service_block(u))
        except Exception as e:  # noqa: BLE001
            note_error(f"service {u}", e)
    return res


# ── journald 解析（-o short-unix：行首 epoch.us）────────────────────────────────

def journal_lines(unit: str, since: str = JOURNAL_WINDOW) -> list[tuple[float, str]]:
    out = run(
        ["journalctl", "-u", unit, f"--since={since}", "-o", "short-unix", "--no-pager", "-q"],
        timeout=JOURNAL_TIMEOUT_S,
    )
    rows: list[tuple[float, str]] = []
    for line in out.splitlines():
        m = re.match(r"^(\d+(?:\.\d+)?)\s+(.*)$", line)
        if m:
            rows.append((float(m.group(1)), m.group(2)))
    return rows


def worker_link_block(unit: str, active_since_ms: int | None) -> dict:
    """worker → LiveKit /agent 连接状态。窗口 = 本代进程起（封顶 3 天）；判定用日志锚（worker.rs 原话），不猜。"""
    now = time.time()
    since_s = max(now - LINK_WINDOW_CAP_S, (active_since_ms / 1000) - 5 if active_since_ms else now - 86400)
    rows = journal_lines(unit, since=f"@{int(since_s)}")
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
    if last_reg is not None and (last_fail is None or last_reg > last_fail[0]):
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
        "window_since_ms": int(since_s * 1000),
        "registered_at_ms": int(last_reg * 1000) if last_reg else None,
        "last_failure_at_ms": int(last_fail[0] * 1000) if last_fail else None,
        "last_failure_error": err,
        "failures_window": len(failed),
        "failures_24h": sum(1 for t, _ in failed if t >= day_ago),
        "registrations_window": len(registered),
        "give_ups_window": len(give_ups),
        "consecutive_failures_since_register": consecutive,
        "job_accepts_24h": sum(1 for t in accepts if t >= day_ago),
        "journal_lines_window": len(rows),
    }


def livekit_events_block() -> dict:
    rows = journal_lines("livekit-server", since=LIVEKIT_EVENTS_WINDOW)
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


def sidecars_block(services: list[dict]) -> list[dict]:
    procs = sidecar_processes()
    listening = listening_unix_socks()
    now = time.time()
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
        last_connected_ms = None
        last_connected_mode = None
        unavailable_1h = 0
        try:
            since_s = max(now - LINK_WINDOW_CAP_S, (s["active_since_ms"] / 1000) - 5 if s.get("active_since_ms") else now - 86400)
            for t, line in journal_lines(unit, since=f"@{int(since_s)}"):
                m = SIDECAR_CONNECTED_RE.search(line)
                if m:
                    last_connected_ms = int(t * 1000)
                    last_connected_mode = m.group(1) or "healed"
                if t >= now - 3600 and SIDECAR_UNAVAILABLE_RE.search(line):
                    unavailable_1h += 1
        except Exception as e:  # noqa: BLE001
            note_error(f"sidecar journal {unit}", e)
        if proc and is_listening and unavailable_1h == 0:
            state = "ok"
        elif proc and is_listening:
            state = "degraded"
        else:
            state = "missing"
        rows.append({
            "unit": unit,
            "state": state,
            "sock": sock,
            "listening": is_listening,
            "pid": (proc or {}).get("pid"),
            "rss_bytes": (proc or {}).get("rss_bytes"),
            "age_s": (proc or {}).get("age_s"),
            "owner_unit": (proc or {}).get("unit"),
            "spawned_by_this_worker": bool(proc and proc.get("ppid") == pid),
            "shared_with": [u for u in sock_owner.get(sock, []) if u != unit],
            "last_connected_ms": last_connected_ms,
            "last_connected_mode": last_connected_mode,
            "unavailable_1h": unavailable_1h,
        })
    return rows


# ── 角色装配 ────────────────────────────────────────────────────────────────────

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


def legacy_worker_keys(snap: dict) -> None:
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
    max_jobs = None
    try:
        with open("/root/rust-worker/rust-worker.env", encoding="utf-8") as f:
            for line in f:
                if line.startswith("WORKER_MAX_JOBS="):
                    max_jobs = to_int(line.split("=", 1)[1])
    except OSError:
        pass
    snap["max_jobs"] = max_jobs if max_jobs is not None else 6


def main() -> None:
    role = None
    if len(sys.argv) >= 3 and sys.argv[1] == "--role":
        role = sys.argv[2]
    snap: dict = {"schema": "host-stats/1", "ts": int(time.time()), "collected_at_ms": int(time.time() * 1000)}
    try:
        snap["hostname"] = socket.gethostname()
    except Exception as e:  # noqa: BLE001
        note_error("hostname", e)
    snap["host"] = host_block()
    try:
        role = role or detect_role()
    except Exception as e:  # noqa: BLE001
        note_error("detect_role", e)
        role = "unknown"
    snap["role"] = role

    if role == "worker":
        snap["services"] = services_block(WORKER_UNITS)
        links = []
        for s in snap["services"]:
            try:
                links.append(worker_link_block(s["name"], s.get("active_since_ms")))
            except Exception as e:  # noqa: BLE001
                note_error(f"worker_link {s['name']}", e)
        try:
            snap["sidecars"] = sidecars_block(snap["services"])
        except Exception as e:  # noqa: BLE001
            note_error("sidecars", e)
            snap["sidecars"] = []
        lk_host = read_livekit_host()
        snap["connections"] = {
            "worker_links": links,
            "livekit_probe": tls_probe(lk_host) if lk_host else {"host": None, "error": "LIVEKIT_URL not found"},
        }
        legacy_worker_keys(snap)
    elif role == "livekit":
        snap["services"] = services_block(LIVEKIT_UNITS)
        conn: dict = {}
        try:
            conn["livekit"] = livekit_events_block()
        except Exception as e:  # noqa: BLE001
            note_error("livekit_events", e)
        conn["listen"] = listening_ports((443, 7880, 7881))
        conn["local_http"] = http_probe("http://127.0.0.1:7880/")
        snap["connections"] = conn
    elif role == "api":
        snap["services"] = services_block(API_UNITS)
        conn = {}
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

    snap["errors"] = errors
    snap["collect_ms"] = int(time.time() * 1000) - snap["collected_at_ms"]
    sys.stdout.write(json.dumps(snap, ensure_ascii=False, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001 - 最后防线：仍输出合法 JSON
        sys.stdout.write(json.dumps({"schema": "host-stats/1", "ts": int(time.time()), "role": "unknown", "errors": [f"fatal: {e}"]}) + "\n")
