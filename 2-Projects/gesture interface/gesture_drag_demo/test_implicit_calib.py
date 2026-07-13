"""路线C 隐式校准自检：漂移修正 / 离群拒绝 / 滑窗上限。

直接 python test_implicit_calib.py 运行（或 pytest）。
"""
import numpy as np

from implicit_calib import (
    ImplicitCalibrator, fit_poly_with_affine_fallback,
    poly_features, card_expected_gaze,
)
from config import IMPLICIT_MAX_SAMPLES, IMPLICIT_REFIT_EVERY


GRID9 = [(gx, gy) for gy in (-0.5, 0.0, 0.5) for gx in (-0.5, 0.0, 0.5)]


def _observe(gx, gy, bias_x=0.0, bias_y=0.0):
    """观测模型：轻微非线性 + 可注入漂移偏置（模拟换坐姿）。"""
    mx = 0.8 * gx - 0.15 * gx * abs(gx) + bias_x
    my = 0.55 * gy - 0.20 * gy * abs(gy) + bias_y
    return mx, my


def _make_calibrator():
    measured = [_observe(gx, gy) for gx, gy in GRID9]
    exp_x = np.array([p[0] for p in GRID9])
    exp_y = np.array([p[1] for p in GRID9])
    coef_x, coef_y, _, _ = fit_poly_with_affine_fallback(measured, exp_x, exp_y)
    cal = ImplicitCalibrator(measured, GRID9)
    cal.set_current_coefs(coef_x, coef_y)
    return cal, (coef_x, coef_y)


def _grid_error(coef_x, coef_y, bias_x, bias_y):
    errs = []
    for gx, gy in GRID9:
        mx, my = _observe(gx, gy, bias_x, bias_y)
        f = poly_features(mx, my)
        errs.append(np.hypot(float(coef_x @ f) - gx, float(coef_y @ f) - gy))
    return float(np.mean(errs))


def test_drift_correction():
    """换坐姿产生漂移后，隐式样本应把误差拉回去。"""
    cal, (cx0, cy0) = _make_calibrator()
    bias = (0.12, 0.10)  # 漂移量（在离群阈值内）
    err_before = _grid_error(cx0, cy0, *bias)

    latest = None
    rng = np.random.default_rng(7)
    for _ in range(24):  # 模拟 24 次捏卡片
        gx, gy = GRID9[rng.integers(0, 9)]
        mx, my = _observe(gx, gy, *bias)
        out = cal.add_sample((mx, my), (gx, gy))
        if out is not None:
            latest = out
    assert latest is not None, "应至少触发一次重拟合"
    err_after = _grid_error(latest[0], latest[1], *bias)
    print(f"  漂移误差: before={err_before:.4f} after={err_after:.4f}")
    assert err_after < err_before * 0.55, "隐式校准应把漂移误差至少砍 45%"


def test_outlier_rejected():
    """盲抓（视线不在卡片上）样本应被拒绝，不进入拟合。"""
    cal, _ = _make_calibrator()
    before = cal.total_accepted
    out = cal.add_sample((0.9, 0.9), (-0.5, -0.5))  # 映射偏差巨大
    assert out is None
    assert cal.total_rejected == 1
    assert cal.total_accepted == before


def test_window_bounded():
    """隐式样本滑窗有上限，不会无限增长。"""
    cal, _ = _make_calibrator()
    for i in range(IMPLICIT_MAX_SAMPLES + 20):
        gx, gy = GRID9[i % 9]
        cal.add_sample(_observe(gx, gy), (gx, gy))
    assert len(cal._implicit) <= IMPLICIT_MAX_SAMPLES


def test_card_expected_gaze_roundtrip():
    """卡片中心映射与 9 点校准约定一致（屏幕 20%/80% ↔ ±0.5）。"""
    gx, gy = card_expected_gaze(0.20 * 1280, 0.25 * 720, 1280, 720)
    assert abs(gx + 0.5) < 1e-9 and abs(gy + 0.5) < 1e-9
    gx, gy = card_expected_gaze(0.80 * 1280, 0.75 * 720, 1280, 720)
    assert abs(gx - 0.5) < 1e-9 and abs(gy - 0.5) < 1e-9


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            print(f"[run] {name}")
            fn()
    print("ALL PASS")
