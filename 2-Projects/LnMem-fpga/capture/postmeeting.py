"""会后一条龙：自动标注 → 开仲裁报告 → anchor 保险丝自检 → 仲裁 → 落盘 → MI 门进度。

用法（日常就这一条，不带参数=自动取最新 session）:
  .venv/bin/python postmeeting.py            # 交互仲裁（直接回车=全收）
  .venv/bin/python postmeeting.py --yes      # 全收不问（脚本/测试用）
  .venv/bin/python postmeeting.py <session_dir>
"""
from __future__ import annotations

import argparse
import copy
import json
import subprocess
import sys
import time
from pathlib import Path

from autolabel import build_segments, write_review_html
from validate_annotation import load_jsonl, validate

DATA_ROOT = Path.home() / ".lnmem-fpga" / "data" / "sessions"
MI_GATE_TARGET = 300  # 首批 MI 门目标（干净标注段数）


def latest_session() -> Path | None:
    if not DATA_ROOT.exists():
        return None
    dirs = sorted((d for d in DATA_ROOT.iterdir()
                   if d.is_dir() and (d / "frames.jsonl").exists()), reverse=True)
    return dirs[0] if dirs else None


def fuse_selfcheck(draft, frames, events, meta) -> bool:
    """内存中注入一条越界标注，断言 anchor CI 会拒——保险丝自检，零落盘污染。"""
    poisoned = copy.deepcopy(draft)
    poisoned[0]["segments"].append({
        "seg_id": "seg_POISON", "t0": 99999.0, "t1": 99999.5, "intent": "I3",
        "anchor_mode": "event_ts", "anchor_event_id": "ev_none",
        "annotated_at": time.time()})
    rejects = validate(poisoned, frames, events, meta)
    return any("seg_POISON" in tag or "99999" in why for tag, why in rejects)


def total_confirmed_segments() -> int:
    n = 0
    if DATA_ROOT.exists():
        for ann in DATA_ROOT.glob("*/annotations.json"):
            try:
                for a in json.loads(ann.read_text()):
                    n += len(a.get("segments", []))
            except Exception:
                pass
    return n


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("session_dir", nargs="?", default=None)
    ap.add_argument("--yes", action="store_true", help="全收不进入交互仲裁")
    ap.add_argument("--no-open", action="store_true", help="不自动打开 review.html")
    args = ap.parse_args()

    sdir = Path(args.session_dir) if args.session_dir else latest_session()
    if not sdir or not (sdir / "frames.jsonl").exists():
        print("找不到 session（还没采集过？）"); return 2

    frames = load_jsonl(sdir / "frames.jsonl")
    events = load_jsonl(sdir / "events.jsonl")
    meta = json.loads((sdir / "session_meta.json").read_text())

    # 1) 自动标注
    segs = build_segments(frames, events, meta)
    draft = [{"video_id": meta.get("session_id", "unknown"),
              "subject_id": "chuange", "segments": segs}]
    (sdir / "annotations_draft.json").write_text(
        json.dumps(draft, ensure_ascii=False, indent=1), encoding="utf-8")
    write_review_html(sdir / "review.html", segs, frames, meta)
    by: dict[str, int] = {}
    for s in segs:
        by[s["intent"]] = by.get(s["intent"], 0) + 1
    print(f"① 自动标注: {len(segs)} 段 {by}   session={meta.get('session_id')}")

    # 2) 真数据 anchor CI
    rejects = validate(draft, frames, events, meta)
    if rejects:
        print(f"❌ 候选未过 anchor CI（{len(rejects)}），不继续:")
        for tag, why in rejects:
            print(f"   {tag}: {why}")
        return 1
    print("② anchor CI: 候选全过")

    # 3) 保险丝自检（注入坏数据必须被拒）
    if fuse_selfcheck(draft, frames, events, meta):
        print("③ 保险丝自检: ✓ 越界标注被正确拒绝（LnMem 错位事故在此物理不可复现）")
    else:
        print("③ ❌ 保险丝自检失败：越界标注未被拦截——停止落盘，请找 cc"); return 1

    # 4) 仲裁
    if not args.no_open:
        subprocess.run(["open", str(sdir / "review.html")], check=False)
    drops: set[str] = set()
    if not args.yes:
        raw = input("④ 要丢弃的 seg_id（逗号分隔，直接回车=全收）: ").strip()
        drops = {s.strip() for s in raw.split(",") if s.strip()}

    for a in draft:
        a["segments"] = [s for s in a["segments"] if s.get("seg_id") not in drops]
    kept = sum(len(a["segments"]) for a in draft)

    # 5) 终验 + 落盘
    rejects = validate(draft, frames, events, meta)
    if rejects:
        print(f"❌ 仲裁后未过 anchor CI（{len(rejects)}），不落盘"); return 1
    (sdir / "annotations.json").write_text(
        json.dumps(draft, ensure_ascii=False, indent=1), encoding="utf-8")

    total = total_confirmed_segments()
    print(f"⑤ 落盘: 保留 {kept} 段，丢弃 {len(drops)} 段 → {sdir / 'annotations.json'}")
    print(f"📈 累计已确认标注 {total} 段 / MI 门目标 {MI_GATE_TARGET}"
          f"（还差 {max(0, MI_GATE_TARGET - total)}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
