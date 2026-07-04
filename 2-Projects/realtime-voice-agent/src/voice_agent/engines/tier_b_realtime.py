"""Tier B:托管 Realtime(ARCHITECTURE.md §8 / PRODUCT-DEFINITION §3)。

豆包 Seeduplex / OpenAI Realtime 等 s2s API,零部署、按分钟计费。
turn 边界糊时,由 ``adapters.SidecarTurnSynthesizer`` 旁挂 STT + turn detector
**合成** ``UserTurnCommitted`` 喂记忆内核(内核零改动)。

骨架:lifecycle 空实现 + ``TODO``;真实接线放方法体内。
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import ClassVar

from ..config import Settings
from .base import EngineEvent, ExperienceEngine, Tier


class TierBRealtimeEngine(ExperienceEngine):
    tier: ClassVar[Tier] = Tier.B_REALTIME

    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    async def start(self) -> None:
        # TODO(M3): 连接托管 Realtime API(豆包/OpenAI)+ 旁挂 STT 通道。
        return None

    async def events(self) -> AsyncIterator[EngineEvent]:
        # TODO(M3): 桥接 s2s 事件 + 旁挂 STT 的 final/EOU。
        for _ in ():
            yield EngineEvent(kind="noop")

    async def inject_context(self, context: str) -> None:
        # TODO(M3): 注入到 Realtime session 的 instructions / context。
        return None

    async def aclose(self) -> None:
        return None
