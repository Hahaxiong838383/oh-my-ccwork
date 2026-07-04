"""冷路径(一致性优先,不阻塞说话)——ARCHITECTURE.md §5。

``turn_committed`` → 抽取 + backchannel 闸 + 去重 → 来源优先级仲裁 →
Event Log append(幂等) → 投影。这条链全部封装在记忆内核;本类是**异步边界**:
冷路径慢一点不影响热路径回包,只有 Context 注入回到热路径。
"""

from __future__ import annotations

from ..contract.events import ContractEvent
from ..kernel import MemoryKernel


class ColdPathProcessor:
    """冷路径处理器:把契约事件交给记忆内核,与热路径解耦。"""

    def __init__(self, kernel: MemoryKernel) -> None:
        self._kernel = kernel

    async def process(self, event: ContractEvent) -> None:
        # M1: 放独立 task / 队列,确保抽取+仲裁+投影不阻塞热路径回包。
        self._kernel.handle(event)

    def context(self) -> str:
        return self._kernel.context()


__all__ = ["ColdPathProcessor"]
