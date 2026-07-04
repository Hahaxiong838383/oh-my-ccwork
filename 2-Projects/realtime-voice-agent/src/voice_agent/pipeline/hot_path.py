"""热路径(低延迟优先,不写真值)——ARCHITECTURE.md §5。

目标:把端到端 ~1s 守住。延迟不藏在 STT/TTS,藏在 **turn-taking 判停** 与
**LLM 首 token(TTFT)**(PRODUCT-DEFINITION §4 反直觉锚点)——调优先打这两处。

本文件是单回合延迟分段埋点(运行时);聚合门槛在 ``eval.metrics``
(LiveKit ``metrics_collected`` 内置可喂这些字段)。
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class LatencySample:
    """一个回合的端到端延迟分段(ms):用户停说 → 首音频回包(TTS 用 TTFA)。"""

    eou_detect_ms: float = 0.0  # 判停迟滞:真结束 → 判定结束
    llm_ttft_ms: float = 0.0  # LLM 首 token(延迟关键之一)
    tts_ttfa_ms: float = 0.0  # TTS 首音频
    total_ms: float = 0.0  # 端到端(§5 门槛 P95<1.2s)

    def within_budget(self, budget_ms: float = 1200.0) -> bool:
        return self.total_ms <= budget_ms


__all__ = ["LatencySample"]
