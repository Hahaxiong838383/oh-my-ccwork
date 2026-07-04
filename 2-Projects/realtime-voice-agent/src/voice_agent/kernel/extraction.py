"""冷路径抽取 + backchannel 三道闸 + 置信度门(ARCHITECTURE.md §6/§7)。

三道闸(防 backchannel "嗯/对" 误提交污染):
1. VAD 空转写闸(体验引擎层,``raise StopResponse`` 发 DISCARD)——不在此文件。
2. 语义闸(M1 接语义判停)。
3. **文本 backchannel 闸**(本文件 ``is_backchannel``)——拦短应答词。

置信度门:低于 ``floor`` 的抽取结果进 low-confidence(``SourceTier.LOW_CONFIDENCE``),
不进真值。``extract()`` 主体是骨架:M1 接 LLM 结构化抽取。
"""

from __future__ import annotations

from ..contract.events import UserTurnCommitted
from ..contract.types import CONFIDENCE_FLOOR_DEFAULT, Confidence
from .model import MemoryFact

# 文本第三道闸:常见中文 backchannel / 应答词(非完整 turn)。
_BACKCHANNEL_TOKENS: frozenset[str] = frozenset(
    {
        "嗯",
        "嗯嗯",
        "对",
        "对对",
        "好",
        "好的",
        "哦",
        "噢",
        "是",
        "是的",
        "ok",
        "啊",
        "诶",
    }
)


class Extractor:
    def __init__(self, confidence_floor: Confidence = CONFIDENCE_FLOOR_DEFAULT) -> None:
        self._floor = confidence_floor

    def is_backchannel(self, text: str) -> bool:
        """文本第三道闸:纯应答词 / 空 → ``True``(不进抽取)。"""
        stripped = text.strip().strip("。.!！?？, ，").lower()
        return stripped == "" or stripped in _BACKCHANNEL_TOKENS

    def extract(self, committed: UserTurnCommitted) -> list[MemoryFact]:
        """从已提交 turn 抽取记忆事实。

        骨架:M1 接 LLM 结构化抽取 + 置信度评分。此处返回空(不臆造事实)。
        被 backchannel 闸拦下的不会走到这里(见 ``MemoryKernel``)。
        """
        # TODO(M1): 调 LLM 抽取 (key, value, confidence);
        #           confidence < floor → SourceTier.LOW_CONFIDENCE,不进真值。
        return []

    def floor(self) -> Confidence:
        return self._floor
