#!/usr/bin/env python3
"""Install/check/roll back the local H daily gate using Codeg's public API.

Default is read-only --check. --apply leaves the new timer stopped unless the
operator explicitly supplies --enable-timer after accepting a manual run.
Never edits Codeg's database, runs the checker, or starts a model session.
"""
from __future__ import annotations

import argparse
import copy
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request


HOME_DIR = Path.home()
SOURCE = Path(__file__).resolve().parent
STATE = HOME_DIR / ".local/state/h-platform-daily-gate"
RUNTIME = HOME_DIR / ".local/libexec/h-platform-daily-gate"
WORKSPACE = HOME_DIR / ".local/share/h-platform-daily-ops/workspace"
CONFIG = HOME_DIR / ".config/h-platform-daily-gate.json"
UNITS = HOME_DIR / ".config/systemd/user"
TOKEN_FILE = HOME_DIR / ".local/share/codeg/token"
API_URL = "http://127.0.0.1:3080"
AUTO_ID = 4
OLD_TIMER = "h-platform-daily-ops.timer"
NEW_TIMER = "h-platform-daily-gate.timer"
NEW_SERVICE = "h-platform-daily-gate.service"
DRAFT_KEYS = (
    "name", "enabled", "trigger_kind", "cron", "timezone", "agent_type",
    "root_folder_id", "isolation", "branch", "is_remote_branch", "config",
)


class InstallError(Exception):
    pass


@contextmanager
def exclusive_lock(path: Path, conflict: str):
    """Nonblocking flock shared with the runner; close releases on every path."""
    flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags, 0o600)
    with os.fdopen(fd, "r+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise InstallError(conflict) from None
        yield


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def secure_dir(path: Path):
    if path.is_symlink():
        raise InstallError("安装目录不能是符号链接：" + str(path))
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.chmod(0o700)


def write_private(path: Path, value: bytes, *, first_only=False):
    """Write private artifacts atomically; immutable backups use O_EXCL."""
    if path.is_symlink():
        raise InstallError("安装文件不能是符号链接：" + str(path))
    if first_only:
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            path.chmod(0o600)
            return
        with os.fdopen(fd, "wb") as out:
            out.write(value)
            out.flush()
            os.fsync(out.fileno())
        return
    fd, name = tempfile.mkstemp(prefix=".install-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as out:
            out.write(value)
            out.flush()
            os.fsync(out.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def write_json(path: Path, value, *, first_only=False):
    write_private(path, (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode(),
                  first_only=first_only)


def api(command: str, payload=None):
    try:
        token = TOKEN_FILE.read_text(encoding="utf-8").strip()
        if not token:
            raise InstallError("Codeg 本机认证文件为空")
        request = urllib.request.Request(
            API_URL + "/api/" + command,
            data=json.dumps(payload or {}).encode(),
            headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
            method="POST",
        )
        # Do not inherit proxy settings for the authenticated loopback API.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        # Never echo response bodies, request headers, or tokens.
        raise InstallError(f"Codeg {command} 返回 HTTP {exc.code}；未打印响应内容") from None
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
        raise InstallError(f"Codeg {command} 调用未确认（{type(exc).__name__}）") from None


def systemctl(*args):
    result = subprocess.run(["systemctl", "--user", *args], capture_output=True,
                            text=True, timeout=45, check=False)
    if result.returncode:
        raise InstallError("systemctl --user " + " ".join(args) +
                           f" 失败（退出码 {result.returncode}，未回显日志）")
    return result.stdout


def unit_state(name):
    result = subprocess.run(
        ["systemctl", "--user", "show", name, "--property=LoadState,ActiveState,UnitFileState"],
        capture_output=True, text=True, timeout=15, check=False,
    )
    values = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
    if not values.get("LoadState"):
        raise InstallError("无法读取 systemd 单元状态：" + name)
    return values


def stop_timer(name):
    if unit_state(name).get("LoadState") != "not-found":
        systemctl("disable", "--now", name)


def draft_of(auto):
    try:
        return {key: copy.deepcopy(auto[key]) for key in DRAFT_KEYS}
    except KeyError as exc:
        raise InstallError("Codeg automation schema 缺少字段：" + str(exc)) from None


def require_idle():
    runs = api("automation_runs", {"automationId": AUTO_ID, "limit": 100})
    if any(run.get("status") in ("running", "queued", "pending") for run in runs):
        raise InstallError("ID4 正在运行；未取消它，请等待结束后重试")
    for service in (NEW_SERVICE, "h-platform-daily-ops.service"):
        if unit_state(service).get("ActiveState") in ("active", "activating", "deactivating"):
            raise InstallError(service + " 尚在运行；未中断它，请等待结束后重试")


def source_files():
    files = ["h_platform_daily_gate.py", "gate_policy.py", "lean/AGENTS.md",
             "lean/prompt.txt", "lean/rules.md", "systemd/" + NEW_SERVICE,
             "systemd/" + NEW_TIMER]
    if any(not (SOURCE / name).is_file() for name in files):
        raise InstallError("安装源文件尚未齐全；未执行安装")
    return files


def update_confirmed(draft):
    """A timed-out write may have committed: re-read, never blind retry."""
    uncertain = None
    try:
        api("automation_update", {"id": AUTO_ID, "draft": draft})
    except InstallError as exc:
        uncertain = str(exc)
    current = api("automation_get", {"id": AUTO_ID})
    if draft_of(current) != draft:
        suffix = "；" + uncertain if uncertain else ""
        raise InstallError("ID4 更新后回读不匹配；未重试写入" + suffix)
    return current


def workspace_folder_id():
    folders = api("list_all_folder_details")
    matches = [f for f in folders if f.get("path") == str(WORKSPACE)]
    if len(matches) == 1:
        return int(matches[0]["id"])
    if matches:
        raise InstallError("巡检 workspace 注册记录不唯一")
    try:
        folder = api("open_folder", {"path": str(WORKSPACE)})
    except InstallError:
        # Creation might have reached the server even if its reply was lost.
        matches = [f for f in api("list_all_folder_details") if f.get("path") == str(WORKSPACE)]
        if len(matches) != 1:
            raise InstallError("workspace 注册结果未确认；未盲重试 open_folder") from None
        folder = matches[0]
    if folder.get("path") != str(WORKSPACE):
        raise InstallError("workspace 注册返回了不匹配路径")
    return int(folder["id"])


def apply(enable_timer):
    source_files()
    require_idle()
    before = api("automation_get", {"id": AUTO_ID})
    if before.get("agent_type") != "codex":
        raise InstallError("ID4 agent_type 已不是 codex；未擅自更换引擎")
    original_path = STATE / "automation-before.json"
    timers_path = STATE / "timers-before.json"
    if original_path.exists():
        allowed = [draft_of(read_json(original_path))]
        managed = STATE / "automation-managed.json"
        if managed.exists():
            allowed.append(read_json(managed))
        if draft_of(before) not in allowed:
            raise InstallError("ID4 已有不属于本安装器的修改；未覆盖，需人工合并")
        if not timers_path.exists():
            raise InstallError("已有自动化备份但缺少计时器原态；停止以免伪造回滚依据")
    write_json(timers_path, {OLD_TIMER: unit_state(OLD_TIMER)}, first_only=True)
    write_json(original_path, before, first_only=True)
    # Stop every local clock before changing ID4. The Codeg schedule becomes
    # manual below. Any later error leaves local timers OFF, never two clocks.
    stop_timer(NEW_TIMER)
    stop_timer(OLD_TIMER)
    require_idle()
    secure_dir(RUNTIME)
    secure_dir(RUNTIME / "lean")
    secure_dir(WORKSPACE)
    UNITS.mkdir(parents=True, exist_ok=True)
    CONFIG.parent.mkdir(parents=True, exist_ok=True)
    for name in ("h_platform_daily_gate.py", "gate_policy.py"):
        write_private(RUNTIME / name, (SOURCE / name).read_bytes())
    for src in sorted((SOURCE / "lean").iterdir()):
        if src.is_file():
            write_private(RUNTIME / "lean" / src.name, src.read_bytes())
    write_private(WORKSPACE / "AGENTS.md", (SOURCE / "lean/AGENTS.md").read_bytes())
    for name in (NEW_SERVICE, NEW_TIMER):
        write_private(UNITS / name, (SOURCE / "systemd" / name).read_bytes())
    systemctl("daemon-reload")
    root_id = workspace_folder_id()
    prompt = (SOURCE / "lean/prompt.txt").read_text(encoding="utf-8")
    managed = draft_of(before)
    managed.update(enabled=True, trigger_kind="manual", cron=None,
                   root_folder_id=root_id, isolation="shared_in_root", branch=None,
                   is_remote_branch=False)
    managed["config"]["prompt_blocks"] = [{"type": "text", "text": prompt}]
    managed["config"]["display_text"] = "H 平台：固定只读采集，变化或告警时由 Luna 解读精简快照"
    managed["config"].setdefault("config_values", {})["model"] = "gpt-5.6-luna"
    labels = managed["config"].get("label_snapshot")
    if isinstance(labels, dict):
        labels["folder_label"] = "H 平台巡检"
    config = {
        "automation_id": AUTO_ID, "root_folder_id": root_id, "workspace": str(WORKSPACE),
        "state_dir": str(STATE),
        "memory_dir": str(HOME_DIR / ".claude/projects/-home-hahaxiong83-mycc/memory"),
        "wrapper": str(HOME_DIR / ".local/bin/daily-readonly-check"),
        "expected_prompt_sha256": hashlib.sha256(prompt.encode()).hexdigest(),
        "api_url": API_URL, "token_file": str(TOKEN_FILE),
    }
    # Save the intended draft before mutating the API, including the uncertain
    # reply case, so rollback always has a precise ownership comparison.
    write_json(STATE / "automation-managed.json", managed)
    write_json(CONFIG, config)
    after = update_confirmed(managed)
    if after.get("next_run_at") is not None:
        raise InstallError("ID4 仍有 next_run_at；新 timer 保持关闭")
    if unit_state(OLD_TIMER).get("ActiveState") == "active":
        raise InstallError("旧 timer 仍活跃；新 timer 保持关闭")
    if enable_timer:
        systemctl("enable", "--now", NEW_TIMER)
    print(json.dumps({"result": "installed", "automation_id": AUTO_ID,
                      "root_folder_id": root_id, "model": "gpt-5.6-luna",
                      "trigger_kind": "manual", "timer_enabled": bool(enable_timer),
                      "note": "默认不启时钟；请先手动验收 service，再启新 timer"}, ensure_ascii=False))


def restore_old_timer(saved):
    state = saved[OLD_TIMER]
    if state.get("LoadState") == "not-found":
        return
    enabled = state.get("UnitFileState")
    if enabled == "enabled":
        systemctl("enable", OLD_TIMER)
    elif enabled == "enabled-runtime":
        systemctl("enable", "--runtime", OLD_TIMER)
    elif enabled == "disabled":
        systemctl("disable", OLD_TIMER)
    else:
        raise InstallError("旧 timer 的原启用态不能自动恢复：" + str(enabled))
    if state.get("ActiveState") == "active":
        systemctl("start", OLD_TIMER)
    else:
        systemctl("stop", OLD_TIMER)


def rollback():
    # First ensure no future invocation can race the configuration restoration.
    stop_timer(NEW_TIMER)
    require_idle()
    if not (STATE / "automation-before.json").exists() or not (STATE / "timers-before.json").exists():
        raise InstallError("缺少首次原态备份；新 timer 已关闭，未猜测原配置")
    original = draft_of(read_json(STATE / "automation-before.json"))
    current = draft_of(api("automation_get", {"id": AUTO_ID}))
    managed_path = STATE / "automation-managed.json"
    managed = read_json(managed_path) if managed_path.exists() else None
    if current != original:
        if managed is None or current != managed:
            raise InstallError("ID4 已被他人修改；新 timer 已关闭，未覆盖，请人工合并后恢复")
        update_confirmed(original)
    stop_timer(OLD_TIMER)
    restore_old_timer(read_json(STATE / "timers-before.json"))
    print(json.dumps({"result": "rolled_back", "automation_id": AUTO_ID,
                      "new_timer": "disabled", "data_preserved": True}, ensure_ascii=False))


def check():
    auto = api("automation_get", {"id": AUTO_ID})
    managed_path = STATE / "automation-managed.json"
    matches = managed_path.exists() and draft_of(auto) == read_json(managed_path)
    folder = api("get_folder", {"folderId": auto["root_folder_id"]})
    timers = {name: unit_state(name) for name in (OLD_TIMER, NEW_TIMER)}
    problems = []
    if timers[NEW_TIMER].get("ActiveState") == "active":
        if timers[OLD_TIMER].get("ActiveState") == "active" or auto.get("next_run_at") is not None:
            problems.append("检测到不止一个每日时钟")
        if not matches:
            problems.append("新 timer 已启动，但 ID4 不匹配本安装器配置")
    if matches:
        if auto.get("next_run_at") is not None:
            problems.append("manual automation 仍有 next_run_at")
        if not CONFIG.exists():
            problems.append("缺少门控配置")
        for path in (STATE / "automation-before.json", STATE / "timers-before.json", CONFIG):
            if path.exists() and path.stat().st_mode & 0o077:
                problems.append("文件权限需限制为 0600：" + str(path))
    print(json.dumps({"automation_id": AUTO_ID, "matches_managed_draft": matches,
                      "trigger_kind": auto["trigger_kind"], "next_run_at": auto["next_run_at"],
                      "model": auto["config"].get("config_values", {}).get("model"),
                      "workspace": folder["path"], "config_exists": CONFIG.exists(),
                      "timers": timers,
                      "snapshot_exists": (STATE / "automation-before.json").exists(),
                      "problems": problems},
                     ensure_ascii=False, indent=2))
    return 1 if problems else 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument("--check", action="store_true")
    actions.add_argument("--apply", action="store_true")
    actions.add_argument("--rollback", action="store_true")
    parser.add_argument("--enable-timer", action="store_true",
                        help="only with --apply; explicitly enable the new daily clock")
    args = parser.parse_args(argv)
    if args.enable_timer and not args.apply:
        parser.error("--enable-timer 只能与 --apply 一起使用")
    try:
        if not (args.apply or args.rollback):
            return check()
        secure_dir(STATE)
        # Fixed order: installer lock, then the exact gate.lock used by run().
        # Covers direct CLI runs too, not only systemd-visible service states.
        # A conflict exits before require_idle/API/timer/config mutation.
        with exclusive_lock(STATE / "install.lock", "另一个安装/回滚正在进行"):
            with exclusive_lock(STATE / "gate.lock", "另一轮门控尚在运行；未等待、未中断它"):
                if args.apply:
                    apply(args.enable_timer)
                else:
                    rollback()
        return 0
    except (InstallError, OSError, ValueError, KeyError, subprocess.TimeoutExpired) as exc:
        # Only our own sanitized messages are exposed, never HTTP bodies or
        # subprocess output that might accidentally contain a credential.
        message = str(exc) if isinstance(exc, InstallError) else type(exc).__name__
        print("未完成：" + message + "。不要手动启第二个时钟；检查后可用 --rollback 恢复原态。",
              file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
