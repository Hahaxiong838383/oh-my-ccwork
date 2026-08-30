"""D3 标定分析:三模型同尺 AUC + 工作点指标 + 阈值反解(判据见任务文件 D3 节)。

尺子口径(与 2026-08-30 基线 AUC 0.683 严格一致):
- 正类 pos:触发点后 ≤2s 内 turn_commit 且无 ≤2.5s 内恢复说话(说完了)
- 负类 neg_clean:触发点后 ≤800ms 恢复说话,且恢复**早于** turn_commit
  (用户自主继续说——排除「agent 接话诱发重说」的标签污染)
- 旧模型概率 = events.jsonl 的 eot_prob(生产真实推理值,非重跑)

用法:
  python d3_analyze.py manifest <events.jsonl> <wav_root> <out_manifest.tsv>
  python d3_analyze.py report <events.jsonl> <eval_v32.tsv> <eval_zh.tsv>
  python d3_analyze.py audit <events.jsonl> <n_per_class>   # 金标复核抽样(文本+时序)
"""

from __future__ import annotations

import json
import sys
from collections import defaultdict
from pathlib import Path


def load_jobs(path: str) -> dict[str, list[dict]]:
    jobs = defaultdict(list)
    for line in open(path):
        line = line.strip()
        if line:
            e = json.loads(line)
            jobs[e["job"]].append(e)
    for evs in jobs.values():
        evs.sort(key=lambda e: e["ts_ms"])
    return jobs


def label_triggers(jobs: dict) -> list[dict]:
    """每个有效触发点 → {job,seq,label,old_prob,ts,ctx...};label ∈ pos/neg_clean/neg_tainted/gray"""
    out = []
    for job, evs in jobs.items():
        probs = {e["gap_gen"]: float(e["prob"]) for e in evs if e["ev"] == "eot_prob" and e.get("accepted") == "1"}
        for i, e in enumerate(evs):
            if e["ev"] != "eot_request" or e.get("seq") in (None, "capped"):
                continue
            t0 = e["ts_ms"]
            nxt_speech = next((x["ts_ms"] for x in evs[i:] if x["ev"] == "speech_start" and x["ts_ms"] > t0), None)
            nxt_commit_ev = next((x for x in evs[i:] if x["ev"] == "turn_commit" and x["ts_ms"] > t0), None)
            nxt_commit = nxt_commit_ev["ts_ms"] if nxt_commit_ev else None
            prob = probs.get(e.get("gap_gen"))
            if nxt_speech is not None and nxt_speech - t0 <= 800:
                label = "neg_clean" if (nxt_commit is None or nxt_speech < nxt_commit) else "neg_tainted"
            elif nxt_commit is not None and nxt_commit - t0 <= 2000 and (nxt_speech is None or nxt_speech - t0 > 2500):
                label = "pos"
            else:
                label = "gray"
            prior_finals = [x.get("text", "") for x in evs[:i] if x["ev"] == "user_final"]
            out.append({
                "job": job, "seq": int(e["seq"]), "label": label, "old_prob": prob, "ts": t0,
                "commit_text": (nxt_commit_ev or {}).get("text", ""),
                "last_final_before": prior_finals[-1] if prior_finals else "",
                "resume_ms": (nxt_speech - t0) if nxt_speech is not None else None,
                "commit_ms": (nxt_commit - t0) if nxt_commit is not None else None,
            })
    return out


def auc(pos: list[float], neg: list[float]) -> float:
    wins = ties = 0
    for p in pos:
        for n in neg:
            if p > n: wins += 1
            elif p == n: ties += 1
    return (wins + 0.5 * ties) / (len(pos) * len(neg))


def cmd_manifest(events: str, wav_root: str, out_path: str) -> None:
    trigs = label_triggers(load_jobs(events))
    rows, missing = [], 0
    for t in trigs:
        if t["label"] not in ("pos", "neg_clean"):
            continue
        wav = Path(wav_root) / t["job"] / f"t{t['seq']:04d}.wav"
        if not wav.exists():
            missing += 1
            continue
        rows.append(f"{wav}\t{1 if t['label'] == 'pos' else 0}\t{t['job']}-t{t['seq']:04d}")
    Path(out_path).write_text("\n".join(rows) + "\n")
    n_pos = sum(1 for r in rows if "\t1\t" in r)
    print(f"manifest: {len(rows)} rows (pos={n_pos} neg_clean={len(rows)-n_pos}) missing_wav={missing}")
    assert len(rows) > 800, "unexpectedly small eval set"


def read_eval(path: str) -> dict[str, float]:
    d = {}
    for line in open(path):
        if line.startswith("#") or line.startswith("case\t"):
            continue
        c = line.strip().split("\t")
        d[c[0]] = float(c[2])
    return d


def workpoint(pos: list[float], neg: list[float], miss_cap: float = 0.10) -> tuple[float, float, float]:
    """在 miss ≤ miss_cap 约束下最小化 false;返回 (θ*, miss, false)。"""
    best = None
    for th in sorted(set(pos + neg)):
        miss = sum(1 for p in pos if p < th) / len(pos)
        if miss > miss_cap:
            continue
        fa = sum(1 for n in neg if n >= th) / len(neg)
        if best is None or fa < best[2] or (fa == best[2] and th > best[0]):
            best = (th, miss, fa)
    return best


def cmd_report(events: str, eval_v32: str, eval_zh: str) -> None:
    trigs = label_triggers(load_jobs(events))
    keyed = {f"{t['job']}-t{t['seq']:04d}": t for t in trigs}
    v32, zh = read_eval(eval_v32), read_eval(eval_zh)
    models = {
        "old-v1mini(生产真值)": {k: t["old_prob"] for k, t in keyed.items() if t["old_prob"] is not None},
        "official-v3.2": v32,
        "wavekat-zh": zh,
    }
    print(f"{'model':<22} {'n_pos':>5} {'n_neg':>5} {'AUC':>7}  {'θ*(miss≤10%)':>12} {'miss':>6} {'false':>6}")
    for name, probs in models.items():
        pos = [probs[k] for k, t in keyed.items() if t["label"] == "pos" and k in probs]
        neg = [probs[k] for k, t in keyed.items() if t["label"] == "neg_clean" and k in probs]
        a = auc(pos, neg)
        wp = workpoint(pos, neg)
        print(f"{name:<22} {len(pos):>5} {len(neg):>5} {a:>7.3f}  {wp[0]:>12.3f} {wp[1]:>6.1%} {wp[2]:>6.1%}")
    # 现状对照行:旧模型在生产阈值 0.18 的实际工作点
    pos_o = [t["old_prob"] for t in trigs if t["label"] == "pos" and t["old_prob"] is not None]
    neg_o = [t["old_prob"] for t in trigs if t["label"] == "neg_clean" and t["old_prob"] is not None]
    print(f"\n现状(旧模型@0.18): miss={sum(1 for p in pos_o if p < 0.18)/len(pos_o):.1%} false={sum(1 for n in neg_o if n >= 0.18)/len(neg_o):.1%}")


def cmd_audit(events: str, n_per: int) -> None:
    import random
    rng = random.Random(20260830)
    trigs = label_triggers(load_jobs(events))
    for cls in ("pos", "neg_clean"):
        pool = [t for t in trigs if t["label"] == cls]
        sample = rng.sample(pool, min(n_per, len(pool)))
        print(f"\n==== {cls} 抽样 {len(sample)} 条(复核弱标签噪声率;凭文本+时序判断) ====")
        for t in sample:
            print(f"[{t['job']}-t{t['seq']:04d}] resume+{t['resume_ms']}ms commit+{t['commit_ms']}ms "
                  f"old_p={t['old_prob'] if t['old_prob'] is not None else 'NA'}")
            print(f"   之前final:「{t['last_final_before'][:40]}」 提交文本:「{t['commit_text'][:60]}」")


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "manifest":
        cmd_manifest(*sys.argv[2:5])
    elif cmd == "report":
        cmd_report(*sys.argv[2:5])
    elif cmd == "audit":
        cmd_audit(sys.argv[2], int(sys.argv[3]))
    else:
        raise SystemExit("unknown cmd")
