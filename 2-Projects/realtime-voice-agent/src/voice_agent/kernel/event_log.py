"""Event Log — append-only 单一真相源(ARCHITECTURE.md §6 CQRS 写模型)。

不变量:
- **只追加,不修改,不删除**。任何投影损坏都能从这里 replay 重建。
- **幂等键去重**:``idempotency_key = f(turn_id, content)``;at-least-once 投递下
  重复直接幂等丢弃(ARCHITECTURE.md §9 duplicate commit 对策)。
- 审计 = 对本 Log 做文字级 replay(端到端黑盒给不了,这是 ToB 卖点)。

骨架:内存实现(list)。M1 持久化到 ``EVENT_LOG_PATH`` 下的 append-only jsonl,语义不变。
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterator
from dataclasses import dataclass

from ..contract.types import TurnId
from .model import AgentTurn, MemoryFact

# 进 Log 的领域事件(写模型命令侧的产物)。
LoggedPayload = MemoryFact | AgentTurn


@dataclass(frozen=True, slots=True)
class LogRecord:
    """Event Log 的一条不可变记录。``seq`` 单调递增,是审计 / 重建的顺序锚。"""

    seq: int
    idempotency_key: str
    payload: LoggedPayload
    ts: float


def make_idempotency_key(turn_id: TurnId, content: str) -> str:
    """``idempotency_key = f(turn_id, content)``。

    同一 turn + 同一内容 → 同一 key → 幂等丢弃(ARCHITECTURE.md §9)。
    """
    h = hashlib.sha256()
    h.update(turn_id.encode("utf-8"))
    h.update(b"\x00")
    h.update(content.encode("utf-8"))
    return h.hexdigest()


class EventLog:
    """append-only 真相源 + 幂等去重。"""

    def __init__(self) -> None:
        self._records: list[LogRecord] = []
        self._seen_keys: set[str] = set()

    def append(
        self, payload: LoggedPayload, idempotency_key: str, ts: float
    ) -> LogRecord | None:
        """追加一条记录。``idempotency_key`` 命中重复 → 幂等丢弃,返回 ``None``。"""
        if idempotency_key in self._seen_keys:
            return None
        record = LogRecord(
            seq=len(self._records),
            idempotency_key=idempotency_key,
            payload=payload,
            ts=ts,
        )
        self._records.append(record)
        self._seen_keys.add(idempotency_key)
        return record

    def replay(self) -> Iterator[LogRecord]:
        """按追加顺序回放(审计 / 投影重建)。"""
        return iter(self._records)

    def __len__(self) -> int:
        return len(self._records)

    def __iter__(self) -> Iterator[LogRecord]:
        return iter(self._records)
