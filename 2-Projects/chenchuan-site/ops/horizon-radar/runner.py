#!/usr/bin/env python3
"""Run pinned Horizon pipeline, gate the result, and publish it to the site."""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from adapter import build_report  # noqa: E402


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def atomic_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.replace(path)


def horizon_commit(path: Path) -> str:
    return subprocess.check_output(
        ["git", "-C", str(path), "rev-parse", "HEAD"], text=True
    ).strip()


def load_items(runs_root: Path, run_id: str) -> list[dict]:
    run_dir = runs_root / run_id
    for filename in ("enriched_items.json", "filtered_items.json"):
        file = run_dir / filename
        if file.exists():
            payload = json.loads(file.read_text(encoding="utf-8"))
            if isinstance(payload, list):
                return [item for item in payload if isinstance(item, dict)]
    return []


def load_realtime_urls(cache_file: Path) -> set[str]:
    if not cache_file.exists():
        return set()
    try:
        payload = json.loads(cache_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return set()
    items = payload.get("items") if isinstance(payload, dict) else None
    if not isinstance(items, list):
        return set()
    return {
        item["url"].strip()
        for item in items
        if isinstance(item, dict) and isinstance(item.get("url"), str) and item["url"].strip()
    }


def post_report(endpoint: str, token: str, report: dict) -> dict:
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(report, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": "chenchuan-horizon-radar/1.0",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = json.loads(response.read().decode("utf-8"))
        if response.status != 200 or payload.get("ok") is not True:
            raise RuntimeError(f"webhook rejected report: HTTP {response.status}")
        return payload


def prune_candidates(directory: Path, keep: int = 20) -> None:
    files = sorted(directory.glob("candidate-*.json"), key=lambda path: path.stat().st_mtime, reverse=True)
    for file in files[keep:]:
        file.unlink(missing_ok=True)


async def run() -> dict:
    horizon_path = Path(env("HORIZON_PATH", "/opt/horizon-radar/vendor/Horizon")).resolve()
    config_path = Path(env("HORIZON_CONFIG", "/opt/horizon-radar/config.json")).resolve()
    state_dir = Path(env("HORIZON_STATE_DIR", "/var/lib/horizon-radar")).resolve()
    realtime_cache = Path(
        env("HORIZON_REALTIME_CACHE", "/var/www/chenchuan-site/data/radar-feed-cache.json")
    ).resolve()
    runs_root = state_dir / "runs"
    endpoint = env("HORIZON_WEBHOOK_URL", "http://127.0.0.1:3000/api/radar-webhook")
    token = env("RADAR_WEBHOOK_TOKEN")
    publish = env("PUBLISH", "false").lower() == "true"
    hours = max(1, int(env("HORIZON_WINDOW_HOURS", "30")))
    threshold = float(env("HORIZON_SCORE_THRESHOLD", "7"))
    min_items = max(1, int(env("HORIZON_MIN_ITEMS", "4")))
    max_items = max(min_items, min(20, int(env("HORIZON_MAX_ITEMS", "12"))))
    # 与实时流按 URL 硬去重会把当日真热点一票否决（重大新闻必然已进 5000 条热层），
    # 导致连续 publish gate failed；精选层的增量价值在中文深度解读，不在 URL 增量。
    exclude_realtime = env("HORIZON_EXCLUDE_REALTIME", "true").lower() == "true"
    sources = [value for value in env("HORIZON_SOURCES", "hackernews,rss,github,google_news").split(",") if value]

    if not token:
        raise RuntimeError("RADAR_WEBHOOK_TOKEN is not configured")
    if not horizon_path.joinpath("src/mcp/service.py").exists():
        raise RuntimeError(f"invalid HORIZON_PATH: {horizon_path}")
    if not config_path.exists():
        raise RuntimeError(f"HORIZON_CONFIG does not exist: {config_path}")

    actual_commit = horizon_commit(horizon_path)
    pinned_commit = env("HORIZON_PINNED_COMMIT")
    if pinned_commit and actual_commit != pinned_commit:
        raise RuntimeError(f"Horizon commit drift: expected {pinned_commit}, got {actual_commit}")

    if str(horizon_path) not in sys.path:
        sys.path.insert(0, str(horizon_path))
    from src.mcp.service import HorizonPipelineService

    service = HorizonPipelineService(runs_root=runs_root)
    pipeline = await service.run_pipeline(
        hours=hours,
        languages=["zh"],
        threshold=threshold,
        horizon_path=str(horizon_path),
        config_path=str(config_path),
        sources=sources,
        enrich=True,
        topic_dedup=True,
        save_to_horizon_data=False,
    )
    items = load_items(runs_root, pipeline["run_id"])
    now = datetime.now(timezone.utc)
    report = build_report(
        pipeline,
        items,
        report_date=datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d"),
        generated_at=now,
        publish=publish,
        horizon_commit=actual_commit,
        max_items=max_items,
        exclude_urls=load_realtime_urls(realtime_cache) if exclude_realtime else set(),
    )

    # 数量门只在 0 条时硬失败；淡日（1 到 min_items-1 条）照常发布并打 lowVolume 标记，
    # 质量由 score threshold + AI 相关性过滤把守，数量不足不阻断日更。
    if not report["items"]:
        raise RuntimeError("publish gate failed: 0 items after filtering")
    low_volume = len(report["items"]) < min_items
    if low_volume:
        print(
            f"low volume day: {len(report['items'])} items < preferred {min_items}, publishing anyway",
            file=sys.stderr,
        )

    candidate_dir = state_dir / "candidates"
    candidate_file = candidate_dir / f"candidate-{report['date']}-{pipeline['run_id']}.json"
    atomic_json(candidate_file, report)
    prune_candidates(candidate_dir)
    webhook = post_report(endpoint, token, report)

    return {
        "checkedAt": now.isoformat(),
        "ok": True,
        "mode": "published" if publish else "shadow",
        "lowVolume": low_volume,
        "date": report["date"],
        "itemCount": len(report["items"]),
        "totalFetched": report["totalFetched"],
        "sourceCount": report["sourceCount"],
        "realtimeDuplicateCount": report["realtimeDuplicateCount"],
        "relevanceFilteredCount": report["relevanceFilteredCount"],
        "runId": pipeline["run_id"],
        "horizonCommit": actual_commit,
        "webhook": {"ok": True, "mode": webhook.get("mode")},
        "error": None,
    }


def main() -> int:
    state_dir = Path(env("HORIZON_STATE_DIR", "/var/lib/horizon-radar")).resolve()
    state_file = state_dir / "state.json"
    try:
        result = asyncio.run(run())
        atomic_json(state_file, result)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as error:
        failed = {
            "checkedAt": datetime.now(timezone.utc).isoformat(),
            "ok": False,
            "mode": "published" if env("PUBLISH", "false").lower() == "true" else "shadow",
            "error": f"{type(error).__name__}: {error}"[:500],
        }
        atomic_json(state_file, failed)
        print(json.dumps(failed, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
