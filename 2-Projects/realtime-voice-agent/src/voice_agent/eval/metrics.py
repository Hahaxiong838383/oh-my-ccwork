"""Voice-Eval 体验质量指标(PRODUCT-DEFINITION §5)。

所有门槛是**起步值**,须在 Voice-Eval 上复现校准——这是 E0→E4 的唯一载体,
也是"真实最大风险(E4 为空)"的解药(§10)。
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

# §5 验收门槛(Tier A 媲美 RTC 起步值)。
E2E_LATENCY_P95_MS = 1200.0  # 端到端 P95 < 1.2s
EOU_FALSE_INTERRUPT_RATE = 0.05  # EOU 误打断率 < 5%(重点盯)
TURN_LATENCY_P95_MS = 1500.0  # 判停迟滞 P95 < 1.5s
BARGEIN_FALSE_POSITIVE_RATE = 0.02  # barge-in 假阳性 < 2%(AEC on)
CER_QUIET = 0.08  # 安静 CER < 8%
CER_NOISY = 0.15  # 噪声 CER < 15%


def percentile(values: Sequence[float], q: float) -> float:
    """最近秩(nearest-rank)分位数。``q`` ∈ [0, 1]。空集返回 0。"""
    if not values:
        return 0.0
    ordered = sorted(values)
    idx = int(round(q * (len(ordered) - 1)))
    idx = max(0, min(len(ordered) - 1, idx))
    return ordered[idx]


def cer(ref: str, hyp: str) -> float:
    """字错率 (S+D+I)/N,对齐 ``gold_text``(§5)。字符级 Levenshtein / N。"""
    ref_chars = list(ref)
    hyp_chars = list(hyp)
    if not ref_chars:
        return 0.0 if not hyp_chars else 1.0
    prev = list(range(len(hyp_chars) + 1))
    for i, rc in enumerate(ref_chars, start=1):
        cur = [i]
        for j, hc in enumerate(hyp_chars, start=1):
            cost = 0 if rc == hc else 1
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost))
        prev = cur
    return prev[len(hyp_chars)] / len(ref_chars)


@dataclass(frozen=True, slots=True)
class GateResult:
    """一个验收门的结果(可审计:带值、阈值、是否过)。"""

    name: str
    value: float
    threshold: float
    passed: bool


def latency_gate(
    totals_ms: Sequence[float], threshold_ms: float = E2E_LATENCY_P95_MS
) -> GateResult:
    """端到端延迟门:P95 ≤ threshold(§5 G1)。"""
    p95 = percentile(totals_ms, 0.95)
    return GateResult(
        name="e2e_latency_p95_ms",
        value=p95,
        threshold=threshold_ms,
        passed=p95 <= threshold_ms,
    )


def rate_gate(
    name: str, hits: int, total: int, threshold: float
) -> GateResult:
    """比率门(误打断率 / 假阳性率等):hits/total ≤ threshold。"""
    value = (hits / total) if total > 0 else 0.0
    return GateResult(name=name, value=value, threshold=threshold, passed=value <= threshold)


__all__ = [
    "E2E_LATENCY_P95_MS",
    "EOU_FALSE_INTERRUPT_RATE",
    "TURN_LATENCY_P95_MS",
    "BARGEIN_FALSE_POSITIVE_RATE",
    "CER_QUIET",
    "CER_NOISY",
    "percentile",
    "cer",
    "GateResult",
    "latency_gate",
    "rate_gate",
]
