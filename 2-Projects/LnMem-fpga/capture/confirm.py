"""仲裁应用器：annotations_draft.json → annotations.json（终稿，过 anchor CI 才落）。

用法:
  .venv/bin/python confirm.py <session_dir>                     # 全收
  .venv/bin/python confirm.py <session_dir> --drop seg_0002,seg_0005
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from validate_annotation import load_jsonl, validate


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("session_dir")
    ap.add_argument("--drop", default="", help="逗号分隔的 seg_id 列表")
    args = ap.parse_args()
    sdir = Path(args.session_dir)
    drops = {s.strip() for s in args.drop.split(",") if s.strip()}

    draft = json.loads((sdir / "annotations_draft.json").read_text())
    kept_total, dropped = 0, 0
    for a in draft:
        before = len(a["segments"])
        a["segments"] = [s for s in a["segments"] if s.get("seg_id") not in drops]
        kept_total += len(a["segments"])
        dropped += before - len(a["segments"])

    frames = load_jsonl(sdir / "frames.jsonl")
    events = load_jsonl(sdir / "events.jsonl")
    meta = json.loads((sdir / "session_meta.json").read_text())
    rejects = validate(draft, frames, events, meta)
    if rejects:
        print(f"❌ anchor CI 未过（{len(rejects)} rejects），不落 annotations.json:")
        for tag, why in rejects:
            print(f"  {tag}: {why}")
        sys.exit(1)

    (sdir / "annotations.json").write_text(
        json.dumps(draft, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"✅ annotations.json 落盘: 保留 {kept_total} 段, 丢弃 {dropped} 段, anchor CI 全过")
    sys.exit(0)


if __name__ == "__main__":
    main()
