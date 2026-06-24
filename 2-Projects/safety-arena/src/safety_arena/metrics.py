"""指标聚合:把 ReplayResult 集合按策略分组,算 latency 向量 / leakage / 干预率。

刻意分开报 latency 向量(TTFT / first-safe / total),不揉成一个标量 —— 并行赢在 TTFT,
但加 buffer 防泄漏后 TTFT 回退,只有看向量才不会被误导。leakage 是并行架构的真实代价侧。
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from .models import ReplayResult


def percentile(values: list[float], p: float) -> float | None:
    xs = sorted(v for v in values if v is not None)
    if not xs:
        return None
    if len(xs) == 1:
        return xs[0]
    idx = (len(xs) - 1) * p / 100.0
    lo, hi = math.floor(idx), math.ceil(idx)
    if lo == hi:
        return xs[lo]
    return xs[lo] * (hi - idx) + xs[hi] * (idx - lo)


@dataclass
class LatencyVector:
    p50: float | None = None
    p95: float | None = None
    p99: float | None = None
    mean: float | None = None


def _vec(values: list[float | None]) -> LatencyVector:
    xs = [v for v in values if v is not None]
    mean = sum(xs) / len(xs) if xs else None
    return LatencyVector(percentile(xs, 50), percentile(xs, 95), percentile(xs, 99), mean)


@dataclass
class StrategyMetrics:
    strategy: str
    n: int
    ttft: LatencyVector
    first_safe: LatencyVector
    total: LatencyVector
    leakage_rate: float        # 有泄漏(leaked_tokens>0)的样本占比
    mean_leaked_tokens: float
    max_leaked_tokens: int
    intervention_rate: float


def aggregate(results: list[ReplayResult]) -> dict[str, StrategyMetrics]:
    groups: dict[str, list[ReplayResult]] = {}
    for r in results:
        groups.setdefault(r.strategy_name, []).append(r)

    out: dict[str, StrategyMetrics] = {}
    for name, rs in groups.items():
        n = len(rs)
        leaked = [r.leaked_tokens for r in rs]
        out[name] = StrategyMetrics(
            strategy=name,
            n=n,
            ttft=_vec([r.ttft_ms for r in rs]),
            first_safe=_vec([r.first_safe_token_ms for r in rs]),
            total=_vec([r.total_ms for r in rs]),
            leakage_rate=sum(1 for x in leaked if x > 0) / n,
            mean_leaked_tokens=sum(leaked) / n,
            max_leaked_tokens=max(leaked) if leaked else 0,
            intervention_rate=sum(1 for r in rs if r.intervened) / n,
        )
    return out


def format_table(metrics: dict[str, StrategyMetrics]) -> str:
    """给 CLI / 调试用的 markdown 表(数值 ms 取整)。"""

    def ms(v: float | None) -> str:
        return "-" if v is None else f"{v:.0f}"

    rows = [
        "| strategy | n | TTFT p50/p95 | first-safe p50 | total p50 | leak率 | 均泄漏 | 干预率 |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for name, m in metrics.items():
        rows.append(
            f"| {name} | {m.n} | {ms(m.ttft.p50)}/{ms(m.ttft.p95)} | {ms(m.first_safe.p50)} "
            f"| {ms(m.total.p50)} | {m.leakage_rate:.0%} | {m.mean_leaked_tokens:.1f} | {m.intervention_rate:.0%} |"
        )
    return "\n".join(rows)
