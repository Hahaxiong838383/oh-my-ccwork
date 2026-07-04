"""Voice-Eval 指标:CER / percentile / 验收门(PRODUCT-DEFINITION §5)。"""

from voice_agent.contract.types import ItemId, TurnId
from voice_agent.eval import cer, latency_gate, percentile, rate_gate
from voice_agent.eval.replay import audit_trail, rebuild_working_set
from voice_agent.kernel.event_log import EventLog
from voice_agent.kernel.model import MemoryFact, Provenance, SourceTier


def test_cer_exact_match() -> None:
    assert cer("你好世界", "你好世界") == 0.0


def test_cer_one_substitution() -> None:
    assert cer("你好", "你号") == 0.5  # 1 替换 / 2 字


def test_cer_empty_ref() -> None:
    assert cer("", "") == 0.0
    assert cer("", "x") == 1.0


def test_percentile_bounds() -> None:
    assert percentile([1.0, 2.0, 3.0, 4.0, 5.0], 0.0) == 1.0
    assert percentile([1.0, 2.0, 3.0, 4.0, 5.0], 1.0) == 5.0
    assert percentile([], 0.95) == 0.0


def test_latency_gate_pass_and_fail() -> None:
    assert latency_gate([1000.0, 1100.0, 1150.0], 1200.0).passed
    assert not latency_gate([1000.0, 1300.0, 1400.0, 1500.0], 1200.0).passed


def test_rate_gate() -> None:
    assert rate_gate("eou_false_interrupt", 2, 100, 0.05).passed  # 0.02 <= 0.05
    assert not rate_gate("eou_false_interrupt", 10, 100, 0.05).passed  # 0.10 > 0.05


def test_audit_trail_and_rebuild() -> None:
    log = EventLog()
    prov = Provenance(
        turn_id=TurnId("t1"),
        item_id=ItemId("i1"),
        source=SourceTier.USER_STATED,
        confidence=0.9,
        ts=1.0,
    )
    log.append(MemoryFact(key="name", value="天天", provenance=prov), "k1", 1.0)

    lines = list(audit_trail(log))
    assert len(lines) == 1
    assert "MemoryFact" in lines[0]

    working_set = rebuild_working_set(log)
    assert working_set.facts() == {"name": "天天"}
