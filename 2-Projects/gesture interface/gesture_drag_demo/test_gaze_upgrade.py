"""路线A 升级自检：二阶多项式校准 + OneEuro 平滑。

无摄像头依赖，直接 python test_gaze_upgrade.py 运行（或 pytest）。
"""
import math

import numpy as np

from gaze_estimator import GazeEstimator
from one_euro import OneEuroFilter


def _fit(measured, expected_x, expected_y):
    """复刻 calibration.py Phase 2 的拟合逻辑（poly + ridge + 择优）。"""
    feats = np.stack([GazeEstimator.poly_features(mx, my) for mx, my in measured])
    ridge = 1e-4 * np.eye(feats.shape[1])
    gram = feats.T @ feats + ridge
    coef_x = np.linalg.solve(gram, feats.T @ expected_x)
    coef_y = np.linalg.solve(gram, feats.T @ expected_y)
    return coef_x, coef_y


def test_poly_beats_affine_on_nonlinear_gaze():
    """合成『边缘压缩 + 轴间耦合』的非线性观测，多项式校准应显著优于仿射。"""
    grid = [(gx, gy) for gy in (-0.5, 0.0, 0.5) for gx in (-0.5, 0.0, 0.5)]

    def observe(gx, gy):
        # 模拟真实退化：垂直增益不足 + 边缘饱和压缩 + 看角落时轴耦合
        mx = 0.8 * gx - 0.25 * gx * abs(gx) + 0.10 * gx * gy
        my = 0.5 * gy - 0.30 * gy * abs(gy) + 0.15 * gx * gx - 0.05
        return mx, my

    measured = [observe(gx, gy) for gx, gy in grid]
    exp_x = np.array([p[0] for p in grid])
    exp_y = np.array([p[1] for p in grid])

    # 仿射基线
    a_x, b_x = np.polyfit([m[0] for m in measured], exp_x, 1)
    a_y, b_y = np.polyfit([m[1] for m in measured], exp_y, 1)

    coef_x, coef_y = _fit(measured, exp_x, exp_y)

    # 在更密的 7×7 测试网格上比较（真实评估要用非校准点）
    test_grid = [(gx, gy) for gy in np.linspace(-0.5, 0.5, 7)
                 for gx in np.linspace(-0.5, 0.5, 7)]
    err_affine, err_poly = [], []
    for gx, gy in test_grid:
        mx, my = observe(gx, gy)
        err_affine.append(math.hypot(a_x * mx + b_x - gx, a_y * my + b_y - gy))
        f = GazeEstimator.poly_features(mx, my)
        err_poly.append(math.hypot(float(coef_x @ f) - gx, float(coef_y @ f) - gy))

    mae_affine = float(np.mean(err_affine))
    mae_poly = float(np.mean(err_poly))
    print(f"  affine MAE={mae_affine:.4f}  poly2 MAE={mae_poly:.4f}")
    # 合成场景含三次方非线性（gx·|gx|），二阶多项式不可能全部拟合；
    # 25% 的稳定增益即为通过线（实测 ~33%）
    assert mae_poly < mae_affine * 0.75, "多项式应比仿射误差至少低 25%"


def test_poly_matches_affine_on_linear_gaze():
    """观测本身是线性时，多项式不应比仿射差（防过拟合退化）。"""
    grid = [(gx, gy) for gy in (-0.5, 0.0, 0.5) for gx in (-0.5, 0.0, 0.5)]
    measured = [(0.7 * gx + 0.02, 0.6 * gy - 0.03) for gx, gy in grid]
    exp_x = np.array([p[0] for p in grid])
    exp_y = np.array([p[1] for p in grid])
    coef_x, coef_y = _fit(measured, exp_x, exp_y)
    for (gx, gy), (mx, my) in zip(grid, measured):
        f = GazeEstimator.poly_features(mx, my)
        assert abs(float(coef_x @ f) - gx) < 0.02
        assert abs(float(coef_y @ f) - gy) < 0.02


def test_one_euro_smooths_noise_and_tracks_steps():
    """OneEuro：静止噪声应被强平滑；阶跃应快速跟上（滞后 < 0.3s）。"""
    rng = np.random.default_rng(42)
    f = OneEuroFilter(min_cutoff=0.8, beta=0.6, d_cutoff=1.0)
    # 静止段：真值 0，噪声 std 0.05
    outs = []
    t = 0.0
    for _ in range(120):
        t += 1 / 30
        outs.append(f.filter(float(rng.normal(0.0, 0.05)), t))
    still_std = float(np.std(outs[60:]))
    assert still_std < 0.025, f"静止段应显著降噪 (std={still_std:.4f})"
    # 阶跃到 0.8
    settle = None
    for i in range(30):
        t += 1 / 30
        y = f.filter(0.8 + float(rng.normal(0.0, 0.05)), t)
        if settle is None and abs(y - 0.8) < 0.1:
            settle = (i + 1) / 30
    assert settle is not None and settle <= 0.3, f"阶跃应 0.3s 内跟上 (={settle})"


def test_estimator_calibration_api():
    """set/clear_calibration 与多项式应用路径（不初始化 FaceMesh）。"""
    est = GazeEstimator.__new__(GazeEstimator)  # 跳过 __init__（避免 mediapipe）
    est._filter_x = OneEuroFilter()
    est._filter_y = OneEuroFilter()
    est._lost_count = 0
    est._calib_coef_x = None
    est._calib_coef_y = None
    est._calibrated = False

    # 单位映射系数：cal_x = x, cal_y = y
    est.set_calibration(np.array([0, 1, 0, 0, 0, 0], dtype=float),
                        np.array([0, 0, 1, 0, 0, 0], dtype=float))
    assert est.is_calibrated
    f = est.poly_features(0.3, -0.2)
    assert abs(float(est._calib_coef_x @ f) - 0.3) < 1e-9
    assert abs(float(est._calib_coef_y @ f) + 0.2) < 1e-9

    # v3.7：隐式重拟合路径 reset_filters=False 不得清滤波状态
    # （reset 会让注视信号瞬断跳变，每 3 次抓卡闪一次）
    est._filter_x.filter(0.1, 0.0)
    assert est._filter_x.initialized
    est.set_calibration(np.array([0, 1, 0, 0, 0, 0], dtype=float),
                        np.array([0, 0, 1, 0, 0, 0], dtype=float),
                        reset_filters=False)
    assert est._filter_x.initialized, "隐式重拟合不得 reset 滤波器"
    est.set_calibration(np.array([0, 1, 0, 0, 0, 0], dtype=float),
                        np.array([0, 0, 1, 0, 0, 0], dtype=float))
    assert not est._filter_x.initialized, "显式校准默认应 reset 滤波器"

    est.clear_calibration()
    assert not est.is_calibrated


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            print(f"[run] {name}")
            fn()
    print("ALL PASS")
