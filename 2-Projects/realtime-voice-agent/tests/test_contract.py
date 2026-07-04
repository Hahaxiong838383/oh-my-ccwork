"""契约层:事件不可变性 + EVENT_TYPE + 字段(ARCHITECTURE.md §4)。"""

import dataclasses

import pytest

from voice_agent.contract import (
    EventType,
    Interruption,
    UserTurnCommitted,
)
from voice_agent.contract.types import ItemId, TurnId


def test_event_type_classvar() -> None:
    event = UserTurnCommitted(
        turn_id=TurnId("t1"), item_id=ItemId("i1"), final_text="你好", ts=1.0
    )
    assert event.EVENT_TYPE is EventType.USER_TURN_COMMITTED


def test_events_are_frozen() -> None:
    event = UserTurnCommitted(
        turn_id=TurnId("t1"), item_id=ItemId("i1"), final_text="x", ts=1.0
    )
    with pytest.raises(dataclasses.FrozenInstanceError):
        event.final_text = "y"  # type: ignore[misc]


def test_interruption_carries_heard_ms() -> None:
    event = Interruption(
        turn_id=TurnId("t1"), is_interruption=True, heard_ms=500, ts=2.0
    )
    assert event.heard_ms == 500
    assert event.is_interruption is True
