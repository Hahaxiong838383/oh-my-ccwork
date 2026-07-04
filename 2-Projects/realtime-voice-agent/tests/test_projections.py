"""投影器:Working Set 可从 Event Log replay 重建(ARCHITECTURE.md §6 不变量)。"""

from voice_agent.contract.types import ItemId, TurnId
from voice_agent.kernel.event_log import EventLog
from voice_agent.kernel.model import MemoryFact, Provenance, SourceTier
from voice_agent.kernel.projections import WorkingSet


def _fact(key: str, value: str) -> MemoryFact:
    prov = Provenance(
        turn_id=TurnId("t1"),
        item_id=ItemId("i1"),
        source=SourceTier.USER_STATED,
        confidence=0.9,
        ts=1.0,
    )
    return MemoryFact(key=key, value=value, provenance=prov)


def test_working_set_rebuilds_from_log() -> None:
    log = EventLog()
    log.append(_fact("name", "天天"), "k1", 1.0)
    log.append(_fact("pet", "乌龟"), "k2", 2.0)

    working_set = WorkingSet()
    working_set.rebuild_from(log.replay())

    assert working_set.facts() == {"name": "天天", "pet": "乌龟"}


def test_projection_rebuild_is_deterministic() -> None:
    log = EventLog()
    log.append(_fact("name", "天天"), "k1", 1.0)

    first = WorkingSet()
    first.rebuild_from(log.replay())
    second = WorkingSet()
    second.rebuild_from(log.replay())

    assert first.facts() == second.facts()
