"""评测结果对照分析:各模型在同一评测集上的判停质量指标。

用法: python analyze_eval.py <spec>... 其中 spec = <tsv路径>:<标签>:<工作阈值>
  例: analyze_eval.py old.tsv:old-v1mini:0.18 off.tsv:official-v3.2:0.5 zh.tsv:wavekat-zh:0.67

指标口径(生产语义,见任务书 §四/§八):
- 漏判率 miss  = 正类(说完了) p < θ 的比例 → 走 MAX delay,响应变慢
- 误触发 false = 负类(没说完) p ≥ θ 的比例 → 走 MIN delay,易抢话
- AUC:阈值无关的分离度(重标定后的天花板)
- best-F1 阈值:数据上的最优工作点(重标定参考,非结论)
"""

from __future__ import annotations

import sys


def read_tsv(path: str) -> list[tuple[str, int, float, float]]:
    rows = []
    for line in open(path):
        line = line.strip()
        if not line or line.startswith("#") or line.startswith("case\t"):
            continue
        c = line.split("\t")
        rows.append((c[0], int(c[1]), float(c[2]), float(c[4])))
    return rows


def auc(pos: list[float], neg: list[float]) -> float:
    """Mann-Whitney U / (n_pos*n_neg),平局计 0.5。"""
    wins = ties = 0
    for p in pos:
        for n in neg:
            if p > n:
                wins += 1
            elif p == n:
                ties += 1
    return (wins + 0.5 * ties) / (len(pos) * len(neg))


def best_f1(pos: list[float], neg: list[float]) -> tuple[float, float]:
    cands = sorted(set(pos + neg))
    best = (0.0, 0.5)
    for th in cands:
        tp = sum(1 for p in pos if p >= th)
        fp = sum(1 for n in neg if n >= th)
        fn = len(pos) - tp
        f1 = 2 * tp / (2 * tp + fp + fn) if (2 * tp + fp + fn) else 0.0
        if f1 > best[0]:
            best = (f1, th)
    return best


def main() -> None:
    print(f"{'model':<18} {'θ':>5} {'miss(正类<θ)':>12} {'false(负类≥θ)':>13} {'AUC':>7} {'bestF1':>7} {'@θ*':>6} {'p50_ms':>7}")
    for spec in sys.argv[1:]:
        path, label, th_s = spec.rsplit(":", 2)
        th = float(th_s)
        rows = read_tsv(path)
        pos = [r[2] for r in rows if r[1] == 1]
        neg = [r[2] for r in rows if r[1] == 0]
        assert pos and neg, f"{path}: one class is empty (pos={len(pos)} neg={len(neg)})"
        miss = sum(1 for p in pos if p < th) / len(pos)
        false = sum(1 for n in neg if n >= th) / len(neg)
        lat = sorted(r[3] for r in rows)
        p50 = lat[len(lat) // 2]
        a = auc(pos, neg)
        f1, th_star = best_f1(pos, neg)
        print(
            f"{label:<18} {th:>5.2f} {miss:>11.1%} {false:>12.1%} {a:>7.3f} {f1:>7.3f} {th_star:>6.2f} {p50:>7.2f}"
        )
        n = len(pos)
        print(f"{'':<18}   (n_pos={n} n_neg={len(neg)}, miss={sum(1 for p in pos if p < th)}/{n}, false={sum(1 for x in neg if x >= th)}/{len(neg)})")


if __name__ == "__main__":
    main()
