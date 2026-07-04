"""契约基础类型 — 贯穿全系统的标识符与枚举。

属于「稳定契约」(ARCHITECTURE.md §3/§4),跨体验引擎不变。
记忆内核只认这些类型,不认任何具体引擎。
"""

from __future__ import annotations

from enum import StrEnum
from typing import NewType

# 标识符:NewType 在类型层面区分,运行时即 str(零开销)。
TurnId = NewType("TurnId", str)
"""贯穿一个回合(turn)。从 speech_started 到 turn_committed/interruption。"""

ItemId = NewType("ItemId", str)
"""用于排序 / 对账。采用 OpenAI 对账约定(见 PRODUCT-DEFINITION §6 迟到 final 对账)。"""

SpeakerId = NewType("SpeakerId", str)
"""说话人标识(多说话人场景),与 Speaker 角色正交。"""


class Speaker(StrEnum):
    """事件归属的角色。"""

    USER = "user"
    AGENT = "agent"


# 抽取置信度(冷路径)。低于 floor 的事实进 low-confidence state,不进真值。
Confidence = float
"""0.0–1.0。STT drift 防污染门控用(PRODUCT-DEFINITION §6)。"""

CONFIDENCE_FLOOR_DEFAULT: Confidence = 0.6
