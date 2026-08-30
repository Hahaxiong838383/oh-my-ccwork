"""v3.6 校准拟合质量层自检：剔除点过滤 / 残差离群剔除 / MAE 质量门 /
点数不足失败 / allow_poly 防过拟合。

直接 python test_calib_quality.py 运行（或 pytest）。
"""
import numpy as np

from calibration import fit_calib_points, CALIB_POINTS_2D, CALIB_MIN_POINTS
from implicit_calib import fit_poly_with_affine_fallback


def _good_medians(noise=0.005, seed=0):
    """按 expected 生成正常观测（线性增益 + 微噪声）。"""
    rng = np.random.default_rng(seed)
    return [(0.8 * gx + float(rng.normal(0, noise)),
             0.7 * gy + float(rng.normal(0, noise)))
            for (_, _, gx, gy) in CALIB_POINTS_2D]


def test_fit_all_points_good_quality():
    """9 个正常点 → 拟合成功、质量合格、零剔除。"""
    fit = fit_calib_points(_good_medians())
    assert fit is not None
    assert fit["quality_ok"]
    assert len(fit["kept_idx"]) == 9
    assert not fit["dropped_idx"]


def test_skipped_points_are_excluded():
    """被到位门剔除的点（None）不进拟合；锚点集与保留点一致。"""
    meds = _good_medians()
    meds[0] = None
    meds[4] = None
    fit = fit_calib_points(meds)
    assert fit is not None
    assert len(fit["kept_idx"]) == 7
    assert 0 in fit["dropped_idx"] and 4 in fit["dropped_idx"]
    assert fit["quality_ok"]
    assert len(fit["measured"]) == 7 == len(fit["expected"])


def test_residual_outlier_dropped_and_refit():
    """8 好点 + 1 污染点（该点走神看了反方向）→ 残差剔除 + 质量恢复。"""
    meds = _good_medians()
    meds[2] = (-0.6, 0.55)   # 右上点被换成"看左下"的数据
    fit = fit_calib_points(meds)
    assert fit is not None
    assert 2 in fit["dropped_idx"]
    assert fit["quality_ok"]


def test_insufficient_points_fail():
    """有效点 < CALIB_MIN_POINTS → 校准失败（返回 None）。"""
    meds = [None] * len(CALIB_POINTS_2D)
    for i in range(CALIB_MIN_POINTS - 1):
        meds[i] = (0.1 * i, 0.0)
    assert fit_calib_points(meds) is None


def test_static_gaze_everywhere_is_low_quality():
    """终极兜底（事故场景的最后防线）：9 点 measured 几乎重合
    （全程盯一处、假设混过了所有门）→ MAE 必然爆表 → 质量差。"""
    rng = np.random.default_rng(3)
    meds = [(0.02 + float(rng.normal(0, 0.005)),
             -0.01 + float(rng.normal(0, 0.005)))
            for _ in CALIB_POINTS_2D]
    fit = fit_calib_points(meds)
    assert fit is None or not fit["quality_ok"]


def test_allow_poly_false_forces_affine():
    """allow_poly=False 时只出仿射（少点数防 6 参数 poly2 过拟合）。"""
    meds = _good_medians(noise=0.01, seed=5)
    exp_x = np.array([p[2] for p in CALIB_POINTS_2D])
    exp_y = np.array([p[3] for p in CALIB_POINTS_2D])
    _, _, model, _ = fit_poly_with_affine_fallback(
        meds, exp_x, exp_y, allow_poly=False)
    assert model == "affine"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            print(f"[run] {name}")
            fn()
    print("ALL PASS")
