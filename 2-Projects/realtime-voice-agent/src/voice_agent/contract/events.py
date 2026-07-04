"""归一化契约事件模型(稳定契约的核心,ARCHITECTURE.md §4)。

设计要点:
- **不可变**:全部 ``frozen=True`` dataclass,事件一旦生成不再修改(工程红线)。
- **唯一提交点**:只有 ``UserTurnCommitted`` 触发记忆内核 COMMIT;``interim`` 永远只维持 DRAFT。
- **三 Tier 同一组事件**:Tier B/C turn 边界糊时,适配层旁挂 STT + turn detector **合成**
  ``UserTurnCommitted``(见 adapters)。

每个事件携带 ``EVENT_TYPE`` 类变量(不算 dataclass 字段,不影响字段顺序),
便于按类型路由与序列化。
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import ClassVar

from .types import Confidence, ItemId, SpeakerId, TurnId


class EventType(StrEnum):
    """归一化事件类型(契约最小公共集)。"""

    USER_SPEECH_STARTED = "user.speech_started"
    USER_TRANSCRIPT_INTERIM = "user.transcript.interim"
    USER_TRANSCRIPT_FINAL = "user.transcript.final"
    USER_TURN_COMMITTED = "user.turn_committed"
    INTERRUPTION = "interruption"
    FALSE_INTERRUPTION = "false_interruption"
    AGENT_SPEECH_STARTED = "agent.speech_started"
    AGENT_SPEECH_STOPPED = "agent.speech_stopped"
    AGENT_TRANSCRIPT_FINAL = "agent.transcript.final"


@dataclass(frozen=True, slots=True)
class UserSpeechStarted:
    """用户开口(VAD 驱动)→ 开一个 turn。"""

    EVENT_TYPE: ClassVar[EventType] = EventType.USER_SPEECH_STARTED
    turn_id: TurnId
    ts: float


@dataclass(frozen=True, slots=True)
class UserTranscriptInterim:
    """STT 中间结果 → **仅维持 DRAFT,不提交**。"""

    EVENT_TYPE: ClassVar[EventType] = EventType.USER_TRANSCRIPT_INTERIM
    turn_id: TurnId
    text: str
    ts: float
    language: str | None = None  # 中英混说分段(附录 C.2 lang;国内刚需)


@dataclass(frozen=True, slots=True)
class UserTranscriptFinal:
    """STT 最终化 → COMMIT 候选(尚未提交)。"""

    EVENT_TYPE: ClassVar[EventType] = EventType.USER_TRANSCRIPT_FINAL
    turn_id: TurnId
    item_id: ItemId
    text: str
    ts: float
    speaker_id: SpeakerId | None = None
    language: str | None = None  # 中英混说分段(附录 C.2 lang)
    confidence: Confidence | None = None  # 转写置信度(附录 C.2 conf?),喂冷路径置信度门


@dataclass(frozen=True, slots=True)
class UserTurnCommitted:
    """语义 EOU = **唯一提交点**。记忆内核在此 + 抽取完成后才写真值。"""

    EVENT_TYPE: ClassVar[EventType] = EventType.USER_TURN_COMMITTED
    turn_id: TurnId
    item_id: ItemId
    final_text: str
    ts: float


@dataclass(frozen=True, slots=True)
class Interruption:
    """真打断(barge-in)→ 冻结/丢弃该 turn 的 DRAFT(零成本回滚)。"""

    EVENT_TYPE: ClassVar[EventType] = EventType.INTERRUPTION
    turn_id: TurnId
    is_interruption: bool
    heard_ms: int  # 用户已听到时长(打断截断语义)
    ts: float


@dataclass(frozen=True, slots=True)
class FalseInterruption:
    """假打断(噪声/回声)→ **不动记忆**。"""

    EVENT_TYPE: ClassVar[EventType] = EventType.FALSE_INTERRUPTION
    turn_id: TurnId
    ts: float


@dataclass(frozen=True, slots=True)
class AgentSpeechStarted:
    """agent 开口 → 状态机推进。"""

    EVENT_TYPE: ClassVar[EventType] = EventType.AGENT_SPEECH_STARTED
    turn_id: TurnId
    ts: float


@dataclass(frozen=True, slots=True)
class AgentSpeechStopped:
    """agent 收口 → 状态机推进。"""

    EVENT_TYPE: ClassVar[EventType] = EventType.AGENT_SPEECH_STOPPED
    turn_id: TurnId
    ts: float


@dataclass(frozen=True, slots=True)
class AgentTranscriptFinal:
    """agent 输出转录 → 记 agent 回合。"""

    EVENT_TYPE: ClassVar[EventType] = EventType.AGENT_TRANSCRIPT_FINAL
    turn_id: TurnId
    item_id: ItemId
    text: str
    ts: float


# 契约事件全集(记忆内核消费的最小公共集)。
ContractEvent = (
    UserSpeechStarted
    | UserTranscriptInterim
    | UserTranscriptFinal
    | UserTurnCommitted
    | Interruption
    | FalseInterruption
    | AgentSpeechStarted
    | AgentSpeechStopped
    | AgentTranscriptFinal
)

__all__ = [
    "EventType",
    "UserSpeechStarted",
    "UserTranscriptInterim",
    "UserTranscriptFinal",
    "UserTurnCommitted",
    "Interruption",
    "FalseInterruption",
    "AgentSpeechStarted",
    "AgentSpeechStopped",
    "AgentTranscriptFinal",
    "ContractEvent",
]
