"""体验引擎层抽象(可插拔 / 变)——ARCHITECTURE.md §3 EXP 层。

职责:管理音频 / SDK 生命周期,产出**引擎私有事件**流,接收记忆内核 Context 注入。
引擎私有事件 → 归一化契约由对应 ``adapters`` 完成,**记忆内核零改动**。
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, ClassVar


class Tier(StrEnum):
    """体验引擎档位(PRODUCT-DEFINITION §1/§3)。"""

    A_CASCADE = "tier_a_cascade"  # ★MVP:cascade,无需 GPU,媲美火山 RTC
    B_REALTIME = "tier_b_realtime"  # 托管 Realtime(豆包 Seeduplex / OpenAI)
    C_DUPLEX = "tier_c_duplex"  # 自托管双流(Moshi / PersonaPlex,需 GPU)


@dataclass(frozen=True, slots=True)
class EngineEvent:
    """引擎私有事件(未归一化)。``kind`` 由各 Tier 自定义,适配层负责翻成契约。"""

    kind: str
    data: dict[str, Any] = field(default_factory=dict)


class ExperienceEngine(ABC):
    """可插拔体验引擎。升级体验 = 换引擎 + 写适配器,记忆 IP 不重写。"""

    tier: ClassVar[Tier]

    @abstractmethod
    async def start(self) -> None:
        """建立 RTC 连接 / 加载模型 / 起 SDK。"""

    @abstractmethod
    def events(self) -> AsyncIterator[EngineEvent]:
        """引擎私有事件异步流(VAD / STT / TTS / 打断 …)。"""

    @abstractmethod
    async def inject_context(self, context: str) -> None:
        """把记忆内核投影的 Context 注入热路径(下一次 LLM 调用)。"""

    @abstractmethod
    async def aclose(self) -> None:
        """收口:断开连接 / 释放资源。"""


__all__ = ["Tier", "EngineEvent", "ExperienceEngine"]
