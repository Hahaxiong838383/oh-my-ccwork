"""适配层抽象(每 Tier 一个)——ARCHITECTURE.md §3 ADP 层。

``引擎私有事件 → 归一化契约事件``。记忆内核只认契约,适配器是「引擎热插」的关节。
返回 ``None`` 表示该引擎事件不进契约(如纯音频帧 / 心跳)。
"""

from __future__ import annotations

from abc import ABC, abstractmethod

from ..contract.events import ContractEvent
from ..engines.base import EngineEvent


class ExperienceEngineAdapter(ABC):
    @abstractmethod
    def translate(self, raw: EngineEvent) -> ContractEvent | None:
        """翻译一个引擎事件为归一化契约事件;不可映射的返回 ``None``。"""


__all__ = ["ExperienceEngineAdapter"]
