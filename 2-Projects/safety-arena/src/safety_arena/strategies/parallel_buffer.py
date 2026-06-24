"""Parallel-buffer:LLM 边生成边流式,滑动缓冲 k 个 token 等 classifier 信号。

出现 high 信号即 cancel:缓冲里尚未放行的丢弃(不泄漏),已放行的算泄漏,并注入兜底。
k=0 → 零延迟全投机(最大泄漏);k≥token 数 → 退化成串行(零泄漏)。
这条 k↔leakage / k↔TTFT 曲线就是并行架构的命门。
"""

from __future__ import annotations

from ..models import ActionKind, Decision, ReplayResult, Trace
from .base import Emit, Knobs, finalize, first_high, planned_emits, shifted_signals


class ParallelBuffer:
    name = "parallel-buffer"

    def __init__(self, buffer_depth: int | None = None) -> None:
        # None → 运行时取 knobs.buffer_depth_tokens(便于按旋钮扫描)
        self.buffer_depth = buffer_depth

    def replay(self, trace: Trace, knobs: Knobs) -> ReplayResult:
        k = self.buffer_depth if self.buffer_depth is not None else knobs.buffer_depth_tokens
        k = max(0, k)
        name = f"{self.name}(k={k})"

        sigs = shifted_signals(trace, knobs)
        planned = planned_emits(trace, k)
        emits: list[Emit] = []
        decisions: list[Decision] = []

        hs = first_high(sigs, knobs)
        if hs is not None:
            cancel_ms = hs.t_ms
            for et, t in planned:
                if et < cancel_ms:  # cancel 之前已放行 → 暴露给用户
                    emits.append(Emit(et, t.token or "", original=True, token_index=t.token_index))
            decisions.append(
                Decision(
                    t_ms=cancel_ms,
                    action=ActionKind.CANCEL,
                    risk=hs.risk,
                    risk_label=hs.effective_label(),
                    reason=f"parallel(k={k}): high 信号 → 取消并兜底",
                )
            )
            emits.append(Emit(cancel_ms, knobs.fallback_text, original=False))
            return finalize(trace, name, emits, decisions, knobs, safe_confirmed_ms=None)

        # 无 high 信号:全部按计划放行
        for et, t in planned:
            emits.append(Emit(et, t.token or "", original=True, token_index=t.token_index))
        safe_ms = sigs[-1].t_ms if sigs else trace.gen_end_ms()
        return finalize(trace, name, emits, decisions, knobs, safe_confirmed_ms=safe_ms)
