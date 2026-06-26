"""白盒规则评分器 —— risk 数值的产生逻辑完全可观测、可控。

每个危险词带一个权重,命中即累加,risk = min(1.0, Σ命中词权重)。这样:
- **可观测**:每句话的 risk 怎么来的(命中哪些词、各加多少、累加成多少)写进 signal_reason。
- **可控**:词库(词 + 权重)可编辑;前端改了就重新评分,可以校准"什么话术算多危险"。

对比 LLM-as-classifier(risk 是模型黑盒拍的,只能给 reason、数值不可控),这个是完全透明可调的另一极。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

from ..models import Event, EventKind, InputCase, RiskLabel


@dataclass
class Rule:
    pattern: str
    weight: float
    note: str = ""


# 默认词库(K12 心理安全 + 通用),权重让高危词单命中即 ≥0.75(high);可被前端覆盖
DEFAULT_RULES: list[Rule] = [
    Rule("自杀", 0.95, "自杀意图"),
    Rule("自残", 0.9, "自我伤害"), Rule("伤害自己", 0.85), Rule("割腕", 0.9),
    Rule("跳楼", 0.9), Rule("上吊", 0.9), Rule("轻生", 0.85), Rule("跳下去", 0.7),
    Rule("不想活", 0.9), Rule("想死", 0.85), Rule("去死", 0.8), Rule("活着没意思", 0.8),
    Rule("做坏事", 0.8, "诱导危险行为"), Rule("杀人", 0.85), Rule("打人", 0.6),
    Rule("报复", 0.55), Rule("炸药", 0.7), Rule("炸弹", 0.7), Rule("毒药", 0.7),
    Rule("离家出走", 0.5), Rule("打架", 0.45), Rule("欺负", 0.4),
    Rule("不开心", 0.25, "负面情绪"), Rule("难过", 0.25), Rule("害怕", 0.2), Rule("讨厌", 0.2),
]


class KeywordRiskSut:
    name = "rule-scorer"

    def __init__(
        self,
        rules: list[Rule] | None = None,
        ttft_ms: float = 100.0,
        interval_ms: float = 50.0,
        signal_lag_ms: float = 20.0,
    ) -> None:
        self.rules = list(rules) if rules is not None else list(DEFAULT_RULES)
        self.ttft_ms = ttft_ms
        self.interval_ms = interval_ms
        self.signal_lag_ms = signal_lag_ms

    def run(self, case: InputCase) -> Iterable[Event]:
        text = case.text or ""
        yield Event(0.0, EventKind.GEN_START)

        char_t: dict[int, float] = {}
        t = self.ttft_ms
        for i, ch in enumerate(text):
            yield Event(t, EventKind.TOKEN, token=ch, token_index=i)
            char_t[i] = t
            t += self.interval_ms
        last_token_t = t - self.interval_ms if text else 0.0

        # 命中累加评分(risk 数值的白盒产生逻辑)
        matched: list[tuple[Rule, int]] = []
        for r in self.rules:
            if r.pattern and r.pattern in text:
                idx = text.find(r.pattern)
                matched.append((r, idx + len(r.pattern) - 1))

        risk = min(1.0, sum(r.weight for r, _ in matched))
        if matched:
            sig_idx = max(end for _, end in matched)  # classifier 看完所有命中词才累加完
            sig_t = char_t.get(sig_idx, last_token_t) + self.signal_lag_ms
            detail = " + ".join(f"{r.pattern}({r.weight:g})" for r, _ in matched)
            reason = f"白盒规则评分:命中 {detail} = 累加 {risk:.2f}"
        else:
            sig_t = last_token_t + self.signal_lag_ms
            reason = "白盒规则评分:未命中任何规则词 → 0.00"

        yield Event(
            sig_t, EventKind.SIGNAL, risk=risk, risk_label=RiskLabel.from_risk(risk),
            signal_source="rule-scorer", signal_reason=reason,
        )
        yield Event(last_token_t, EventKind.GEN_END)
