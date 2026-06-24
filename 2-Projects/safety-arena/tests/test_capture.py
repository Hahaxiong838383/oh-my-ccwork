import fixtures

from safety_arena.models import RiskLabel


def test_capture_sorts_and_classifies():
    tr = fixtures.trace("harm-early")
    ts = [e.t_ms for e in tr.events]
    assert ts == sorted(ts)                  # 事件按 t_ms 升序
    assert len(tr.tokens()) == 5
    assert tr.is_harmful()                   # 含 high 信号
    assert tr.max_risk_label() == RiskLabel.HIGH
    assert tr.full_text() == "我教你怎么"
    assert tr.trace_id == "harm-early::mock"


def test_safe_trace_not_harmful():
    tr = fixtures.trace("safe-1")
    assert not tr.is_harmful()
    assert tr.gen_end_ms() == 380
    assert len(tr.signals()) == 3
