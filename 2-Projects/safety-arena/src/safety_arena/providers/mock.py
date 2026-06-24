"""确定性 mock SUT —— 单测与离线开发用,不含任何随机/时钟读取。

一个 MockScript 描述:token 序列 + 首 token 延迟 + token 间隔 + 若干 (t_ms, risk) 信号。
这样可以精确构造"classifier 早判 / 晚判""安全 / 危险"等场景,验证策略行为。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable

from ..models import Event, EventKind, InputCase, RiskLabel


@dataclass
class MockScript:
    tokens: list[str]
    ttft_ms: float = 100.0                 # 首 token 到达时间
    token_interval_ms: float = 40.0        # 相邻 token 间隔
    signals: list[tuple[float, float]] = field(default_factory=list)  # [(t_ms, risk 0..1)]
    gen_start_ms: float = 0.0


class MockSut:
    name = "mock"

    def __init__(
        self,
        scripts: dict[str, MockScript] | None = None,
        default: MockScript | None = None,
    ) -> None:
        self.scripts = scripts or {}
        self.default = default

    def run(self, case: InputCase) -> Iterable[Event]:
        script = self.scripts.get(case.id) or self.default
        if script is None:
            raise KeyError(f"mock SUT 没有 case {case.id!r} 的脚本")

        yield Event(script.gen_start_ms, EventKind.GEN_START)

        t = script.ttft_ms
        last_token_t = script.gen_start_ms
        for i, tok in enumerate(script.tokens):
            yield Event(t, EventKind.TOKEN, token=tok, token_index=i)
            last_token_t = t
            t += script.token_interval_ms

        for st, risk in script.signals:
            yield Event(
                st,
                EventKind.SIGNAL,
                risk=risk,
                risk_label=RiskLabel.from_risk(risk),
                signal_source="mock-classifier",
            )

        yield Event(last_token_t, EventKind.GEN_END)
