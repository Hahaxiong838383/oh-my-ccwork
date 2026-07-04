"""来源优先级仲裁:高来源覆盖低,**非 LLM confidence**(ARCHITECTURE.md §7)。"""

from voice_agent.contract.types import ItemId, TurnId
from voice_agent.kernel.arbitration import SourceArbiter
from voice_agent.kernel.model import MemoryFact, Provenance, SourceTier


def _fact(source: SourceTier, ts: float, value: str = "v") -> MemoryFact:
    prov = Provenance(
        turn_id=TurnId("t1"),
        item_id=ItemId("i1"),
        source=source,
        confidence=0.9,
        ts=ts,
    )
    return MemoryFact(key="k", value=value, provenance=prov)


def test_higher_source_wins_even_if_older() -> None:
    arb = SourceArbiter()
    inferred_new = _fact(SourceTier.INFERRED, ts=10.0, value="推断")
    stated_old = _fact(SourceTier.USER_STATED, ts=1.0, value="用户明说")
    assert arb.arbitrate(inferred_new, stated_old).value == "用户明说"


def test_same_source_newer_wins() -> None:
    arb = SourceArbiter()
    old = _fact(SourceTier.USER_STATED, ts=1.0, value="旧")
    new = _fact(SourceTier.USER_STATED, ts=2.0, value="新")
    assert arb.arbitrate(old, new).value == "新"


def test_no_existing_takes_incoming() -> None:
    arb = SourceArbiter()
    incoming = _fact(SourceTier.INFERRED, ts=1.0)
    assert arb.arbitrate(None, incoming) is incoming
