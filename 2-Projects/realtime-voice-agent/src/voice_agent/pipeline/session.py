"""会话编排:体验引擎 ↔ 适配器 ↔ 记忆内核(ARCHITECTURE.md §2/§7.1)。

热路径(引擎内部 STT→LLM→TTS)由引擎自身负责;本类负责:
1. 消费引擎事件 → 适配器归一化 → 冷路径交内核;
2. ``turn_committed`` 后把内核 Context 注入回引擎(热路径下一轮)。
"""

from __future__ import annotations

import logging

from ..adapters.base import ExperienceEngineAdapter
from ..contract.events import ContractEvent, UserTurnCommitted
from ..engines.base import EngineEvent, ExperienceEngine
from ..kernel import MemoryKernel
from .cold_path import ColdPathProcessor

logger = logging.getLogger("voice_agent.session")


class VoiceSession:
    def __init__(
        self,
        engine: ExperienceEngine,
        adapter: ExperienceEngineAdapter,
        kernel: MemoryKernel,
    ) -> None:
        self._engine = engine
        self._adapter = adapter
        self._kernel = kernel
        self._cold = ColdPathProcessor(kernel)

    async def feed(self, raw: EngineEvent) -> ContractEvent | None:
        """单步:引擎事件 → 归一化 → 冷路径 → (committed 时)Context 注入。

        纯逻辑,可脱离真 SDK 单测(喂 ``EngineEvent``,断言契约与记忆副作用)。
        """
        event = self._adapter.translate(raw)
        if event is None:
            return None
        logger.info("契约 %s turn=%s", type(event).__name__, getattr(event, "turn_id", "-"))
        await self._cold.process(event)
        if isinstance(event, UserTurnCommitted):
            await self._engine.inject_context(self._kernel.context())
        return event

    async def run(self) -> None:
        """主循环:消费引擎事件流。骨架引擎为空流,即刻正常返回。"""
        await self._engine.start()
        try:
            async for raw in self._engine.events():
                await self.feed(raw)
        finally:
            await self._engine.aclose()

    @property
    def kernel(self) -> MemoryKernel:
        return self._kernel


__all__ = ["VoiceSession"]
