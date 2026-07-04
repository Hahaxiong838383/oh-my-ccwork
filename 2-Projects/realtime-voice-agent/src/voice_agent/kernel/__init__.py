"""记忆内核(恒定 / CQRS)——差异化护城河。

CQRS 事件溯源,跨体验引擎不变:
- Event Log = 单一真相源(append-only);Working Set / Vector 是可重建投影。
- 唯一提交点 = ``UserTurnCommitted``;DRAFT/COMMIT 分离 → interrupt-safe。
- 冷路径抽取 + **来源优先级仲裁**(非 LLM confidence,避免幻觉自证)。
"""

from .arbitration import SourceArbiter
from .draft import DraftState, DraftStore, TurnDraft
from .event_log import EventLog, LoggedPayload, LogRecord, make_idempotency_key
from .extraction import Extractor
from .memory_kernel import MemoryKernel
from .model import AgentTurn, MemoryFact, Provenance, SourceTier
from .projections import NullVectorIndex, VectorIndex, WorkingSet

__all__ = [
    # 门面
    "MemoryKernel",
    # 写模型
    "EventLog",
    "LogRecord",
    "LoggedPayload",
    "make_idempotency_key",
    # DRAFT 状态机
    "DraftStore",
    "DraftState",
    "TurnDraft",
    # 读模型 / 投影
    "WorkingSet",
    "VectorIndex",
    "NullVectorIndex",
    # 抽取 / 仲裁
    "Extractor",
    "SourceArbiter",
    # 领域模型
    "MemoryFact",
    "AgentTurn",
    "Provenance",
    "SourceTier",
]
