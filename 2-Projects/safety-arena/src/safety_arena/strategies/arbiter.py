"""Arbiter:实时分级仲裁(PRD 的 Proposed 核心)。

按放行时刻的最新判定分级动作(等级用当前可编辑阈值算出):
  high   → cancel:丢弃并注入兜底,停止;
  medium → truncate:保留已放行内容,停止后续(不兜底);
  low/none → pass:放行。
带可选反应缓冲 k(默认 0,纯实时)。调低 medium 阈值能让"擦边句"触发 truncate,
此时 arbiter 与 parallel-buffer 行为分化 —— 差异就显出来了。
"""

from __future__ import annotations

from ..models import ActionKind, Decision, ReplayResult, RiskLabel, Trace
from .base import Emit, Knobs, finalize, latest_label_at, planned_emits, shifted_signals, trace_is_harmful


class Arbiter:
    name = "arbiter"

    def __init__(self, reaction_buffer: int | None = None) -> None:
        self.reaction_buffer = reaction_buffer

    def replay(self, trace: Trace, knobs: Knobs) -> ReplayResult:
        k = self.reaction_buffer if self.reaction_buffer is not None else knobs.buffer_depth_tokens
        k = max(0, k)

        sigs = shifted_signals(trace, knobs)
        planned = planned_emits(trace, k)
        emits: list[Emit] = []
        decisions: list[Decision] = []

        for et, t in planned:
            lbl, risk, _ = latest_label_at(sigs, et)
            if lbl.severity() >= RiskLabel.HIGH.severity():
                decisions.append(
                    Decision(
                        t_ms=et, action=ActionKind.CANCEL, risk=risk, risk_label=lbl,
                        token_index=t.token_index, reason="arbiter: high → 取消并兜底",
                    )
                )
                emits.append(Emit(et, knobs.fallback_text, original=False))
                return finalize(trace, self.name, emits, decisions, knobs, safe_confirmed_ms=None)

            if lbl.severity() >= RiskLabel.MEDIUM.severity():
                decisions.append(
                    Decision(
                        t_ms=et, action=ActionKind.TRUNCATE, risk=risk, risk_label=lbl,
                        token_index=t.token_index, reason="arbiter: medium → 截断,保留已放行",
                    )
                )
                break

            emits.append(Emit(et, t.token or "", original=True, token_index=t.token_index))

        harmful = trace_is_harmful(trace, knobs)
        safe_ms = None if harmful else (sigs[-1].t_ms if sigs else trace.gen_end_ms())
        return finalize(trace, self.name, emits, decisions, knobs, safe_confirmed_ms=safe_ms)
