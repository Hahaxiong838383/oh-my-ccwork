"""anchor CI 校验器——标注手册 §4.3 规格的实现（红线 R1）。

用法:
  python validate_annotation.py <annotations.json> <session_dir>

session_dir 需含 frames.jsonl / events.jsonl / session_meta.json。
退出码: 0=全过, 1=有 reject（CI 用）。

LnMem 学费: 481 条标注 100% 错位约 5 分钟、一个月无人发现——
本脚本存在的意义就是让那类事故活不过第一条数据。
"""
from __future__ import annotations

import json
import sys

ANCHOR_MODES = {"event_ts", "manual_segment", "fallback_now"}


def load_jsonl(path):
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def validate(annotations: list[dict], frames: list[dict],
             events: list[dict], session_meta: dict) -> list[tuple[str, str]]:
    """返回 [(segment描述, reject原因)]，空列表=全过。"""
    rejects: list[tuple[str, str]] = []
    if not frames:
        return [("<session>", "frames.jsonl 为空")]

    f_min = frames[0]["ts_mono_ms"] / 1000.0
    f_max = frames[-1]["ts_mono_ms"] / 1000.0
    event_ids = {e["id"] for e in events}
    # 标注侧 t0/t1 用会话相对秒；换算：mono_ms/1000 - session 起点
    t_base = session_meta.get("mono_at_start_ms", frames[0]["ts_mono_ms"]) / 1000.0
    lo, hi = f_min - t_base, f_max - t_base

    meta_required = {"date", "camera", "machine"}
    missing = meta_required - set(session_meta)
    if missing:
        rejects.append(("<session>", f"session_meta 缺字段: {sorted(missing)}"))

    for a in annotations:
        for seg in a.get("segments", []):
            tag = f"{a.get('video_id','?')}:{seg.get('intent','?')}@{seg.get('t0','?')}"
            t0, t1 = seg.get("t0"), seg.get("t1")
            if t0 is None or t1 is None or t1 < t0:
                rejects.append((tag, "t0/t1 缺失或倒置")); continue
            # A1: 标注必须落在特征帧时间范围内
            if not (lo - 1.0 <= t0 and t1 <= hi + 1.0):
                rejects.append((tag, f"A1 违例: [{t0},{t1}] 不在特征范围 [{lo:.1f},{hi:.1f}]"))
            # anchor_mode 枚举 + 事件可解析
            mode = seg.get("anchor_mode")
            if mode not in ANCHOR_MODES:
                rejects.append((tag, f"anchor_mode 非法: {mode}"))
            elif mode == "event_ts":
                if seg.get("anchor_event_id") not in event_ids:
                    rejects.append((tag, f"A2 违例: anchor_event_id={seg.get('anchor_event_id')} 不存在于事件流"))
            # A3: 标注动作时刻不得早于内容时刻
            ann_at = seg.get("annotated_at")
            if ann_at is None:
                rejects.append((tag, "缺 annotated_at"))
            else:
                epoch_base = session_meta.get("epoch_at_start")
                if epoch_base is not None and ann_at < epoch_base + t1 - 1.0:
                    rejects.append((tag, "A3 违例: annotated_at 早于被标注内容结束时刻"))
    return rejects


def main():
    if len(sys.argv) != 3:
        print(__doc__); sys.exit(2)
    ann_path, sdir = sys.argv[1], sys.argv[2].rstrip("/")
    annotations = json.load(open(ann_path, encoding="utf-8"))
    if isinstance(annotations, dict):
        annotations = [annotations]
    frames = load_jsonl(f"{sdir}/frames.jsonl")
    events = load_jsonl(f"{sdir}/events.jsonl")
    session_meta = json.load(open(f"{sdir}/session_meta.json", encoding="utf-8"))

    rejects = validate(annotations, frames, events, session_meta)
    n_seg = sum(len(a.get("segments", [])) for a in annotations)
    fb = sum(1 for a in annotations for s in a.get("segments", [])
             if s.get("anchor_mode") == "fallback_now")
    print(f"segments={n_seg} fallback_now={fb} ({fb/max(1,n_seg):.0%}) rejects={len(rejects)}")
    for tag, why in rejects:
        print(f"  REJECT {tag}: {why}")
    sys.exit(1 if rejects else 0)


if __name__ == "__main__":
    main()
