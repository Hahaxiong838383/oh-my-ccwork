"""Pure, fail-open change gate for the H platform schema-2 probe.

No I/O, mutation, subprocesses, or model calls live here. Untrusted probe text is
data only. Raw probe severity is preserved; known test differences are never
silently rewritten to OK. The caller owns report freshness validation.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import math
import re
from collections import Counter
from typing import Any


POLICY_VERSION = 1
REMINDER_DAYS = 7
LEVELS = ("critical", "warning", "info")
KNOWN_CODES = frozenset({
    "probe_error", "control_not_ok", "token_sweep", "token_sweep_stale",
    "control_tunnel", "control_release_drift", "service_bridge",
    "service_runner", "service_xray", "timer_tenantParity",
    "timer_sqliteMaintenance", "timer_workerNightly", "execution_health",
    "apps_disconnected", "app_errors", "contract_split", "outbox_pending",
    "runner_worker", "egress_down", "egress_gate_off", "egress_probe_missing",
    "rpc_orphaned", "rpc_orphaned_stale", "orphan_recovery_pending",
    "durable_store", "execution_deploy_dirty", "worker_restart_pending",
    "tenant_audit_failed", "tenant_parity_lag", "tenant_parity_notes",
    "memory_audit_failed", "memory_bad", "grok_refresh_failed", "failed_unit",
    "disk_full", "journal_errors",
})
PROBE_FAILURE_CODES = frozenset({
    "probe_error", "execution_health", "tenant_audit_failed", "memory_audit_failed",
})
KNOWN_INFO = frozenset({"tenant_parity_notes", "worker_restart_pending", "egress_gate_off"})
VOLATILE_KEYS = frozenset({
    "ageH", "ageMs", "checkedAt", "fingerprint", "lastReportAt", "lastOpAt",
    "lastErrorAt", "lastInboundAt", "lastOutboundOkAt", "downSince", "lastOkAt",
    "lastSweepAt", "startedAt", "updatedAt", "createdAt", "firstSeenAt",
    "consecutiveFails", "durationMs", "elapsedMs",
})
SUMMARY_KEYS = (
    "controlVersion", "controlUsers", "controlRelease", "executionCommit",
    "apps", "connected", "errorApps", "rpcOrphaned", "egressOk",
    "rpcOrphanSource", "parityUserLag", "parityUserNotes", "memoryChecked", "memoryBad",
)
COUNT_KEYS = (
    "controlUsers", "apps", "connected", "errorApps", "rpcOrphaned",
    "parityUserLag", "parityUserNotes", "memoryChecked", "memoryBad",
)
TEST_UID = "u-001422f6e5"
TEST_BOT = "陈川测试bot"


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _count(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _time(value: Any) -> dt.datetime | None:
    if not isinstance(value, str):
        return None
    try:
        result = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        return result.astimezone(dt.timezone.utc) if result.tzinfo else None
    except (ValueError, OverflowError):
        return None


def _scrub(value: Any) -> Any:
    """Drop sampled clocks/ages while preserving identities and actual content."""
    if isinstance(value, dict):
        return {str(k): _scrub(v) for k, v in value.items() if k not in VOLATILE_KEYS}
    if isinstance(value, list):
        return sorted((_scrub(v) for v in value), key=_json)
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    return str(type(value).__name__)


def _age_band(details: dict, checked_at: dt.datetime | None) -> str:
    at = _time(details.get("lastErrorAt"))
    if at is not None and checked_at is not None:
        hours = (checked_at - at).total_seconds() / 3600
    else:
        hours = details.get("ageH")
        if not isinstance(hours, (int, float)) or isinstance(hours, bool):
            return "unknown"
    if not math.isfinite(hours) or hours < 0:
        return "unknown"
    return "lt24h" if hours < 24 else "gte24h"


def _version(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    found = re.search(r"(?:^|[-/])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$", value)
    return found.group(1) if found else None


def _is_known_test(details: dict) -> bool:
    users = details.get("users")
    if details.get("platformLags") != [] or not isinstance(users, list) or len(users) != 1:
        return False
    user = users[0]
    if not isinstance(user, dict) or user.get("uid") != TEST_UID or user.get("bot") != TEST_BOT:
        return False
    lags = user.get("lags")
    # Only the exact test tenant/skill shell is intentional. Same-name bots,
    # missing iron rules, attachments, frozen follow-up, or extra lags are not.
    return (
        isinstance(lags, list) and len(lags) == 1 and isinstance(lags[0], str)
        and re.fullmatch(
            rf"user:{re.escape(TEST_UID)}/agent-method: fork 正文 \d+ 字 vs 共享版 \d+ 字"
            r"（疑似同名空壳遮蔽，需人工核）", lags[0],
        ) is not None
    )


def _recovery(details: dict, unknown: list[str]) -> dict:
    total, live, unconfirmed = (details.get(k) for k in ("total", "live", "liveUnknown"))
    if not all(_count(v) for v in (total, live, unconfirmed)):
        unknown.append("recovery_counts_missing_or_invalid")
        return {"total": total, "live": live, "liveUnknown": unconfirmed,
                "candidates": None, "pending": None, "unknown": True}
    if live + unconfirmed > total:
        unknown.append("recovery_counts_inconsistent")
        return {"total": total, "live": live, "liveUnknown": unconfirmed,
                "candidates": None, "pending": None, "unknown": True}
    if unconfirmed:
        unknown.append("recovery_live_unconfirmed")
    return {"total": total, "live": live, "liveUnknown": unconfirmed,
            "candidates": total - live, "pending": total - live - unconfirmed,
            "unknown": bool(unconfirmed)}


def analyze(report: dict) -> dict:
    """Return raw levels, normalized facts and a noise-resistant signature.

    unknown, actionable and known are lists. effectiveCritical is a count,
    never lower than the raw critical count. Complete nonzero critical probe
    reports remain reports, rather than being mislabeled as collection failure.
    """
    unknown: list[str] = []
    actionable: list[dict] = []
    known: list[dict] = []
    normalized: list[dict] = []
    recoveries: list[dict] = []
    stable_issues: list[dict] = []
    if not isinstance(report, dict):
        report = {}
        unknown.append("report_not_object")
    raw_status = report.get("status")
    if report.get("schemaVersion") != 2:
        unknown.append("unsupported_schema")
    checked_at = _time(report.get("checkedAt"))
    if checked_at is None:
        unknown.append("checkedAt_missing_or_invalid")
    if report.get("reportError"):
        unknown.append("report_error")
    issues = report.get("issues")
    if not isinstance(issues, list):
        unknown.append("issues_not_list")
        issues = []
    if "issueCount" in report and report["issueCount"] != len(issues):
        unknown.append("issue_count_mismatch")
    summary = report.get("summary")
    if not isinstance(summary, dict):
        unknown.append("summary_not_object")
        summary = {}
    for key in COUNT_KEYS:
        if not _count(summary.get(key)):
            unknown.append(f"summary_{key}_missing_or_invalid")
    if summary.get("egressOk") not in (True, False) or type(summary.get("egressOk")) is not bool:
        unknown.append("egress_unconfirmed")
    for key in ("controlVersion", "executionCommit"):
        if not isinstance(summary.get(key), str) or not summary[key]:
            unknown.append(f"summary_{key}_missing_or_invalid")
    if not isinstance(summary.get("controlRelease"), dict):
        unknown.append("control_release_missing")
    else:
        release = summary["controlRelease"]
        if not isinstance(release.get("state"), str) or not _count(release.get("mismatchCount")):
            unknown.append("control_release_incomplete")
    observed = Counter({level: 0 for level in LEVELS})
    effective = Counter({level: 0 for level in LEVELS})
    stable_levels = Counter({level: 0 for level in LEVELS})
    stable_effective = Counter({level: 0 for level in LEVELS})
    probe_failed = bool(report.get("reportError"))
    for index, item in enumerate(issues):
        if not isinstance(item, dict):
            unknown.append(f"issue_{index}_not_object")
            continue
        code, level = item.get("code"), item.get("level")
        if not isinstance(code, str) or code not in KNOWN_CODES:
            unknown.append(f"unknown_code:{code}" if isinstance(code, str) else "issue_code_invalid")
        if not isinstance(code, str):
            code = "<invalid>"
        if level not in LEVELS:
            unknown.append(f"issue_level_invalid:{index}")
            level = "unknown"
        observed[level] += 1
        details = item.get("details")
        fact = {"code": code, "level": level, "effectiveLevel": level,
                "message": str(item.get("message") or ""), "details": _scrub(details)}
        stable_fact = {"code": code, "level": level, "effectiveLevel": level}
        if isinstance(details, (dict, list)):
            stable_fact["details"] = _scrub(details)
        else:
            stable_fact["message"] = fact["message"]
        is_known, exclude_stable = False, False
        if code in PROBE_FAILURE_CODES:
            probe_failed = True
        if code == "control_release_drift":
            if not isinstance(details, dict):
                unknown.append("control_release_details_missing")
            else:
                a, b = _version(details.get("releaseId")), _version(details.get("controlVersion"))
                if not a or not b:
                    unknown.append("control_release_version_unconfirmed")
                if details.get("state") == "drifted" and a is not None and a == b:
                    fact["effectiveLevel"] = stable_fact["effectiveLevel"] = "critical"
                    fact["escalation"] = "same_version_control_release_drift"
        elif code == "app_errors":
            if not isinstance(details, dict):
                unknown.append("app_error_details_missing")
            else:
                band = _age_band(details, checked_at)
                fact["ageBand"] = stable_fact["ageBand"] = band
                if band == "unknown":
                    unknown.append("app_error_age_unconfirmed")
                if not (details.get("uid") or details.get("botName")):
                    unknown.append("app_error_identity_unconfirmed")
                # Defensively escalate a wrongly lowered recent non-tenant
                # error. Never downgrade a raw critical report here.
                if details.get("class") not in ("quota_window", "auth") and band == "lt24h":
                    fact["effectiveLevel"] = stable_fact["effectiveLevel"] = "critical"
        elif code == "orphan_recovery_pending":
            recovery = _recovery(details if isinstance(details, dict) else {}, unknown)
            recoveries.append(recovery)
            fact["recovery"] = recovery
            is_known = recovery["pending"] == 0 and recovery["unknown"] is False
            exclude_stable = is_known and level == "info"
            stable_fact["details"] = {k: recovery[k] for k in ("pending", "liveUnknown", "unknown")}
            stable_fact.pop("message", None)
        elif code == "tenant_parity_lag":
            is_known = isinstance(details, dict) and level == "warning" and _is_known_test(details)
            if not isinstance(details, dict) or not isinstance(details.get("users"), list) or not isinstance(details.get("platformLags"), list):
                unknown.append("parity_lag_details_incomplete")
        elif code == "tenant_parity_notes":
            users = details.get("users") if isinstance(details, dict) else None
            if not isinstance(users, list) or not all(
                isinstance(u, dict) and isinstance(u.get("notes"), list)
                and bool(u.get("uid") or u.get("bot")) for u in users
            ):
                unknown.append("parity_notes_details_incomplete")
            is_known = level == "info"
        elif code in KNOWN_INFO:
            is_known = level == "info"
        elif code == "egress_probe_missing":
            unknown.append("egress_probe_missing")
        if fact["effectiveLevel"] == "critical":
            is_known = False
        fact["classification"] = "known" if is_known else "actionable"
        (known if is_known else actionable).append(fact)
        normalized.append(fact)
        effective[fact["effectiveLevel"]] += 1
        if not exclude_stable:
            stable_issues.append(stable_fact)
            stable_levels[level] += 1
            stable_effective[fact["effectiveLevel"]] += 1

    raw_levels = report.get("levels")
    if not isinstance(raw_levels, dict) or any(
        not _count(raw_levels.get(level)) or raw_levels[level] != observed[level]
        for level in LEVELS
    ) or (isinstance(raw_levels, dict) and set(raw_levels) - set(LEVELS)):
        unknown.append("level_counts_mismatch_or_missing")
    expected = "CRITICAL" if observed["critical"] else "WARNING" if observed["warning"] else "OK"
    if raw_status != expected:
        unknown.append("status_inconsistent")
    service_exit = report.get("serviceExit", 0)
    if not _count(service_exit) or (service_exit != 0 and raw_status != "CRITICAL"):
        probe_failed = True
        unknown.append("unexpected_service_exit")
    if report.get("ok") is False and raw_status != "CRITICAL":
        probe_failed = True
        unknown.append("probe_not_ok")
    if "ok" in report and not isinstance(report["ok"], bool):
        unknown.append("probe_ok_invalid")
    if summary.get("egressOk") is False and not any(i.get("code") == "egress_down" for i in normalized):
        # Gate-off observations may intentionally report only info. Still
        # require model explanation every day while the observed path is down.
        unknown.append("egress_false_without_critical")
    unknown = sorted(set(unknown))
    stable = {
        "policyVersion": POLICY_VERSION, "rawStatus": raw_status,
        "levels": dict(stable_levels), "effectiveLevels": dict(stable_effective),
        "issues": sorted(stable_issues, key=_json),
        "summary": {key: _scrub(summary.get(key)) for key in SUMMARY_KEYS},
        "unknown": unknown, "probeFailed": probe_failed,
    }
    return {
        "rawStatus": raw_status, "levels": dict(raw_levels) if isinstance(raw_levels, dict) else dict(observed),
        "effectiveLevels": dict(effective), "effectiveCritical": effective["critical"],
        "unknown": unknown, "actionable": actionable, "known": known,
        "issues": normalized, "recovery": recoveries, "probeFailed": probe_failed,
        "stable": stable, "signature": hashlib.sha256(_json(stable).encode()).hexdigest(),
    }


def decide(current_analysis: dict, previous_analysis: dict | None,
           last_ai_at: str | None, now: dt.datetime,
           sources_changed: bool = False, force: bool = False) -> dict:
    """Daily critical/unknown checks; changed/recovered and weekly open items."""
    reasons: list[str] = []
    if force:
        reasons.append("force")
    if sources_changed:
        reasons.append("sources_changed")
    if not isinstance(current_analysis, dict) or not current_analysis.get("signature"):
        return {"invoke": True, "reasons": reasons + ["invalid_analysis"]}
    if current_analysis.get("effectiveCritical"):
        reasons.append("critical")
    if current_analysis.get("unknown"):
        reasons.append("unknown")
    if current_analysis.get("probeFailed"):
        reasons.append("probe_failure")
    if not isinstance(previous_analysis, dict) or not previous_analysis.get("signature"):
        reasons.append("first_run")
    elif current_analysis["signature"] != previous_analysis["signature"]:
        reasons.append("changed_or_recovered")
    if current_analysis.get("actionable"):
        last = _time(last_ai_at)
        if now.tzinfo is None:
            reasons.append("clock_unconfirmed")
        elif last is None:
            reasons.append("no_prior_ai_for_actionable")
        elif now < last:
            reasons.append("clock_regression")
        elif now - last >= dt.timedelta(days=REMINDER_DAYS):
            reasons.append("periodic_actionable_reminder")
    return {"invoke": bool(reasons), "reasons": reasons}
