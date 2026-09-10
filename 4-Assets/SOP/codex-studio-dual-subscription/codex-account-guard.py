#!/usr/bin/env python3
from __future__ import annotations

import argparse
import fcntl
import json
import math
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
UPSTREAM_AUTOSWITCH_STATE_PATH = (
    BASE / "home" / ".claude-swap-backup" / "codex_autoswitch_state.json"
)
LOW_HEADROOM_STATE_PATH = BASE / "run" / "low-headroom-state.json"
LOW_HEADROOM_THRESHOLD_PCT = 90.0
LOW_HEADROOM_EXHAUSTED_PCT = 100.0
LOW_HEADROOM_HYSTERESIS_PCT = 1.0
LOW_HEADROOM_COOLDOWN_SECONDS = 300.0
APP_SERVER_RECOVERY_GRACE_SECONDS = 300.0
APP_SERVER_CLOCK_SKEW_SECONDS = 60.0
NO_APP_SERVER_ACTIVE_WINDOW_SECONDS = 300.0


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


def active_slot(payload: dict[str, Any] | None = None) -> int:
    slot = (payload or list_payload()).get("activeAccountNumber")
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


def parse_elapsed_seconds(value: str) -> float | None:
    value = value.strip()
    if not value:
        return None
    days = 0
    if "-" in value:
        raw_days, value = value.split("-", 1)
        if not raw_days.isdigit():
            return None
        days = int(raw_days)
    fields = value.split(":")
    if len(fields) == 2:
        hours = "0"
        minutes, seconds = fields
    elif len(fields) == 3:
        hours, minutes, seconds = fields
    else:
        return None
    if not all(field.isdigit() for field in (hours, minutes, seconds)):
        return None
    return float(
        days * 86400 + int(hours) * 3600 + int(minutes) * 60 + int(seconds)
    )


def process_started_at(pid: int) -> float | None:
    result = subprocess.run(
        ["ps", "-o", "etime=", "-p", str(pid)],
        text=True,
        capture_output=True,
        check=False,
    )
    elapsed = parse_elapsed_seconds(result.stdout)
    if elapsed is None:
        return None
    return time.time() - elapsed


def active_turn_cutoff_ms() -> int | None:
    now = time.time()
    starts = [
        started_at
        for pid in app_server_socket_owners()
        if (started_at := process_started_at(pid)) is not None
    ]
    if not starts:
        return int((now - NO_APP_SERVER_ACTIVE_WINDOW_SECONDS) * 1000)
    server_started_at = min(starts)
    if now - server_started_at < APP_SERVER_RECOVERY_GRACE_SECONDS:
        return None
    return int((server_started_at - APP_SERVER_CLOCK_SKEW_SECONDS) * 1000)


def turn_counts(path: Path, cutoff_ms: int | None) -> tuple[int, int]:
    placeholders = ",".join("?" for _ in TERMINAL_TURN_STATES)
    with sqlite3.connect(path) as database:
        total = int(
            database.execute(
                f"SELECT COUNT(*) FROM thread_turns "
                f"WHERE status NOT IN ({placeholders})",
                TERMINAL_TURN_STATES,
            ).fetchone()[0]
        )
        if cutoff_ms is None:
            return total, 0
        active = int(
            database.execute(
                f"SELECT COUNT(*) FROM thread_turns AS turn "
                f"WHERE turn.status NOT IN ({placeholders}) "
                "AND (turn.started_at IS NULL OR turn.started_at * 1000 >= ? "
                "OR EXISTS (SELECT 1 FROM thread_items AS item "
                "WHERE item.thread_id = turn.thread_id "
                "AND item.turn_id = turn.turn_id "
                "AND item.created_at_ms >= ?))",
                (*TERMINAL_TURN_STATES, cutoff_ms, cutoff_ms),
            ).fetchone()[0]
        )
    return active, total - active


def workload() -> tuple[int, int, int]:
    active = 0
    queued = 0
    stale = 0
    if TURNS_DB.exists():
        active, stale = turn_counts(TURNS_DB, active_turn_cutoff_ms())
    if QUEUE_DB.exists():
        with sqlite3.connect(QUEUE_DB) as database:
            queued = int(database.execute("SELECT COUNT(*) FROM queued_items").fetchone()[0])
    return active, queued, stale


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


def parsed_events(stdout: str) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for line in stdout.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict):
            events.append(event)
    return events


def sanitized_events(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    safe: list[dict[str, Any]] = []
    for event in events:
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


def low_headroom_plan(
    listing: dict[str, Any], events: list[dict[str, Any]]
) -> dict[str, Any] | None:
    active = active_slot(listing)
    enabled_slots = {
        account.get("number")
        for account in listing.get("accounts", [])
        if isinstance(account, dict)
        and isinstance(account.get("number"), int)
        and not account.get("disabled")
    }
    if active not in enabled_slots or len(enabled_slots) < 2:
        return None

    poll = next((event for event in events if event.get("event") == "poll"), None)
    if not poll:
        return None
    raw_headroom = poll.get("headroomPct")
    if not isinstance(raw_headroom, dict):
        return None

    headroom: dict[int, float] = {}
    for slot in enabled_slots:
        value = raw_headroom.get(str(slot), raw_headroom.get(slot))
        if not isinstance(value, (int, float)) or not math.isfinite(float(value)):
            return None
        headroom[slot] = float(value)

    if not all(
        LOW_HEADROOM_EXHAUSTED_PCT - value >= LOW_HEADROOM_THRESHOLD_PCT
        for value in headroom.values()
    ):
        return None

    safe_headroom = {str(slot): round(value, 4) for slot, value in headroom.items()}
    viable = {slot: value for slot, value in headroom.items() if value > 0}
    if not viable:
        exhausted = next(
            (event for event in events if event.get("event") == "all-exhausted"),
            {},
        )
        return {
            "action": "exhausted",
            "activeSlot": active,
            "headroomPct": safe_headroom,
            "earliestResetAt": exhausted.get("earliestResetAt"),
        }

    target = max(
        viable,
        key=lambda slot: (viable[slot], slot == active, -slot),
    )
    advantage = viable[target] - headroom[active]
    if target == active or (
        headroom[active] > 0 and advantage < LOW_HEADROOM_HYSTERESIS_PCT
    ):
        return {
            "action": "hold",
            "activeSlot": active,
            "targetSlot": target,
            "advantagePct": round(max(advantage, 0.0), 4),
            "headroomPct": safe_headroom,
        }
    return {
        "action": "switch",
        "activeSlot": active,
        "targetSlot": target,
        "advantagePct": round(advantage, 4),
        "headroomPct": safe_headroom,
        "bypassCooldown": headroom[active] <= 0,
    }


def last_switch_at() -> float | None:
    timestamps: list[float] = []
    for path in (UPSTREAM_AUTOSWITCH_STATE_PATH, LOW_HEADROOM_STATE_PATH):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            continue
        value = payload.get("lastSwitchAt")
        if isinstance(value, (int, float)) and math.isfinite(float(value)):
            timestamps.append(float(value))
    return max(timestamps, default=None)


def low_headroom_cooldown_remaining() -> float:
    switched_at = last_switch_at()
    if switched_at is None:
        return 0.0
    return max(0.0, LOW_HEADROOM_COOLDOWN_SECONDS - (time.time() - switched_at))


def switch_to(slot: int) -> None:
    result = run_tool(["codex", "switch", str(slot), "--json"])
    if result.returncode != 0 or active_slot() != slot:
        raise RuntimeError(f"switch to slot {slot} failed")


def switch_back(slot: int) -> None:
    switch_to(slot)


def handle_pending() -> bool:
    if not PENDING_PATH.exists():
        return False
    active, queued, stale = workload()
    if active or queued:
        log_event(
            "restart-deferred",
            activeTurns=active,
            queuedItems=queued,
            staleTurnsIgnored=stale,
        )
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

        active, queued, stale = workload()
        if active or queued:
            log_event(
                "busy",
                activeTurns=active,
                queuedItems=queued,
                staleTurnsIgnored=stale,
            )
            return 0

        listing = list_payload()
        old_slot = active_slot(listing)
        probe_arguments = [
            "codex",
            "auto",
            "--once",
            "--json",
            "--threshold",
            "90",
            "--cooldown",
            "300",
            "--dry-run",
        ]
        probe = run_tool(probe_arguments)
        raw_events = parsed_events(probe.stdout)
        events = sanitized_events(raw_events)
        low_plan = low_headroom_plan(listing, raw_events)
        log_event(
            "evaluation",
            mode="apply" if args.apply else "dry-run",
            exitCode=probe.returncode,
            events=events,
            lowHeadroom=low_plan,
            staleTurnsIgnored=stale,
        )

        if probe.returncode not in {0, 2, 3}:
            return 1

        if low_plan is not None:
            if low_plan["action"] != "switch" or not args.apply:
                return 0
            cooldown = low_headroom_cooldown_remaining()
            if cooldown > 0 and not low_plan.get("bypassCooldown"):
                log_event(
                    "low-headroom-held",
                    reason="cooldown",
                    remainingSeconds=round(cooldown, 1),
                    activeSlot=old_slot,
                    targetSlot=low_plan["targetSlot"],
                )
                return 0
            switch_to(low_plan["targetSlot"])
            atomic_json(
                LOW_HEADROOM_STATE_PATH,
                {
                    "lastSwitchAt": time.time(),
                    "fromSlot": old_slot,
                    "toSlot": low_plan["targetSlot"],
                },
            )
            log_event(
                "low-headroom-switch",
                oldSlot=old_slot,
                newSlot=low_plan["targetSlot"],
                advantagePct=low_plan["advantagePct"],
            )
        else:
            if not args.apply:
                return 0
            if not any(event.get("event") == "switch" for event in raw_events):
                return 0
            apply_arguments = [argument for argument in probe_arguments if argument != "--dry-run"]
            result = run_tool(apply_arguments)
            log_event(
                "application",
                exitCode=result.returncode,
                events=sanitized_events(parsed_events(result.stdout)),
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
        active, queued, stale = workload()
        if active or queued:
            log_event(
                "switch-complete-restart-deferred",
                oldSlot=old_slot,
                newSlot=new_slot,
                activeTurns=active,
                queuedItems=queued,
                staleTurnsIgnored=stale,
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
