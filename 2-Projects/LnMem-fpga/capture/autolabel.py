"""T2 事件锚自动标注器（规则版，非 VLM——隐私设计不存帧，事件锚本就是 v1 主力）。

用法:
  .venv/bin/python autolabel.py ~/.lnmem-fpga/data/sessions/<session_id>

产出（写回 session 目录）:
  annotations_draft.json  候选标注（手册 §3 schema + seg_id）
  review.html             仲裁报告（浏览器打开扫一眼）
之后: confirm.py 应用仲裁 → annotations.json（自动过 anchor CI）。

规则:
  I3 ← speech_start 锚，回溯 [t-3s, t]，窗内脸在场率 >60%；与上一 I3 窗重叠>50% 跳过
  I5 ← leave_seat 锚，回溯 [t-5s, t]
  I1 ← 稳定段采样: 连续≥8s 在场率>95% 且 pose 抖动小 且 距事件>5s；每 120s 最多 1 段
  I0 ← 低质量段: valid=False 或 quality<0.3 连续 ≥3s（每 session 最多 3 段）
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

from validate_annotation import load_jsonl, validate

WIN_I3, WIN_I5 = 3.0, 5.0


def _rel(ts_ms: int, base_ms: int) -> float:
    return (ts_ms - base_ms) / 1000.0


def _presence_ratio(frames, t0, t1, base_ms) -> float:
    seg = [f for f in frames if t0 <= _rel(f["ts_mono_ms"], base_ms) <= t1]
    if not seg:
        return 0.0
    return sum(1 for f in seg if f.get("valid")) / len(seg)


def build_segments(frames: list[dict], events: list[dict], meta: dict) -> list[dict]:
    base = meta["mono_at_start_ms"]
    now_epoch = time.time()
    segs: list[dict] = []

    def add(t0, t1, intent, mode, ev_id, conf, note=""):
        segs.append({
            "seg_id": f"seg_{len(segs)+1:04d}", "t0": round(t0, 2), "t1": round(t1, 2),
            "intent": intent, "annotator": "auto_rule_v0", "conf": conf,
            "anchor_mode": mode, "anchor_event_id": ev_id,
            "annotated_at": now_epoch, "note": note})

    # I3 / I5：事件锚
    last_i3_t1 = -1e9
    for ev in events:
        t = _rel(ev["ts_mono_ms"], base)
        if ev["type"] == "speech_start":
            t0, t1 = max(0.0, t - WIN_I3), t
            if t0 < last_i3_t1 - (t1 - t0) * 0.5:
                continue  # 与上一窗重叠>50%
            pr = _presence_ratio(frames, t0, t1, base)
            if pr > 0.6:
                add(t0, t1, "I3", "event_ts", ev["id"], 0.9, f"在场率{pr:.0%}")
                last_i3_t1 = t1
        elif ev["type"] == "leave_seat":
            t0, t1 = max(0.0, t - WIN_I5), t
            add(t0, t1, "I5", "event_ts", ev["id"], 0.85)

    # I1：稳定段采样（每 120s 最多 1 段）
    ev_times = [_rel(e["ts_mono_ms"], base) for e in events
                if e["type"] in ("speech_start", "speech_end", "leave_seat")]
    fps_frames = [(_rel(f["ts_mono_ms"], base), f) for f in frames]
    next_allowed, run_start = 0.0, None
    for t, f in fps_frames:
        pose_d = f["feat"][52:55] if len(f.get("feat", [])) >= 55 else [9, 9, 9]
        stable = (f.get("valid") and all(abs(x) < 1.5 for x in pose_d)
                  and all(abs(t - et) > 5.0 for et in ev_times))
        if stable:
            run_start = t if run_start is None else run_start
            if t - run_start >= 8.0 and t >= next_allowed:
                mid = (run_start + t) / 2
                add(mid - 2.5, mid + 2.5, "I1", "manual_segment", None, 0.6, "稳定段")
                next_allowed = t + 120.0
                run_start = None
        else:
            run_start = None

    # I0：低质量段（含 session 以坏段收尾的尾部结算）
    bad_start, n_i0 = None, 0

    def settle_i0(t_end):
        nonlocal bad_start, n_i0
        if bad_start is not None and t_end - bad_start >= 3.0 and n_i0 < 3:
            add(bad_start, t_end, "I0", "manual_segment", None, 0.7, "低质量段")
            n_i0 += 1
        bad_start = None

    for t, f in fps_frames:
        bad = (not f.get("valid")) or f.get("quality", 1.0) < 0.3
        if bad and bad_start is None:
            bad_start = t
        elif not bad and bad_start is not None:
            settle_i0(t)
    if fps_frames:
        settle_i0(fps_frames[-1][0])
    return segs


def _spark(frames, t0, t1, base, idx: int, w=140, h=24) -> str:
    """窗内 feat[idx] 的 SVG sparkline。"""
    ys = [f["feat"][idx] for f in frames
          if t0 <= _rel(f["ts_mono_ms"], base) <= t1 and len(f.get("feat", [])) > idx]
    if len(ys) < 2:
        return ""
    lo, hi = min(ys), max(ys)
    rng = (hi - lo) or 1.0
    pts = " ".join(f"{i*w/(len(ys)-1):.0f},{h-(y-lo)/rng*h:.0f}" for i, y in enumerate(ys))
    return (f'<svg width="{w}" height="{h}"><polyline points="{pts}" '
            f'fill="none" stroke="#3b82f6" stroke-width="1.5"/></svg>')


def write_review_html(path, segs, frames, meta):
    base = meta["mono_at_start_ms"]
    rows = []
    for s in segs:
        spark = _spark(frames, s["t0"], s["t1"], base, 58)  # feat[58]=bbox_y（起身代理）
        rows.append(
            f"<tr><td>{s['seg_id']}</td><td><b>{s['intent']}</b></td>"
            f"<td>{s['t0']}–{s['t1']}s</td><td>{s.get('anchor_event_id') or '—'}</td>"
            f"<td>{s['conf']}</td><td>{s.get('note','')}</td><td>{spark}</td></tr>")
    html = f"""<!doctype html><html><head><meta charset="utf-8"><title>仲裁 {meta.get('session_id','')}</title>
<style>body{{font-family:-apple-system;background:#14161a;color:#e6e6e6;padding:16px;font-size:13px}}
table{{border-collapse:collapse;width:100%}}td,th{{padding:6px 10px;border-bottom:1px solid #2a2e37;text-align:left}}
</style></head><body>
<h3>候选标注仲裁 · {meta.get('session_id','')}（{len(segs)} 段）</h3>
<p>扫一眼，把要丢弃的 seg_id 记下，然后跑:<br>
<code>confirm.py &lt;session_dir&gt; --drop seg_0002,seg_0005</code>（全收就不带 --drop）</p>
<table><tr><th>seg</th><th>标签</th><th>时间</th><th>锚事件</th><th>conf</th><th>备注</th><th>bbox_y 曲线</th></tr>
{''.join(rows)}</table></body></html>"""
    Path(path).write_text(html, encoding="utf-8")


def main():
    if len(sys.argv) != 2:
        print(__doc__); sys.exit(2)
    sdir = Path(sys.argv[1])
    frames = load_jsonl(sdir / "frames.jsonl")
    events = load_jsonl(sdir / "events.jsonl")
    meta = json.loads((sdir / "session_meta.json").read_text())

    segs = build_segments(frames, events, meta)
    draft = [{"video_id": meta.get("session_id", "unknown"),
              "subject_id": "chuange", "segments": segs}]
    (sdir / "annotations_draft.json").write_text(
        json.dumps(draft, ensure_ascii=False, indent=1), encoding="utf-8")
    write_review_html(sdir / "review.html", segs, frames, meta)

    rejects = validate(draft, frames, events, meta)
    by = {}
    for s in segs:
        by[s["intent"]] = by.get(s["intent"], 0) + 1
    print(f"候选 {len(segs)} 段: {by}  anchor校验 rejects={len(rejects)}")
    for tag, why in rejects:
        print(f"  REJECT {tag}: {why}")
    print(f"仲裁报告: open {sdir}/review.html")
    sys.exit(1 if rejects else 0)


if __name__ == "__main__":
    main()
