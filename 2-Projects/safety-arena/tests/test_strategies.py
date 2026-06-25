import fixtures

from safety_arena.models import RiskLabel
from safety_arena.strategies import Arbiter, Knobs, ParallelBuffer, SerialBlock


def res(strategy, case_id, knobs=None):
    return strategy.replay(fixtures.trace(case_id), knobs or Knobs())


def test_safe_serial_slow_parallel_fast_both_zero_leak():
    serial = res(SerialBlock(), "safe-1")
    p0 = res(ParallelBuffer(0), "safe-1")
    assert serial.leaked_tokens == 0 and p0.leaked_tokens == 0
    assert not serial.intervened and not p0.intervened
    assert serial.ttft_ms == 450      # 串行:判定完成才放行(慢)
    assert p0.ttft_ms == 100          # 并行:投机立即放行(快)
    assert p0.total_ms == 380
    assert p0.first_safe_token_ms == 450  # 投机 token 要到判定确认后才"可信安全"


def test_harmful_early_buffer_reduces_leakage():
    serial = res(SerialBlock(), "harm-early")
    p0 = res(ParallelBuffer(0), "harm-early")
    p4 = res(ParallelBuffer(4), "harm-early")
    assert serial.leaked_tokens == 0 and serial.intervened   # 串行零泄漏
    assert p0.leaked_tokens == 3                              # high@220 前已放行 3 个
    assert p4.leaked_tokens == 0                              # 深缓冲全 hold 住
    assert p0.leaked_tokens > p4.leaked_tokens                # buffer↔leakage 权衡


def test_harmful_late_only_serial_is_safe():
    serial = res(SerialBlock(), "harm-late")
    p0 = res(ParallelBuffer(0), "harm-late")
    p4 = res(ParallelBuffer(4), "harm-late")
    assert serial.leaked_tokens == 0          # 串行始终零泄漏
    assert p0.leaked_tokens == 4              # classifier 晚判 → 全泄漏
    assert p4.leaked_tokens == 4              # buffer 也救不了晚判
    assert serial.leaked_tokens < p0.leaked_tokens


def test_classifier_latency_injection_breaks_buffer():
    base = res(ParallelBuffer(4), "harm-early")
    slow = res(ParallelBuffer(4), "harm-early", Knobs(classifier_latency_ms=200))
    assert base.leaked_tokens == 0
    assert slow.leaked_tokens == 5            # 信号后移 → 缓冲失效 → 全泄漏
    assert slow.leaked_tokens > base.leaked_tokens


def test_arbiter_truncates_on_medium():
    arb = res(Arbiter(), "med-1")
    p0 = res(ParallelBuffer(0), "med-1")
    assert arb.intervened                       # medium → truncate
    assert arb.emitted_original_tokens == 1     # 只放行了 medium 信号到达前的 1 个
    assert not p0.intervened                    # 一刀切 buffer 对 medium 不反应
    assert p0.emitted_original_tokens == 5


def test_decisions_are_observable():
    p0 = res(ParallelBuffer(0), "harm-early")
    cancels = [d for d in p0.decisions if d.action.value == "cancel"]
    assert len(cancels) == 1
    assert cancels[0].t_ms == 220
    assert cancels[0].risk_label == RiskLabel.HIGH


def test_serial_waits_for_generation_when_classifier_fast():
    # med-1: classifier 信号 @120 早于生成完成 @300;串行 safe 必须等生成完成才放行(不是判定时刻)
    serial = res(SerialBlock(), "med-1")
    assert serial.ttft_ms == 300  # = gen_end,不是 judge(120)
