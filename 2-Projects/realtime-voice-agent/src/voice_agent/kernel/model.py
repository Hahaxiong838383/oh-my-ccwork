"""记忆内核领域模型(恒定层内部,不可变)。

属于记忆内核(ARCHITECTURE.md §6/§7),与体验引擎无关。
全部 ``frozen``——记忆事实一旦进 Event Log 不可变(工程红线 + 审计可 replay)。
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import IntEnum

from ..contract.types import Confidence, ItemId, TurnId


class SourceTier(IntEnum):
    """来源优先级(来源仲裁用,**非 LLM confidence**,避免幻觉自证)。

    数字大 = 优先级高,高优先级覆盖低优先级
    (ARCHITECTURE.md §6 STT drift 对策:来源优先级仲裁覆盖低置信)。
    """

    LOW_CONFIDENCE = 0  # 低于置信度门 → 进 low-confidence state,不进真值
    INFERRED = 1  # 模型从对话推断
    USER_STATED = 3  # 用户明确陈述
    SYSTEM_VERIFIED = 4  # 工具 / 系统校验过的事实


@dataclass(frozen=True, slots=True)
class Provenance:
    """一条记忆事实的来源溯源(审计 + 仲裁依据)。"""

    turn_id: TurnId
    item_id: ItemId
    source: SourceTier
    confidence: Confidence
    ts: float


@dataclass(frozen=True, slots=True)
class MemoryFact:
    """冷路径抽取出的一条记忆事实。``key`` 归一化后用于去重与仲裁。"""

    key: str
    value: str
    provenance: Provenance


@dataclass(frozen=True, slots=True)
class AgentTurn:
    """agent 的一个回合(记录用,不参与用户事实仲裁)。"""

    turn_id: TurnId
    item_id: ItemId
    text: str
    ts: float
