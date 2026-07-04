"""投影器(读模型,可重建)——ARCHITECTURE.md §6 CQRS 读侧。

不变量:任何投影都能从 Event Log replay 重建;投影损坏不影响真值。
- ``WorkingSet``:当前上下文,注入热路径(写实)。
- ``VectorIndex``:语义召回,默认 sqlite-vec(骨架接口,M1 接实现)。
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Protocol, runtime_checkable

from .event_log import LogRecord
from .model import AgentTurn, MemoryFact


class WorkingSet:
    """当前对话上下文投影。``key`` → 最新(仲裁后)事实。从 Log replay 可重建。"""

    def __init__(self) -> None:
        self._facts: dict[str, MemoryFact] = {}
        self._recent_agent_turns: list[AgentTurn] = []

    def apply(self, record: LogRecord) -> None:
        payload = record.payload
        if isinstance(payload, MemoryFact):
            self._facts[payload.key] = payload
        elif isinstance(payload, AgentTurn):
            self._recent_agent_turns.append(payload)

    def rebuild_from(self, records: Iterable[LogRecord]) -> None:
        """从 Event Log replay 重建(投影可重建不变量)。"""
        self._facts.clear()
        self._recent_agent_turns.clear()
        for record in records:
            self.apply(record)

    def get_fact(self, key: str) -> MemoryFact | None:
        return self._facts.get(key)

    def facts(self) -> dict[str, str]:
        return {k: f.value for k, f in self._facts.items()}

    def context(self) -> str:
        """组装注入热路径 LLM 的上下文(骨架:简单拼接,M1 按 token 预算裁剪)。"""
        return "\n".join(f"{k}: {f.value}" for k, f in self._facts.items())


@runtime_checkable
class VectorIndex(Protocol):
    """语义召回投影(骨架协议)。默认 sqlite-vec;可换实现。"""

    def index(self, record: LogRecord) -> None: ...

    def query(self, text: str, k: int = 5) -> list[MemoryFact]: ...


class NullVectorIndex:
    """骨架空实现:不召回。M1 换 sqlite-vec(见 ``pyproject`` ``[vector]``)。"""

    def index(self, record: LogRecord) -> None:
        # TODO(M1): upsert 向量到 sqlite-vec
        return None

    def query(self, text: str, k: int = 5) -> list[MemoryFact]:
        # TODO(M1): 语义召回 top-k
        return []
