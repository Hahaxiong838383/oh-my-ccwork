#!/usr/bin/env python3
from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import signal
import sqlite3
import subprocess
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


HOME = Path.home()
BASE = HOME / ".codex" / "account-switch"
TOOL = BASE / "bin" / "ccswap-studio"
LOG_PATH = BASE / "logs" / "guard.jsonl"
LOCK_PATH = BASE / "run" / "guard.lock"
PENDING_PATH = BASE / "run" / "pending-restart.json"
CONFIG_PATH = HOME / ".codex" / "config.toml"
TURNS_DB = HOME / ".codex" / "thread_history_1.sqlite"
QUEUE_DB = HOME / ".codex" / "queue_1.sqlite"
SOCKET_PATH = HOME / ".codex" / "app-server-control" / "app-server-control.sock"
TERMINAL_TURN_STATES = ("completed", "interrupted", "failed", "cancelled")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def atomic_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temp_name, 0o600)
        os.replace(temp_name, path)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


def log_event(event: str, **fields: Any) -> None:
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    if LOG_PATH.exists() and LOG_PATH.stat().st_size > 1_000_000:
        LOG_PATH.replace(LOG_PATH.with_suffix(".previous.jsonl"))
    payload = {"ts": utc_now(), "event": event, **fields}
    with LOG_PATH.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    os.chmod(LOG_PATH, 0o600)


def run_tool(arguments: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [str(TOOL), *arguments],
        text=True,
        capture_output=True,
        timeout=45,
        check=False,
    )


def list_payload() -> dict[str, Any]:
    result = run_tool(["codex", "list", "--json"])
    if result.returncode != 0:
        raise RuntimeError(f"ccswap list failed with exit {result.returncode}")
    return json.loads(result.stdout)


def active_slot() -> int:
    slot = list_payload().get("activeAccountNumber")
    if not isinstance(slot, int):
        raise RuntimeError("no active Codex account")
    return slot


def config_is_official_file_auth() -> bool:
    text = CONFIG_PATH.read_text(encoding="utf-8")
    provider = re.search(r'^\s*model_provider\s*=\s*"([^"]+)"', text, re.MULTILINE)
    store = re.search(r'^\s*cli_auth_credentials_store\s*=\s*"([^"]+)"', text, re.MULTILINE)
    return bool(provider and provider.group(1) == "openai" and store and store.group(1) == "file")


def cc_switch_running() -> bool:
    result = subprocess.run(
        ["ps", "ax", "-o", "command="], text=True, capture_output=True, check=True
    )
    for command in result.stdout.splitlines():
        lowered = command.lower()
        if "cc-switch" in lowered or "ccswitch" in lowered:
            if "codex-account-guard" not in lowered:
                return True
    return False


def workload() -> tuple[int, int]:
    active = 0
    queued = 0
    if TURNS_DB.exists():
        placeholders = ",".join("?" for _ in TERMINAL_TURN_STATES)
        with sqlite3.connect(TURNS_DB) as database:
            active = int(
                database.execute(
                    f"SELECT COUNT(*) FROM thread_turns WHERE status NOT IN ({placeholders})",
                    TERMINAL_TURN_STATES,
                ).fetchone()[0]
            )
    if QUEUE_DB.exists():
        with sqlite3.connect(QUEUE_DB) as database:
            queued = int(database.execute("SELECT COUNT(*) FROM queued_items").fetchone()[0])
    return active, queued


def process_state(pid: int) -> str:
    result = subprocess.run(
        ["ps", "-o", "stat=", "-p", str(pid)],
        text=True,
        capture_output=True,
        check=False,
    )
    return result.stdout.strip()


def app_server_socket_owners() -> set[int]:
    if not SOCKET_PATH.exists():
        return set()
    result = subprocess.run(
        ["lsof", "-t", str(SOCKET_PATH)],
        text=True,
        capture_output=True,
        check=False,
    )
    owners: set[int] = set()
    for raw in result.stdout.splitlines():
        if not raw.isdigit():
            continue
        pid = int(raw)
        command = subprocess.run(
            ["ps", "-o", "command=", "-p", str(pid)],
            text=True,
            capture_output=True,
            check=False,
        ).stdout.strip()
        if "app-server" in command and "--listen" in command and not process_state(pid).startswith("Z"):
            owners.add(pid)
    return owners


def restart_app_server() -> dict[str, Any]:
    before = app_server_socket_owners()
    if not before:
        return {"result": "no-running-server", "oldPids": []}

    for pid in sorted(before):
        os.kill(pid, signal.SIGTERM)

    deadline = time.time() + 12
    while time.time() < deadline:
        remaining = {
            pid
            for pid in before
            if process_state(pid) and not process_state(pid).startswith("Z")
        }
        if not remaining:
            break
        time.sleep(0.5)
    else:
        for pid in sorted(remaining):
            os.kill(pid, signal.SIGKILL)

    deadline = time.time() + 30
    while time.time() < deadline:
        after = app_server_socket_owners() - before
        if after:
            return {
                "result": "reconnected",
                "oldPids": sorted(before),
                "newPids": sorted(after),
            }
        time.sleep(0.5)

    if app_server_socket_owners() & before:
        raise RuntimeError("old app-server still owns the control socket")
    return {
        "result": "ready-for-next-connection",
        "oldPids": sorted(before),
        "newPids": [],
    }


def sanitized_events(stdout: str) -> list[dict[str, Any]]:
    safe: list[dict[str, Any]] = []
    for line in stdout.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        kind = event.get("event")
        if kind == "poll":
            active = event.get("active") or {}
            safe.append(
                {
                    "event": "poll",
                    "activeSlot": active.get("number"),
                    "headroomPct": event.get("headroomPct", {}),
                    "threshold": event.get("threshold"),
                    "fetchErrors": event.get("fetchErrors", {}),
                }
            )
        elif kind == "switch":
            safe.append(
                {
                    "event": "switch",
                    "trigger": event.get("trigger"),
                    "fromSlot": (event.get("from") or {}).get("number"),
                    "toSlot": (event.get("to") or {}).get("number"),
                    "dryRun": bool(event.get("dryRun")),
                }
            )
        elif kind in {"no-switch", "all-exhausted"}:
            safe.append(
                {
                    "event": kind,
                    "reason": event.get("reason"),
                    "detail": event.get("detail"),
                    "earliestResetAt": event.get("earliestResetAt"),
                }
            )
        elif kind == "error":
            safe.append({"event": "error"})
    return safe


def switch_back(slot: int) -> None:
    result = run_tool(["codex", "switch", str(slot), "--json"])
    if result.returncode != 0:
        raise RuntimeError(f"rollback to slot {slot} failed")


def handle_pending() -> bool:
    if not PENDING_PATH.exists():
        return False
    active, queued = workload()
    if active or queued:
        log_event("restart-deferred", activeTurns=active, queuedItems=queued)
        return True
    restart = restart_app_server()
    PENDING_PATH.unlink(missing_ok=True)
    log_event("pending-restart-complete", **restart, activeSlot=active_slot())
    return True


def main() -> int:
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--apply", action="store_true")
    mode.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    os.umask(0o077)
    LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
    with LOCK_PATH.open("a+", encoding="utf-8") as lock_handle:
        try:
            fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0

        if not TOOL.is_file() or not config_is_official_file_auth():
            log_event("blocked", reason="official-file-auth-required")
            return 1
        if cc_switch_running():
            log_event("blocked", reason="cc-switch-running")
            return 1
        if handle_pending():
            return 0

        active, queued = workload()
        if active or queued:
            log_event("busy", activeTurns=active, queuedItems=queued)
            return 0

        old_slot = active_slot()
        arguments = [
            "codex",
            "auto",
            "--once",
            "--json",
            "--threshold",
            "90",
            "--cooldown",
            "300",
        ]
        if not args.apply:
            arguments.append("--dry-run")
        result = run_tool(arguments)
        events = sanitized_events(result.stdout)
        log_event(
            "evaluation",
            mode="apply" if args.apply else "dry-run",
            exitCode=result.returncode,
            events=events,
        )

        if result.returncode != 0:
            return 0 if result.returncode in {2, 3} else 1
        if not args.apply:
            return 0

        new_slot = active_slot()
        if new_slot == old_slot:
            return 0

        atomic_json(
            PENDING_PATH,
            {"createdAt": utc_now(), "oldSlot": old_slot, "newSlot": new_slot},
        )
        active, queued = workload()
        if active or queued:
            log_event(
                "switch-complete-restart-deferred",
                oldSlot=old_slot,
                newSlot=new_slot,
                activeTurns=active,
                queuedItems=queued,
            )
            return 0

        try:
            restart = restart_app_server()
            PENDING_PATH.unlink(missing_ok=True)
            log_event("switch-complete", oldSlot=old_slot, newSlot=new_slot, **restart)
            return 0
        except Exception as exc:
            log_event(
                "restart-failed",
                oldSlot=old_slot,
                newSlot=new_slot,
                errorType=type(exc).__name__,
            )
            switch_back(old_slot)
            restart = restart_app_server()
            PENDING_PATH.unlink(missing_ok=True)
            log_event("rollback-complete", activeSlot=old_slot, **restart)
            return 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        log_event("fatal", errorType=type(exc).__name__)
        raise
