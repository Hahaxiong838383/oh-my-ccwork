#!/usr/bin/env python3
"""
xray 规则集自动更新脚本 — stdlib only
- 通过 xray mixed 代理（127.0.0.1:10808）从 GitHub 下载
- SHA256 对比，文件无变化时跳过替换和 reload
- 原子替换（write tmp → os.replace），保证文件完整性
- 普通安装更新后保持原 SIGHUP 行为；受管 cf-lisa 安装只更新磁盘并持久标记待验证
- 下载失败自动重试（3次，30s/60s 退避）
- 每次运行写 rule-updater.status JSON（供 xray-manager API 展示）
- 每次运行检查日志体积，超 50MB 自动轮转（保留 .1 备份）
"""

import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

XRAY_HOME = Path.home() / "xray"
PROXY = "http://127.0.0.1:10808"
TIMEOUT = 120       # seconds per download attempt
LOG_MAX_MB = 50     # rotate logs larger than this
RETRY_ATTEMPTS = 3
RETRY_DELAYS = [30, 60]  # seconds between retries 1→2 and 2→3

RULE_FILES = {
    "geosite.dat": "https://github.com/Loyalsoldier/v2ray-rules-dat/releases/latest/download/geosite.dat",
    "geoip.dat": "https://github.com/Loyalsoldier/v2ray-rules-dat/releases/latest/download/geoip.dat",
}

LOG_FILES_TO_ROTATE = ["access.log", "xray.log", "rule-updater.log"]


def log(msg):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def rotate_log(name, copytruncate=False):
    path = XRAY_HOME / name
    if not path.exists():
        return
    size_mb = path.stat().st_size / 1024 / 1024
    if size_mb > LOG_MAX_MB:
        backup = XRAY_HOME / f"{name}.1"
        if copytruncate:
            # Xray keeps its log fd open. Preserve its inode without restarting it.
            # Writes between the copy and truncate can be lost; no signal is sent.
            fd, tmp = tempfile.mkstemp(prefix=f".{name}.rotate-", dir=XRAY_HOME)
            try:
                with os.fdopen(fd, "wb") as snapshot, path.open("r+b") as current:
                    shutil.copyfileobj(current, snapshot)
                    snapshot.flush()
                    os.fsync(snapshot.fileno())
                    os.replace(tmp, backup)
                    current.truncate(0)
            finally:
                if os.path.exists(tmp):
                    os.unlink(tmp)
        else:
            shutil.move(str(path), str(backup))
        mode = "copytruncate" if copytruncate else "rename"
        log(f"rotate: {name} ({size_mb:.0f}MB) → {name}.1 ({mode})")


def get_xray_pid():
    try:
        result = subprocess.run(
            ["pgrep", "-f", "xray run"],
            capture_output=True, text=True, timeout=5,
        )
        pids = [p.strip() for p in result.stdout.strip().split() if p.strip()]
        if pids:
            return int(pids[0])
    except Exception:
        pass
    # fallback: ps aux
    try:
        result = subprocess.run(
            ["ps", "aux"],
            capture_output=True, text=True, timeout=5,
        )
        for line in result.stdout.splitlines():
            if "xray run" in line and "grep" not in line:
                parts = line.split()
                if len(parts) > 1:
                    return int(parts[1])
    except Exception:
        pass
    return None


def download_to_tmp(url, tmp_path):
    """Download url → tmp_path via xray proxy. Retries on failure. Returns bytes or 0."""
    proxy_handler = urllib.request.ProxyHandler({"http": PROXY, "https": PROXY})
    opener = urllib.request.build_opener(proxy_handler)
    req = urllib.request.Request(url, headers={"User-Agent": "xray-rule-updater/1.0"})

    for attempt in range(1, RETRY_ATTEMPTS + 1):
        try:
            with opener.open(req, timeout=TIMEOUT) as resp:
                data = resp.read()
            with open(tmp_path, "wb") as f:
                f.write(data)
            return len(data)
        except (urllib.error.URLError, OSError) as e:
            if attempt < RETRY_ATTEMPTS:
                delay = RETRY_DELAYS[attempt - 1]
                log(f"  下载失败（第 {attempt} 次）: {e}，{delay}s 后重试...")
                time.sleep(delay)
            else:
                log(f"  ERROR 下载失败（已重试 {RETRY_ATTEMPTS} 次）: {e}")
    return 0



def managed_controller_installed():
    """Installed markers are sufficient; broken metadata must not enable a restart."""
    return ((XRAY_HOME / "company-lisa-failover" / "controller.json").exists()
            or (XRAY_HOME.parent / "Library" / "LaunchAgents"
                / "com.company.lisa-failover.plist").exists())


def read_pending_update():
    """No PID-only auto-clear: it does not prove the main instance loaded these assets."""
    path = XRAY_HOME / "rule-updater.pending.json"
    try:
        pending = json.loads(path.read_text(encoding="utf-8"))
        if (not isinstance(pending, dict) or pending.get("version") != 1
                or pending.get("status") != "pending_until_verified"
                or not isinstance(pending.get("asset_sha256"), dict)):
            raise ValueError("invalid_pending_marker")
        return pending
    except FileNotFoundError:
        return None
    except (OSError, ValueError):
        return {"version": 1, "status": "pending_until_verified",
                "asset_sha256": {}, "marker_unreadable": True}


def mark_update_pending(name, asset_sha256, xray_pid):
    """Commit intent before replacing an asset; a failed marker write leaves it intact."""
    previous = read_pending_update() or {}
    now = datetime.now().isoformat(timespec="seconds")
    pending = {"version": 1, "status": "pending_until_verified",
               "first_pending_at": previous.get("first_pending_at", now),
               "last_updated_at": now,
               "asset_sha256": {**previous.get("asset_sha256", {}), name: asset_sha256},
               "xray_pid_before": xray_pid,
               "reason": "managed_controller_no_automatic_restart"}
    if previous.get("marker_unreadable"):
        pending["previous_marker_unreadable"] = True
    path = XRAY_HOME / "rule-updater.pending.json"
    fd, tmp = tempfile.mkstemp(prefix=".pending-rule-update-", dir=XRAY_HOME)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            os.fchmod(f.fileno(), 0o600)
            json.dump(pending, f, ensure_ascii=False, indent=2)
            f.write("\n"); f.flush(); os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def update_rule_file(name, url, defer_reload=False, xray_pid=None):
    """
    Download name from url, compare SHA256 with existing file.
    Atomically replace if changed. Returns (replaced: bool, error: str|None).
    """
    target = XRAY_HOME / name
    tmp = XRAY_HOME / f"{name}.tmp"
    backup = XRAY_HOME / f"{name}.bak"

    old_size = target.stat().st_size if target.exists() else 0
    old_sha = sha256_file(target) if target.exists() else ""

    log(f"{name}: 开始下载...")
    nbytes = download_to_tmp(url, tmp)
    if nbytes == 0:
        tmp.unlink(missing_ok=True)
        return False, "下载失败"

    try:
        new_sha = sha256_file(tmp)
        new_size = tmp.stat().st_size

        if new_sha == old_sha:
            log(f"{name}: no change (SHA256 same), skipped")
            return False, None

        if defer_reload:
            mark_update_pending(name, new_sha, xray_pid)

        if target.exists():
            shutil.copy2(target, backup)

        # 原子替换（tmp → target，tmp 之后不存在）
        os.replace(tmp, target)

        old_mb = old_size / 1024 / 1024
        new_mb = new_size / 1024 / 1024
        log(f"{name}: {old_mb:.1f}MB → {new_mb:.1f}MB, SHA256 changed, replaced")
        return True, None
    except Exception as e:
        return False, str(e)
    finally:
        tmp.unlink(missing_ok=True)  # no-op if os.replace already consumed it


def lint_config(config_path=None):
    """扫描 config.json 中 domain+ip 同条混写规则（AND 语义陷阱）。

    domain 与 ip 写在同一条规则里是 AND 语义（需同时满足才命中），且
    domainStrategy=AsIs 下域名流量不解析 IP → 含 ip 条件的规则对域名流量
    永不命中、静默失效（2026-07/08 两次事故根因，fn2 等自有域名绕道境外节点）。
    返回混写规则描述列表，空列表 = 干净。
    """
    path = config_path or (XRAY_HOME / "config.json")
    try:
        with open(path, encoding="utf-8") as f:
            cfg = json.load(f)
    except Exception as e:
        return [f"config.json 读取失败: {e}"]
    findings = []
    for i, r in enumerate(cfg.get("routing", {}).get("rules", [])):
        if r.get("domain") and r.get("ip"):
            findings.append(
                f"rules[{i}] (→{r.get('outboundTag') or r.get('balancerTag')}) "
                f"同时含 domain({len(r['domain'])}个)+ip({len(r['ip'])}个)：AND 语义，"
                f"对域名流量整条失效，须拆成两条独立规则"
            )
    return findings


def write_status(results, xray_pid_before, xray_pid_after, any_updated, lint_findings=None):
    has_error = any(r.get("error") for r in results.values())
    pending = read_pending_update()
    status = {
        "last_run": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "status": ("partial" if has_error else "pending_restart" if pending is not None
                   else "lint_warning" if lint_findings else "ok"),
        "pending_restart": pending is not None,
        "reload_status": "pending_until_verified" if pending is not None else "no_pending_record",
        "applied": False if pending is not None else None,
        "pending_update": pending,
        "any_updated": any_updated,
        "xray_pid_before": xray_pid_before,
        "xray_pid_after": xray_pid_after,
        "config_lint": lint_findings or [],
        "files": results,
    }
    status_path = XRAY_HOME / "rule-updater.status"
    tmp = XRAY_HOME / "rule-updater.status.tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(status, f, ensure_ascii=False, indent=2)
        os.replace(tmp, status_path)
    except OSError as e:
        log(f"WARNING: 写 status 文件失败: {e}")
    finally:
        if tmp.exists():
            tmp.unlink(missing_ok=True)


def main():
    log("=== xray rule-updater 开始 ===")

    managed = managed_controller_installed()
    for name in LOG_FILES_TO_ROTATE:
        rotate_log(name, copytruncate=managed and name in ("access.log", "xray.log"))

    lint_findings = lint_config()
    for w in lint_findings:
        log(f"⚠️ CONFIG-LINT: {w}")
    if not lint_findings:
        log("config-lint: 无 domain+ip 混写规则 ✓")

    xray_pid = get_xray_pid()
    if xray_pid is None:
        log("xray 进程未运行，跳过更新")
        write_status({}, None, None, False, lint_findings)
        sys.exit(0)

    log(f"xray PID: {xray_pid}")

    any_updated = False
    results = {}
    for name, url in RULE_FILES.items():
        try:
            replaced, err = update_rule_file(name, url, defer_reload=managed, xray_pid=xray_pid)
            results[name] = {"updated": replaced, "error": err}
            if replaced:
                any_updated = True
        except Exception as e:
            log(f"{name}: ERROR 意外异常: {e}")
            results[name] = {"updated": False, "error": str(e)}

    xray_pid_after = xray_pid
    if any_updated and managed:
        log("受管 cf-lisa：规则资源已更新到磁盘，未发送 SIGHUP、未重启 Xray；pending_until_verified")
    elif any_updated:
        try:
            os.kill(xray_pid, signal.SIGHUP)
            log(f"SIGHUP 已发送到 PID {xray_pid}，等待 xray 重启...")
            time.sleep(4)
            xray_pid_after = get_xray_pid()
            if xray_pid_after:
                log(f"xray 确认在运行 (当前 PID {xray_pid_after}，SIGHUP 前 PID {xray_pid})")
            else:
                log(f"WARNING: SIGHUP 后未检测到 xray 进程，可能重启失败，请手动检查")
        except ProcessLookupError:
            log(f"WARNING: xray PID {xray_pid} 已不存在，跳过 SIGHUP")
        except PermissionError:
            log(f"ERROR: 无权限向 PID {xray_pid} 发送 SIGHUP")
    else:
        log("所有规则文件无变化；已有 pending_until_verified 标记保持，未自动确认应用")
        if read_pending_update() is None:
            log("无待验证资源更新，无需 reload")

    write_status(results, xray_pid, xray_pid_after, any_updated, lint_findings)
    log("=== xray rule-updater 完成 ===")


if __name__ == "__main__":
    main()
