"""Serial-block:串行阻断(PRD 的 Baseline)。

classifier 对内容判定完成后才决定是否/如何输出,不允许提前输出。
判定完成时刻取最后一个(含延迟注入的)信号 —— 代表 classifier 看完全文才放行。
特性:零泄漏,但首字延迟 = 判定完成时间(高)。
"""

from __future__ import annotations

from ..models import ActionKind, Decision, ReplayResult, Trace
from .base import Emit, Knobs, finalize, shifted_signals


class SerialBlock:
    name = "serial-block"

    def replay(self, trace: Trace, knobs: Knobs) -> ReplayResult:
        sigs = shifted_signals(trace, knobs)
        judge_ms = sigs[-1].t_ms if sigs else trace.gen_end_ms()

        if trace.is_harmful(knobs.high_threshold):
            decisions = [
                Decision(
                    t_ms=judge_ms,
                    action=ActionKind.CANCEL,
                    risk_label=trace.max_risk_label(),
                    reason="serial: 判定危险,阻断原始输出并兜底",
                )
            ]
            emits = [Emit(judge_ms, knobs.fallback_text, original=False)]
            return finalize(trace, self.name, emits, decisions, knobs, safe_confirmed_ms=None)

        # 判定安全:判定完成后整体放行(此刻全文已生成好)
        emits = [
            Emit(judge_ms, t.token or "", original=True, token_index=t.token_index)
            for t in trace.tokens()
        ]
        decisions = [Decision(t_ms=judge_ms, action=ActionKind.PASS, reason="serial: 判定安全,判后整体放行")]
        return finalize(trace, self.name, emits, decisions, knobs, safe_confirmed_ms=judge_ms)
