"""Event Log:append-only + 幂等键去重 + replay(ARCHITECTURE.md §6/§9)。"""

from voice_agent.contract.types import ItemId, TurnId
from voice_agent.kernel.event_log import EventLog, make_idempotency_key
from voice_agent.kernel.model import MemoryFact, Provenance, SourceTier


def _fact(key: str = "name", value: str = "天天") -> MemoryFact:
    prov = Provenance(
        turn_id=TurnId("t1"),
        item_id=ItemId("i1"),
        source=SourceTier.USER_STATED,
        confidence=0.9,
        ts=1.0,
    )
    return MemoryFact(key=key, value=value, provenance=prov)


def test_idempotency_dedup() -> None:
    log = EventLog()
    key = make_idempotency_key(TurnId("t1"), "name=天天")
    first = log.append(_fact(), key, 1.0)
    second = log.append(_fact(), key, 1.0)  # at-least-once 重投
    assert first is not None
    assert second is None  # 幂等丢弃
    assert len(log) == 1


def test_idempotency_key_is_stable_and_turn_scoped() -> None:
    assert make_idempotency_key(TurnId("t1"), "x") == make_idempotency_key(
        TurnId("t1"), "x"
    )
    assert make_idempotency_key(TurnId("t1"), "x") != make_idempotency_key(
        TurnId("t2"), "x"
    )


def test_replay_preserves_order() -> None:
    log = EventLog()
    log.append(_fact(key="a"), "k1", 1.0)
    log.append(_fact(key="b"), "k2", 2.0)
    assert [r.seq for r in log.replay()] == [0, 1]
