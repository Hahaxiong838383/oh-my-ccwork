"""离线回放 / 审计(ARCHITECTURE.md §6)。

审计 = 对 Event Log 做**文字级 replay**(端到端黑盒给不了,这是护城河)。
- ``audit_trail``:导出每条记录的文字审计行(合规可审计记录)。
- ``rebuild_working_set``:从 Log 重建投影,验证"投影可重建"不变量(§6)。
"""

from __future__ import annotations

from collections.abc import Iterator

from ..kernel.event_log import EventLog
from ..kernel.projections import WorkingSet


def audit_trail(log: EventLog) -> Iterator[str]:
    """逐条产出文字审计行(seq / ts / 类型 / 幂等键前缀)。"""
    for record in log.replay():
        payload_type = type(record.payload).__name__
        yield (
            f"#{record.seq} ts={record.ts} {payload_type} "
            f"key={record.idempotency_key[:12]}"
        )


def rebuild_working_set(log: EventLog) -> WorkingSet:
    """从 Event Log replay 重建 Working Set(灾后恢复 / 一致性校验)。"""
    working_set = WorkingSet()
    working_set.rebuild_from(log.replay())
    return working_set


__all__ = ["audit_trail", "rebuild_working_set"]
