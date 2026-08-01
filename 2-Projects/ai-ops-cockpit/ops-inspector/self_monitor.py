import json
import os
import time
from datetime import datetime


HEALTHY_OMP_OUTCOMES = {"up_to_date", "updated", "cooling", "eligible", "candidate_validating"}


def nonnegative_int(value):
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def parse_timestamp(value):
    value = str(value or "").strip()
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        pass
    for pattern in ("%Y-%m-%d %H:%M:%S %Z", "%Y-%m-%d %H:%M:%S"):
        try:
            return time.mktime(time.strptime(value, pattern))
        except ValueError:
            continue
    return None


def summarize_audits(directory, now_epoch=None, window_seconds=86400):
    now_epoch = time.time() if now_epoch is None else now_epoch
    summary = {
        "readable": os.path.isdir(directory),
        "scannedFiles": 0,
        "records24h": 0,
        "allowed24h": 0,
        "blocked24h": 0,
        "secretExposure24h": 0,
        "malformedFiles": 0,
    }
    if not summary["readable"]:
        return summary
    for name in os.listdir(directory):
        if not name.endswith(".json"):
            continue
        summary["scannedFiles"] += 1
        try:
            with open(os.path.join(directory, name), encoding="utf-8") as file:
                record = json.load(file)
        except (OSError, ValueError, TypeError):
            summary["malformedFiles"] += 1
            continue
        created_epoch = parse_timestamp(record.get("createdAt"))
        if created_epoch is None or now_epoch - created_epoch > window_seconds or created_epoch > now_epoch + 300:
            continue
        summary["records24h"] += 1
        decision = record.get("decision")
        if decision == "allowed":
            summary["allowed24h"] += 1
        elif decision == "blocked":
            summary["blocked24h"] += 1
        summary["secretExposure24h"] += nonnegative_int(record.get("secretExposure"))
    return summary


def summarize_tasks(tasks, now_epoch=None, stale_seconds=900):
    now_epoch = time.time() if now_epoch is None else now_epoch
    active = []
    stale = []
    for task in tasks:
        if task.get("status") not in {"queued", "running", "aborting"}:
            continue
        active.append(task.get("id"))
        updated_epoch = parse_timestamp(task.get("updatedAt") or task.get("createdAt"))
        if updated_epoch is None or now_epoch - updated_epoch > stale_seconds:
            stale.append(task.get("id"))
    return {
        "activeCount": len(active),
        "staleCount": len(stale),
        "activeTaskIds": [item for item in active if item],
        "staleTaskIds": [item for item in stale if item],
        "staleSeconds": stale_seconds,
    }


def summarize_omp_update(state, now_epoch=None, max_age_seconds=129600):
    now_epoch = time.time() if now_epoch is None else now_epoch
    checked_epoch = parse_timestamp(state.get("checkedAt")) if isinstance(state, dict) else None
    age_seconds = None if checked_epoch is None else max(0, int(now_epoch - checked_epoch))
    outcome = state.get("outcome") if isinstance(state, dict) else None
    return {
        "ok": bool(outcome in HEALTHY_OMP_OUTCOMES and age_seconds is not None and age_seconds <= max_age_seconds),
        "outcome": outcome or "missing",
        "checkedAt": state.get("checkedAt") if isinstance(state, dict) else None,
        "ageSeconds": age_seconds,
        "maxAgeSeconds": max_age_seconds,
        "activeVersion": state.get("activeVersion") if isinstance(state, dict) else None,
        "latestVersion": state.get("latestVersion") if isinstance(state, dict) else None,
    }


def monitor_signature(report):
    failures = sorted(item["id"] for item in report.get("components", []) if not item.get("ok"))
    return json.dumps({"failures": failures}, sort_keys=True, separators=(",", ":"))


def transition_event(previous, current):
    if not previous:
        return "fault" if not current.get("ok") else None
    if previous.get("ok") is False and current.get("ok") is True:
        return "recovery"
    if current.get("ok") is False and previous.get("signature") != current.get("signature"):
        return "fault"
    return None
