"""稳定契约层(不变)。

记忆内核只消费本层的事件与类型,不认任何具体体验引擎——
这是「引擎热插、记忆 IP 不重写」的根因。
"""

from .events import (
    AgentSpeechStarted,
    AgentSpeechStopped,
    AgentTranscriptFinal,
    ContractEvent,
    EventType,
    FalseInterruption,
    Interruption,
    UserSpeechStarted,
    UserTranscriptFinal,
    UserTranscriptInterim,
    UserTurnCommitted,
)
from .types import (
    CONFIDENCE_FLOOR_DEFAULT,
    Confidence,
    ItemId,
    Speaker,
    SpeakerId,
    TurnId,
)

__all__ = [
    # events
    "EventType",
    "ContractEvent",
    "UserSpeechStarted",
    "UserTranscriptInterim",
    "UserTranscriptFinal",
    "UserTurnCommitted",
    "Interruption",
    "FalseInterruption",
    "AgentSpeechStarted",
    "AgentSpeechStopped",
    "AgentTranscriptFinal",
    # types
    "TurnId",
    "ItemId",
    "SpeakerId",
    "Speaker",
    "Confidence",
    "CONFIDENCE_FLOOR_DEFAULT",
]
