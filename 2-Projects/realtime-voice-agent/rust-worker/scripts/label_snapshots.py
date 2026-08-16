"""EOT 快照弱标签:从 events.jsonl 推每个触发点的「说完了没」,产出评测 manifest。

输入:EOT_SNAPSHOT_DIR(采集口产物,见 src/eot_snapshot.rs 头注)
输出:<dir>/manifest_weak.tsv  wav相对路径\t弱标签\tcase\t旧模型prob\t依据
     标签: 1=说完了 / 0=没说完 / ?=模糊(需人工);统计打印到 stdout

弱标签规则(生产行为语义,阈值在报告 D3 阶段可再调):
- 触发点(eot_request)后,同 job 下一个 speech_start 距离 Δ:
  Δ ≤ 800ms            → 0(用户很快继续说——这就是「思考停顿」)
  无后续说话,且触发点后 ≤2s 内出现 turn_commit → 1(判停提交且用户没抢话)
  其余                  → ?(交给人工;含 Δ∈(800ms,2.5s) 的灰区)
- 旧模型概率经 gap_gen 对齐(eot_prob.accepted=1 的回包);无回包=NA(sidecar 降级窗口)

⚠️ 隐私:本目录是用户语音数据,只在本机/私有环境处理,禁外派任何外部引擎。

用法: python3 label_snapshots.py <EOT_SNAPSHOT_DIR>
"""

from __future__ import annotations

import json
import sys
from collections import defaultdict
from pathlib import Path

FAST_RESUME_MS = 800
COMMIT_WINDOW_MS = 2000
GRAY_MS = 2500


def main() -> None:
    root = Path(sys.argv[1])
    events_path = root / "events.jsonl"
    assert events_path.exists(), f"no events.jsonl in {root}"

    jobs: dict[str, list[dict]] = defaultdict(list)
    for line in events_path.read_text().splitlines():
        if not line.strip():
            continue
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue  # 半行(进程被杀)容忍,计数意义不大
        jobs[e["job"]].append(e)

    rows = []
    stats = defaultdict(int)
    for job, evs in jobs.items():
        evs.sort(key=lambda e: e["ts_ms"])
        # gap_gen → 已接受概率(同 gap 只有一次请求/回包)
        probs = {
            e["gap_gen"]: e["prob"]
            for e in evs
            if e["ev"] == "eot_prob" and e.get("accepted") == "1"
        }
        for i, e in enumerate(evs):
            if e["ev"] != "eot_request" or e.get("seq") in (None, "capped"):
                continue
            t0 = e["ts_ms"]
            next_speech = next(
                (x["ts_ms"] for x in evs[i:] if x["ev"] == "speech_start" and x["ts_ms"] > t0),
                None,
            )
            commit_soon = any(
                x["ev"] == "turn_commit" and t0 < x["ts_ms"] <= t0 + COMMIT_WINDOW_MS
                for x in evs[i:]
            )
            if next_speech is not None and next_speech - t0 <= FAST_RESUME_MS:
                label, why = "0", f"resume+{next_speech - t0}ms"
            elif commit_soon and (next_speech is None or next_speech - t0 > GRAY_MS):
                label, why = "1", "committed,no-resume"
            else:
                label, why = "?", (
                    f"resume+{next_speech - t0}ms" if next_speech is not None else "no-signal"
                )
            wav = f"{job}/t{int(e['seq']):04d}.wav"
            prob = probs.get(e.get("gap_gen", ""), "NA")
            rows.append(f"{wav}\t{label}\t{job}-t{int(e['seq']):04d}\t{prob}\t{why}")
            stats[label] += 1
            if not (root / wav).exists():
                stats["missing_wav"] += 1

    out = root / "manifest_weak.tsv"
    out.write_text("# wav\tweak_label\tcase\told_prob\twhy\n" + "\n".join(rows) + "\n")
    total = sum(v for k, v in stats.items() if k in ("0", "1", "?"))
    print(f"jobs={len(jobs)} trigger_points={total} -> {out}")
    for k in ("1", "0", "?", "missing_wav"):
        if stats[k]:
            print(f"  {k}: {stats[k]} ({stats[k]/total:.0%})" if total else f"  {k}: {stats[k]}")
    assert total > 0, "zero trigger points — is the collector actually on?"


if __name__ == "__main__":
    main()
