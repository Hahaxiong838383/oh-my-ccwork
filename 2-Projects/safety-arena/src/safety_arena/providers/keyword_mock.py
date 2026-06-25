"""规则 mock SUT —— 让用户输入任意文本就能生成可对比的 trace。

这是 demo 级"假 classifier":token = 逐字,风险信号靠**危险词子串匹配**——
命中第一个危险词时,在该词结束位置 + 一点反应延迟发出 high 信号。
真实的 classifier + LLM 在 M3 接入,届时换掉这个 provider 即可,上层(策略/重放/指标)不动。
"""

from __future__ import annotations

from typing import Iterable

from ..models import Event, EventKind, InputCase, RiskLabel

# demo 危险词库(K12 心理安全 + 通用),仅用于演示;真检测在 M3
DEFAULT_DANGER_WORDS = [
    "自杀", "自残", "割腕", "跳楼", "上吊", "轻生", "不想活", "想死", "去死",
    "活着没意思", "活不下去", "跳下去", "伤害自己",
    "做坏事", "打人", "杀人", "报复", "炸药", "炸弹", "毒药", "离家出走", "欺负", "打架",
]


class KeywordRiskSut:
    name = "keyword-mock"

    def __init__(
        self,
        danger_words: list[str] | None = None,
        ttft_ms: float = 100.0,
        interval_ms: float = 50.0,
        signal_lag_ms: float = 20.0,
    ) -> None:
        self.danger_words = danger_words or DEFAULT_DANGER_WORDS
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

        # 找最早出现的危险词,取其结束字符位置作为 classifier "看出危险"的时刻
        hit_end: int | None = None
        hit_word: str | None = None
        for w in self.danger_words:
            idx = text.find(w)
            if idx >= 0:
                end = idx + len(w) - 1
                if hit_end is None or end < hit_end:
                    hit_end = end
                    hit_word = w

        if hit_end is not None and hit_end in char_t:
            yield Event(
                char_t[hit_end] + self.signal_lag_ms,
                EventKind.SIGNAL,
                risk=0.9,
                risk_label=RiskLabel.HIGH,
                signal_source="keyword-mock",
                signal_reason=f"命中危险词「{hit_word}」(规则子串匹配)",
            )
        else:
            yield Event(
                last_token_t + self.signal_lag_ms,
                EventKind.SIGNAL,
                risk=0.05,
                risk_label=RiskLabel.NONE,
                signal_source="keyword-mock",
                signal_reason="未命中任何危险词(规则)",
            )

        yield Event(last_token_t, EventKind.GEN_END)
