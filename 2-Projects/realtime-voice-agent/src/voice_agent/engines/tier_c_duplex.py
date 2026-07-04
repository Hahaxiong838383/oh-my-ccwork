"""Tier C:自托管双流(ARCHITECTURE.md §8 / PRODUCT-DEFINITION §3)。

Moshi / PersonaPlex 等原生双流模型,**需 GPU**,离线可用。
同 Tier B:turn 边界由旁挂 STT + turn detector 合成,记忆内核零改动。

骨架:lifecycle 空实现 + ``TODO``;真实接线(GPU + 模型权重)放方法体内。
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import ClassVar

from ..config import Settings
from .base import EngineEvent, ExperienceEngine, Tier


class TierCDuplexEngine(ExperienceEngine):
    tier: ClassVar[Tier] = Tier.C_DUPLEX

    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    async def start(self) -> None:
        # TODO(M4): 加载自托管双流模型(GPU)+ 旁挂 STT 通道。
        return None

    async def events(self) -> AsyncIterator[EngineEvent]:
        # TODO(M4): 桥接双流模型事件 + 旁挂 STT 的 final/EOU。
        for _ in ():
            yield EngineEvent(kind="noop")

    async def inject_context(self, context: str) -> None:
        # TODO(M4): 注入到模型上下文。
        return None

    async def aclose(self) -> None:
        return None
