"""v3.3 校准质量门控自检：稳定累积 / 噪声不计 / 中断复位 / 超时降级。

直接 python test_fixation_gate.py 运行（或 pytest）。
"""
import numpy as np

from calibration import FixationGate, CALIB_MIN_SAMPLES


def _feed_stream(gate, xs, ys, t0=0.0, fps=30.0):
    t = t0
    for x, y in zip(xs, ys):
        t += 1.0 / fps
        gate.feed(float(x), float(y), t)
    return t


def test_stable_gaze_completes():
    """稳定注视（微噪声）应正常攒满并 complete。"""
    gate = FixationGate(window=10, std_threshold=0.05, target=20)
    rng = np.random.default_rng(1)
    n = 60
    _feed_stream(gate, 0.3 + rng.normal(0, 0.01, n), -0.2 + rng.normal(0, 0.01, n))
    assert gate.complete
    mx, my = gate.result()
    assert abs(mx - 0.3) < 0.02 and abs(my + 0.2) < 0.02


def test_wandering_gaze_does_not_accumulate():
    """扫视/走神（大幅漂移）不应计入合格样本。"""
    gate = FixationGate(window=10, std_threshold=0.05, target=20,
                        stage_timeout=999)  # 关掉放宽，纯测门控
    rng = np.random.default_rng(2)
    n = 60
    _feed_stream(gate, rng.uniform(-0.8, 0.8, n), rng.uniform(-0.8, 0.8, n))
    assert not gate.complete
    assert len(gate.qualified) == 0


def test_interrupt_resets_window():
    """人脸丢失中断后，稳定判定需重新积累滑窗（合格样本保留）。"""
    gate = FixationGate(window=10, std_threshold=0.05, target=100)
    _feed_stream(gate, [0.3] * 15, [0.1] * 15)
    q_before = len(gate.qualified)
    assert q_before > 0
    gate.interrupt()
    assert not gate.is_stable
    # 中断后前 window-1 帧不可能 stable
    t = 10.0
    for i in range(9):
        t += 1 / 30
        gate.feed(0.3, 0.1, t)
        assert not gate.is_stable
    assert len(gate.qualified) == q_before  # 期间没有新增


def test_timeout_relax_then_exhausted():
    """持续不稳定 → 按阶段放宽阈值，放宽用尽后 exhausted（防转圈卡死）。"""
    gate = FixationGate(window=10, std_threshold=0.001,  # 苛刻到不可能稳定
                        target=20, stage_timeout=0.5, relax_factor=1.5,
                        max_relax=2)
    rng = np.random.default_rng(3)
    t = 0.0
    for _ in range(120):  # 4 秒 @30fps，跨越 2 个阶段超时
        t += 1 / 30
        gate.feed(float(rng.normal(0, 0.05)), float(rng.normal(0, 0.05)), t)
    assert gate.relax_count == 2
    assert gate.exhausted
    # 降级 result 用全量样本兜底
    assert gate.result() is not None
    assert len(gate.all_samples) >= CALIB_MIN_SAMPLES


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            print(f"[run] {name}")
            fn()
    print("ALL PASS")
