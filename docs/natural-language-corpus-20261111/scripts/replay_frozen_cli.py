#!/usr/bin/env python3
"""Replay routing cases on the frozen build-host preview.

evaluate-final.py points at target/release/search-route-preview. That path is
stale. This script uses target-final-reviewed/release/search-route-preview and
refuses to score anything if the SHA is not the reviewed digest.
"""
from __future__ import annotations

import collections
import hashlib
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, "/Users/fu-121/.local/state/p003-main-dns-hedge-20261108")
from remote_dns import command  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
CONFIG_PATH = Path("/Users/fu-121/.local/state/p003-lexicon-implementation-20261111/routing-after.json")
BINARY = (
    "/home/hahaxiong83/local/p003-lexicon-implementation-20261111/listening/"
    "2-Projects/realtime-voice-agent/rust-worker/tools/search-route-preview/"
    "target-final-reviewed/release/search-route-preview"
)
EXPECTED_SHA = "f978af6f93a76400fe7c6d1c9601dca5dfd979cc305a280e57f1d2b982a77f44"
PRIOR = [
    Path("/Users/fu-121/.local/state/p003-lexicon-phase1-lab-20261111/corpus-frozen-review/corpus-dev.json"),
    Path("/Users/fu-121/.local/state/p003-lexicon-phase1-lab-20261111/corpus-frozen-review/corpus-holdout.json"),
    Path("/Users/fu-121/.local/state/p003-lexicon-implementation-20261111/grok-holdout/corpus-holdout.json"),
]

CONTROLS = [
    {
        "id": "ctl-f1-2500",
        "utterances": [{"text": "杭州", "at_ms": 0, "reset": True}, {"text": "今天会冷吗", "at_ms": 2500, "reset": False}],
        "expected": [
            {"action": "chat", "weather_required": False, "query_must_be_null": True},
            {"action": "search", "weather_required": True, "place": "@auto", "day_offset": 0, "needs": ["comfort"], "metric": "forecast"},
        ],
    },
    {
        "id": "ctl-f1-2000",
        "utterances": [{"text": "杭州", "at_ms": 0, "reset": True}, {"text": "今天会冷吗", "at_ms": 2000, "reset": False}],
        "expected": [
            {"action": "chat", "weather_required": False, "query_must_be_null": True},
            {"action": "search", "weather_required": True, "place": "杭州", "day_offset": 0, "needs": ["comfort"], "metric": "forecast"},
        ],
    },
    {
        "id": "ctl-f2-protected",
        "utterances": [{"text": "先别查杭州今天冷不冷", "at_ms": 0, "reset": True}],
        "expected": [{"action": "chat", "weather_required": False, "query_must_be_null": True}],
    },
    {
        "id": "ctl-chengdu-tomorrow",
        "utterances": [{"text": "成都明天天气", "at_ms": 0, "reset": True}],
        "expected": [{"action": "search", "weather_required": True, "place": "成都", "day_offset": 1, "needs": ["overview"], "metric": "forecast"}],
    },
    {
        "id": "ctl-aircon",
        "utterances": [{"text": "空调温度怎么调", "at_ms": 0, "reset": True}],
        "expected": [{"action": "chat", "weather_required": False, "query_must_be_null": True}],
    },
]


def remote(payload, timeout):
    code = (
        "import base64,hashlib,json,subprocess,time\n"
        "payload=json.loads(" + json.dumps(json.dumps(payload, ensure_ascii=False)) + ")\n"
        "binary=payload['binary']; expected=payload['expected_sha']\n"
        "digest=hashlib.sha256(open(binary,'rb').read()).hexdigest()\n"
        "if digest!=expected:\n"
        "    print(json.dumps({'ok':False,'error':'sha_mismatch','sha256':digest}))\n"
        "    raise SystemExit(2)\n"
        "out=[]\n"
        "for batch in payload['batches']:\n"
        "    started=time.perf_counter_ns()\n"
        "    proc=subprocess.run([binary],input=json.dumps({'config':payload['config'],'utterances':batch},ensure_ascii=False).encode(),capture_output=True,timeout=20)\n"
        "    wall=(time.perf_counter_ns()-started)/1e6\n"
        "    if proc.returncode!=0:\n"
        "        print(json.dumps({'ok':False,'error':'cli','returncode':proc.returncode,'stderr':proc.stderr.decode()[-500:],'stdout':proc.stdout.decode()[-500]}))\n"
        "        raise SystemExit(3)\n"
        "    parsed=json.loads(proc.stdout)\n"
        "    out.append({'wall_ms':wall,'decisions':parsed['decisions'],'config_echo_schema':parsed['config'].get('schema')})\n"
        "print(json.dumps({'ok':True,'sha256':digest,'batches':out},ensure_ascii=False))\n"
    )
    completed = subprocess.run(command("build", "python3 -"), input=code.encode(), capture_output=True, timeout=timeout)
    if completed.returncode != 0:
        return {"ok": False, "error": "remote", "returncode": completed.returncode,
                "stderr": completed.stderr.decode()[-1500:], "stdout": completed.stdout.decode()[-1500:]}
    return json.loads(completed.stdout)


def pack(cases):
    requests, indices, batch = [], [], []
    for case in cases:
        turns = len(case["utterances"])
        if batch and len(batch) + turns > 40:
            requests.append(batch)
            batch = []
        start = len(batch)
        batch.extend(case["utterances"])
        indices.append((len(requests), start, start + turns))
    if batch:
        requests.append(batch)
    return requests, indices


def observe(decision):
    weather = decision.get("auto_weather") or decision.get("place_weather") or decision.get("weather")
    if decision.get("auto_weather"):
        place = "@auto"
    elif decision.get("place_weather"):
        place = decision["place_weather"].get("place")
    elif decision.get("weather"):
        place = decision["weather"].get("city_name")
    else:
        place = None
    return {
        "action": decision.get("action"),
        "place": place,
        "day_offset": None if not weather else weather.get("day_offset"),
        "metric": None if not weather else weather.get("metric"),
        "requested_info": decision.get("requested_info") or [],
        "weather_object": bool(weather),
        "query_null": decision.get("query") is None,
        "rule_id": decision.get("rule_id"),
    }


def score_turn(actual, expected):
    seen = observe(actual)
    failures = []
    if seen["action"] != expected["action"]:
        failures.append("action")
    if "weather_required" in expected and seen["weather_object"] != expected["weather_required"]:
        failures.append("weather_required")
    if expected.get("query_must_be_null") and not seen["query_null"]:
        failures.append("query")
    if expected.get("must_not_auto") and seen["place"] == "@auto":
        failures.append("auto")
    if expected["action"] in {"chat", "clarify", "clarify_city", "cancel", "resume"}:
        return failures, seen
    if "place" in expected and seen["place"] != expected["place"]:
        failures.append("place")
    if "day_offset" in expected and seen["day_offset"] != expected["day_offset"]:
        failures.append("day_offset")
    if "metric" in expected and seen["metric"] != expected["metric"]:
        failures.append("metric")
    for need in expected.get("needs") or []:
        if need not in seen["requested_info"]:
            failures.append("need:" + need)
    return failures, seen


def classify(expected_action, failures):
    kinds = set()
    if "action" in failures:
        if expected_action == "chat":
            kinds.add("false_trigger")
        else:
            kinds.add("miss")
    elif any(item != "action" for item in failures):
        kinds.add("slot")
    if expected_action == "chat" and any(item in {"weather_required", "query"} for item in failures):
        kinds.add("false_trigger")
    return kinds


def evaluate(cases, actual_batches):
    _requests, indices = pack(cases)
    rows = []
    groups = collections.defaultdict(lambda: collections.Counter())
    for case, (batch_index, start, end) in zip(cases, indices):
        decisions = actual_batches[batch_index]["decisions"][start:end]
        turn_failures = []
        observed = []
        for decision, expected in zip(decisions, case["expected"]):
            failures, seen = score_turn(decision, expected)
            turn_failures.append(failures)
            observed.append(seen)
        flat = [item for group in turn_failures for item in group]
        kinds = set()
        for expected, failures in zip(case["expected"], turn_failures):
            kinds |= classify(expected["action"], failures)
        row = {
            "id": case["id"],
            "category": case.get("category", case.get("source_kind")),
            "layer": case.get("layer", "pure_route"),
            "split": case.get("split"),
            "family": case.get("family"),
            "pass": not flat,
            "kinds": sorted(kinds),
            "failures": turn_failures,
            "observed": observed,
        }
        rows.append(row)
        bucket = groups[row["category"]]
        bucket["cases"] += 1
        bucket["pass"] += int(row["pass"])
        bucket["miss"] += int("miss" in kinds)
        bucket["false_trigger"] += int("false_trigger" in kinds)
        bucket["slot"] += int("slot" in kinds and row["pass"] is False and "miss" not in kinds and "false_trigger" not in kinds)
        if case.get("layer") == "routing_session":
            groups["routing_session"]["cases"] += 1
            groups["routing_session"]["pass"] += int(row["pass"])
        if case.get("category") == "single_char_pure":
            groups["single_char_pure_separate"]["cases"] += 1
            groups["single_char_pure_separate"]["pass"] += int(row["pass"])
    return {"groups": {key: dict(value) for key, value in groups.items()}, "rows": rows}


def candidate_config(base):
    proposal = json.loads((ROOT / "PROPOSED_LEXICON.json").read_text())
    config = json.loads(json.dumps(base))
    by_id = {rule["id"]: rule for rule in config["rules"]}
    weather = by_id["natural-weather"]
    facts = by_id["current-public-facts"]
    for token in proposal["natural_weather_trigger_additions"]:
        if token not in weather["triggers"]:
            weather["triggers"].append(token)
    for token in proposal["current_public_fact_trigger_additions"]:
        if token not in facts["triggers"]:
            facts["triggers"].append(token)
    if len(weather["triggers"]) > 32 or len(facts["triggers"]) > 32:
        raise SystemExit("candidate triggers exceed schema limit")
    return config


def run_cases(cases, config, timeout):
    batches, _indices = pack(cases)
    result = remote({"binary": BINARY, "expected_sha": EXPECTED_SHA, "config": config, "batches": batches}, timeout)
    return result


def old_check(actual, expected):
    failures = []
    if actual.get("action") != expected["action"]:
        failures.append("action")
    weather = actual.get("weather") or actual.get("place_weather") or actual.get("auto_weather")
    if "weather_required" in expected and bool(weather) != expected["weather_required"]:
        failures.append("weather_required")
    place = "@auto" if actual.get("auto_weather") else (weather or {}).get("place")
    if "place" in expected and place != expected["place"]:
        failures.append("place")
    if "day_offset" in expected and (weather or {}).get("day_offset") != expected["day_offset"]:
        failures.append("day_offset")
    if expected.get("need") and expected["need"] not in (actual.get("requested_info") or []):
        failures.append("need")
    return failures


def route_failures(actual, expected, failures):
    """Same exemption as evaluate-final.py: clarify_city with a null query
    does not expose weather_required or day_offset. Need mismatches are not
    route failures. The binary path is still target-final-reviewed."""
    reduced = [item for item in failures if item != "need"]
    if expected["action"] == "clarify_city" and actual.get("action") == "clarify_city" and actual.get("query") is None:
        reduced = [item for item in reduced if item != "weather_required"]
        if "day_offset" in expected:
            reduced = [item for item in reduced if item != "day_offset"]
    return reduced


def regression(config):
    summary = []
    for path in PRIOR:
        if not path.exists():
            summary.append({"corpus": str(path), "status": "MISSING"})
            continue
        cases = json.loads(path.read_text())
        if isinstance(cases, dict):
            cases = cases["cases"]
        result = run_cases(cases, config, 180)
        if not result.get("ok"):
            summary.append({"corpus": path.name, "status": "NOT_RUN", "detail": result})
            continue
        rows = []
        passed = 0
        route_matched = 0
        for case, (batch_index, start, end) in zip(cases, pack(cases)[1]):
            decisions = result["batches"][batch_index]["decisions"][start:end]
            failures = [old_check(decision, expected) for decision, expected in zip(decisions, case["expected"])]
            routed = [route_failures(decision, expected, group) for decision, expected, group in zip(decisions, case["expected"], failures)]
            ok = not any(failures)
            passed += int(ok)
            route_matched += int(not any(routed))
            rows.append({
                "id": case["id"],
                "source_kind": case.get("source_kind"),
                "pass": ok,
                "route_match": not any(routed),
                "failures": failures,
                "route_failures": routed,
                "actions": [item.get("action") for item in decisions],
                "rules": [item.get("rule_id") for item in decisions],
            })
        summary.append({
            "corpus": path.name,
            "status": "RUN",
            "cases": len(cases),
            "strict_passed": passed,
            "route_matched": route_matched,
            "binary_sha256": result["sha256"],
            "checker": "strict old_check plus evaluate-final clarify_city exemption; utterance text omitted",
            "rows": rows,
        })
    return summary


def main():
    config = json.loads(CONFIG_PATH.read_text())
    config_sha = hashlib.sha256(CONFIG_PATH.read_bytes()).hexdigest()
    control = run_cases(CONTROLS, config, 90)
    (DATA / "CONTROL_RESULTS.json").write_text(json.dumps(control if not control.get("ok") else {
        "binary_sha256": control["sha256"],
        "config_sha256": config_sha,
        **evaluate(CONTROLS, control["batches"]),
        "wall_ms": [batch["wall_ms"] for batch in control["batches"]],
    }, ensure_ascii=False, indent=2) + "\n")
    if not control.get("ok") or not evaluate(CONTROLS, control["batches"])["rows"] or any(
        not row["pass"] for row in evaluate(CONTROLS, control["batches"])["rows"]
    ):
        scored = evaluate(CONTROLS, control["batches"]) if control.get("ok") else {"rows": []}
        (DATA / "BASELINE_RESULTS.json").write_text(json.dumps({
            "status": "NOT_RUN",
            "reason": "control cases failed or the frozen binary was unavailable",
            "binary_sha256": control.get("sha256"),
            "control_passes": [row["id"] for row in scored.get("rows", []) if row.get("pass")],
            "control_failures": [row for row in scored.get("rows", []) if not row.get("pass")],
            "remote": None if control.get("ok") else control,
        }, ensure_ascii=False, indent=2) + "\n")
        print("NOT_RUN controls")
        return 2
    corpus = json.loads((DATA / "corpus.json").read_text())
    manifest = json.loads((DATA / "SPLIT_MANIFEST.json").read_text())
    raw = json.dumps(corpus, ensure_ascii=False, separators=(",", ":")).encode()
    if hashlib.sha256(raw).hexdigest() != manifest["corpus_sha256"]:
        raise SystemExit("corpus hash drifted after freeze")
    baseline = run_cases(corpus, config, 240)
    if not baseline.get("ok"):
        (DATA / "BASELINE_RESULTS.json").write_text(json.dumps({"status": "NOT_RUN", "remote": baseline}, ensure_ascii=False, indent=2) + "\n")
        print("NOT_RUN corpus")
        return 2
    report = evaluate(corpus, baseline["batches"])
    report.update({
        "status": "RUN",
        "binary": BINARY,
        "binary_sha256": baseline["sha256"],
        "config_sha256": config_sha,
        "corpus_sha256": manifest["corpus_sha256"],
        "wall_ms": [batch["wall_ms"] for batch in baseline["batches"]],
        "wall_ms_sum": sum(batch["wall_ms"] for batch in baseline["batches"]),
        "note": "文本路由模拟。不是声学、供应商或真机结果。单字纯路由与 routing_session 分开计数。search_tasks 暂存层不在此 CLI。",
    })
    (DATA / "BASELINE_RESULTS.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    candidate = run_cases(corpus, candidate_config(config), 240)
    if candidate.get("ok"):
        cand = evaluate(corpus, candidate["batches"])
        cand.update({
            "status": "RUN",
            "label": "config_only_unreleased",
            "binary_sha256": candidate["sha256"],
            "wall_ms_sum": sum(batch["wall_ms"] for batch in candidate["batches"]),
            "code_changes_included": False,
        })
    else:
        cand = {"status": "NOT_RUN", "remote": candidate}
    (DATA / "CANDIDATE_RESULTS.json").write_text(json.dumps(cand, ensure_ascii=False, indent=2) + "\n")
    (DATA / "REGRESSION_RESULTS.json").write_text(json.dumps({
        "status": "RUN",
        "label": "prior corpora unchanged; utterance text omitted",
        "binary_sha256": baseline["sha256"],
        "sets": regression(config),
    }, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"baseline_groups": report["groups"], "candidate_groups": cand.get("groups"), "wall_ms_sum": report["wall_ms_sum"]}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
