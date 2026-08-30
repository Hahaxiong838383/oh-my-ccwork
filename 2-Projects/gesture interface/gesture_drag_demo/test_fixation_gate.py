"""校准质量门控自检。

v3.3：稳定累积 / 噪声不计 / 中断复位 / 超时降级。
v3.6：到位门——「稳定地看错地方」不得产出合格样本（2026-08-30
川哥实测：不看校准点也自动完成标定，根因是 std 门只测稳不测位置）。

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


# ── v3.6 到位门 ──────────────────────────────────────────

def test_arrival_gate_blocks_static_gaze():
    """核心负向（复现 2026-08-30 实测事故）：盯着参照位不看新点，
    视线再稳也不得产出合格样本；超时后 given_up，兜底池同样为空。"""
    gate = FixationGate(window=10, std_threshold=0.05, target=20,
                        ref_point=(0.0, 0.0), expected_dir=(0.5, 0.0),
                        arrival_timeout=0.5, arrival_giveup=1.0)
    rng = np.random.default_rng(7)
    t = 0.0
    for _ in range(45):  # 1.5s @30fps，静止微噪声（std 门必然全过）
        t += 1 / 30
        gate.feed(float(rng.normal(0.0, 0.01)),
                  float(rng.normal(0.0, 0.01)), t)
    assert not gate.arrived
    assert len(gate.qualified) == 0
    assert gate.given_up
    assert gate.result() is None  # 没看点的数据连兜底都进不了


def test_arrival_gate_accepts_migrated_gaze():
    """正向：视线从参照迁移到期望方向并稳定 → 到位 + 正常攒满。"""
    gate = FixationGate(window=10, std_threshold=0.05, target=20,
                        ref_point=(0.0, 0.0), expected_dir=(0.5, 0.0))
    rng = np.random.default_rng(8)
    # 上一点余韵：参照附近 10 帧
    t = _feed_stream(gate, rng.normal(0, 0.01, 10), rng.normal(0, 0.01, 10))
    assert not gate.arrived
    # 迁移到 (0.4, 0.05) 稳定注视
    _feed_stream(gate, 0.4 + rng.normal(0, 0.01, 60),
                 0.05 + rng.normal(0, 0.01, 60), t0=t)
    assert gate.arrived
    assert gate.complete
    mx, my = gate.result()
    assert abs(mx - 0.4) < 0.03 and abs(my - 0.05) < 0.03


def test_arrival_gate_rejects_wrong_direction():
    """迁移到期望反方向（看去别处并盯稳）→ 超时自愈前不到位、不计样本。
    （v3.7 起超时后会弃方向自愈，此测试的 timeout=99 覆盖超时前语义。）"""
    gate = FixationGate(window=10, std_threshold=0.05, target=20,
                        ref_point=(0.0, 0.0), expected_dir=(0.5, 0.0),
                        arrival_timeout=99, arrival_giveup=99)
    rng = np.random.default_rng(9)
    _feed_stream(gate, -0.4 + rng.normal(0, 0.01, 60),
                 rng.normal(0, 0.01, 60))
    assert not gate.arrived
    assert len(gate.qualified) == 0


# ── v3.7 到位门解耦 + 方向自愈（修点2卡死回归）──────────────

def test_noisy_on_target_arrives_and_degrades():
    """v3.7 核心回归（2026-08-30 中上点卡死）：位置正确但噪声超 std
    阈值（看上排虹膜信号饱和抖动）→ 到位必须锁存（位置判据与噪声
    解耦），随后放宽/降级机制接管，最终出结果而非被剔除。
    v3.6 曾把 arrived 与 std 耦合：此流三 seed 全卡死 given_up。"""
    for seed in (1, 2, 3):
        gate = FixationGate(ref_point=(-0.30, -0.25),
                            expected_dir=(0.5, 0.0),
                            stage_timeout=0.5)  # 加速放宽以缩短测试
        rng = np.random.default_rng(seed)
        t = 0.0
        for _ in range(450):  # 15s @30fps，中心在点2、y噪声0.12
            t += 1 / 30
            gate.feed(0.0 + float(rng.normal(0, 0.03)),
                      -0.25 + float(rng.normal(0, 0.12)), t)
        assert gate.arrived, f"seed{seed}: 位置正确必须到位（与噪声无关）"
        assert not gate.given_up, f"seed{seed}: 到位后不得被放弃"
        assert gate.result() is not None, f"seed{seed}: 放宽/降级后必须出结果"


def test_direction_selfheal_when_magnitude_persists():
    """v3.7 方向自愈：位移幅度持续显著、方向与期望不符（用户 raw 几何
    与期望方向不一致）→ 超时后弃方向判据，凭幅度到位。"""
    gate = FixationGate(window=10, std_threshold=0.05, target=20,
                        ref_point=(0.0, 0.0), expected_dir=(0.5, 0.0),
                        arrival_timeout=0.5, arrival_giveup=10.0)
    rng = np.random.default_rng(11)
    # 稳定注视在反方向位置（幅度 0.4 显著）
    _feed_stream(gate, -0.4 + rng.normal(0, 0.01, 90),
                 rng.normal(0, 0.01, 90))
    assert gate.arrived, "幅度持续显著应触发方向自愈并到位"
    assert not gate.given_up
    assert gate.complete


def test_static_gaze_never_selfheals():
    """自愈不放行真不看的人：静止注视位移幅度不显著，mag_ok 不涨，
    自愈永不触发 → 依然 given_up（拦截力不因自愈损失）。"""
    gate = FixationGate(window=10, std_threshold=0.05, target=20,
                        ref_point=(0.0, 0.0), expected_dir=(0.5, 0.0),
                        arrival_timeout=0.3, arrival_giveup=1.0)
    rng = np.random.default_rng(12)
    _feed_stream(gate, rng.normal(0, 0.01, 60), rng.normal(0, 0.01, 60))
    assert not gate.arrived
    assert gate.given_up
    assert gate.result() is None


def test_arrival_magnitude_only_when_no_dir():
    """首点场景（expected_dir=None，Phase 0 参照无期望坐标）：
    任意方向、幅度足够的迁移即算到位。"""
    gate = FixationGate(window=10, std_threshold=0.05, target=20,
                        ref_point=(0.0, 0.0), expected_dir=None)
    rng = np.random.default_rng(10)
    _feed_stream(gate, -0.3 + rng.normal(0, 0.01, 60),
                 0.2 + rng.normal(0, 0.01, 60))
    assert gate.arrived
    assert gate.complete


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            print(f"[run] {name}")
            fn()
    print("ALL PASS")
