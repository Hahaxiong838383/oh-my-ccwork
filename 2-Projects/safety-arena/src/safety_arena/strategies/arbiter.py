"""Arbiter:实时分级仲裁(PRD 的 Proposed 核心)。

按放行时刻的最新判定分级动作:
  high   → cancel:丢弃并注入兜底,停止;
  medium → truncate:保留已放行内容,停止后续(不兜底);
  low/none → pass:放行。
带可选反应缓冲 k(默认 0,纯实时)。相比一刀切的 parallel-buffer,分级能在 medium 早停,
对最终危险输入往往泄漏更少 —— 但若 classifier 太慢(放行时还没判出 high),一样救不回来。
"""

from __future__ import annotations

from ..models import ActionKind, Decision, ReplayResult, Trace
from .base import Emit, Knobs, finalize, latest_label_at, planned_emits, shifted_signals


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
            if lbl.severity() >= knobs.high_threshold.severity():
                decisions.append(
                    Decision(
                        t_ms=et,
                        action=ActionKind.CANCEL,
                        risk=risk,
                        risk_label=lbl,
                        token_index=t.token_index,
                        reason="arbiter: high → 取消并兜底",
                    )
                )
                emits.append(Emit(et, knobs.fallback_text, original=False))
                return finalize(trace, self.name, emits, decisions, knobs, safe_confirmed_ms=None)

            if lbl.severity() >= knobs.medium_threshold.severity():
                decisions.append(
                    Decision(
                        t_ms=et,
                        action=ActionKind.TRUNCATE,
                        risk=risk,
                        risk_label=lbl,
                        token_index=t.token_index,
                        reason="arbiter: medium → 截断,保留已放行",
                    )
                )
                break  # 保留已放行原始内容,不再放新 token,不注入兜底

            emits.append(Emit(et, t.token or "", original=True, token_index=t.token_index))

        harmful = trace.is_harmful(knobs.high_threshold)
        safe_ms = None if harmful else (sigs[-1].t_ms if sigs else trace.gen_end_ms())
        return finalize(trace, self.name, emits, decisions, knobs, safe_confirmed_ms=safe_ms)
