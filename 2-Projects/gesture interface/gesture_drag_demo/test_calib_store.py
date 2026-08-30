"""v3.9 校准持久化 + 快验微调自检。

直接 python test_calib_store.py 运行（或 pytest）。
"""
import json
import os
import tempfile
import time

import numpy as np

import calib_store
from calibration import CALIB_POINTS_2D, CALIB_POINTS_LAYOUT
from implicit_calib import (ImplicitCalibrator, fit_poly_with_affine_fallback,
                            poly_features)
from config import QUICK_VERIFY_WEIGHT

_COEF_X = [0.01, 1.1, 0.0, 0.02, 0.0, 0.0]
_COEF_Y = [0.02, 0.0, 1.2, 0.0, 0.0, 0.03]
_ANCH_M = [(p[2] * 0.8, p[3] * 0.7) for p in CALIB_POINTS_2D]
_ANCH_E = [(p[2], p[3]) for p in CALIB_POINTS_2D]


def _tmp_store():
    d = tempfile.mkdtemp(prefix="calibstore-test-")
    calib_store.STORE_DIR = d
    calib_store.STORE_PATH = os.path.join(d, "calibration.json")
    return calib_store.STORE_PATH


def test_save_load_roundtrip():
    _tmp_store()
    ok = calib_store.save(_COEF_X, _COEF_Y, _ANCH_M, _ANCH_E,
                          CALIB_POINTS_LAYOUT,
                          implicit_samples=[{"raw": [0.1, 0.2],
                                             "expected": [0.15, 0.25],
                                             "ts": time.time()}])
    assert ok
    d = calib_store.load(CALIB_POINTS_LAYOUT)
    assert d is not None
    assert np.allclose(d["coef_x"], _COEF_X)
    assert len(d["anchors_measured"]) == 9
    assert len(d["implicit_samples"]) == 1


def test_layout_mismatch_discards():
    """标定点布局变了 → 旧档 raw 空间不兼容 → 弃档（毒药防御）。"""
    _tmp_store()
    calib_store.save(_COEF_X, _COEF_Y, _ANCH_M, _ANCH_E, "v3.8-narrow")
    assert calib_store.load(CALIB_POINTS_LAYOUT) is None


def test_backend_mismatch_discards():
    """信号源换代 → 弃档（threshold_dead_signal 教训的预防）。"""
    path = _tmp_store()
    calib_store.save(_COEF_X, _COEF_Y, _ANCH_M, _ANCH_E, CALIB_POINTS_LAYOUT)
    with open(path) as f:
        data = json.load(f)
    data["backend"] = "legacy"
    with open(path, "w") as f:
        json.dump(data, f)
    assert calib_store.load(CALIB_POINTS_LAYOUT) is None


def test_corrupt_file_fails_safe():
    """损坏档案 → None（静默回全量标定），绝不抛异常。"""
    path = _tmp_store()
    with open(path, "w") as f:
        f.write('{"format": 1, "backend": bro')
    assert calib_store.load(CALIB_POINTS_LAYOUT) is None


def test_stale_implicit_samples_filtered():
    """隐式样本超保鲜期 → 加载时过滤（新鲜的保留）。"""
    _tmp_store()
    calib_store.save(_COEF_X, _COEF_Y, _ANCH_M, _ANCH_E, CALIB_POINTS_LAYOUT,
                     implicit_samples=[
                         {"raw": [0.1, 0.2], "expected": [0.1, 0.2],
                          "ts": time.time()},                       # 新鲜
                         {"raw": [0.3, 0.4], "expected": [0.3, 0.4],
                          "ts": time.time() - 30 * 86400},          # 30 天前
                     ])
    d = calib_store.load(CALIB_POINTS_LAYOUT)
    assert d is not None and len(d["implicit_samples"]) == 1


def test_restore_samples_roundtrip():
    """隐式样本导出→回灌往返；回灌不触发拒绝/重拟合。"""
    cal = ImplicitCalibrator(_ANCH_M, _ANCH_E)
    cal.restore_samples([{"raw": [0.1, 0.2], "expected": [0.12, 0.22],
                          "ts": time.time()}] * 3)
    out = cal.export_samples()
    assert len(out) == 3
    assert out[0]["raw"] == [0.1, 0.2]
    assert cal.total_rejected == 0


def test_quick_fix_merge_pulls_back_drift():
    """快验合并重拟合的数学：坐姿漂移（平移 bias）被快验点拉回，
    旧锚点保持非线性形状。模拟：真实映射整体平移 +0.15（换了坐姿），
    旧 coef 在新观测上残差 0.15 → 合并 3 个高权重快验点重拟合 →
    快验点残差显著缩小。"""
    # 旧档：完美线性映射 raw*1.25 = expected（增益 0.8 的逆）
    old_cx = np.array([0.0, 1.25, 0.0, 0.0, 0.0, 0.0])
    old_cy = np.array([0.0, 0.0, 1.43, 0.0, 0.0, 0.0])
    # 新会话坐姿变了：同一 expected 位置的 raw 整体 -0.12（x 轴平移）
    drift = 0.12
    quick_pts = [CALIB_POINTS_2D[4], CALIB_POINTS_2D[0], CALIB_POINTS_2D[8]]
    quick_measured = [((p[2] * 0.8) - drift, p[3] * 0.7) for p in quick_pts]
    quick_expected = [(p[2], p[3]) for p in quick_pts]

    # 旧 coef 在漂移观测上的残差 ≈ drift*1.25
    f = poly_features(*quick_measured[0])
    res_before = abs(float(old_cx @ f) - quick_expected[0][0])
    assert res_before > 0.10

    measured = list(_ANCH_M) + quick_measured
    expected = list(_ANCH_E) + quick_expected
    weights = np.array([1.0] * len(_ANCH_M)
                       + [QUICK_VERIFY_WEIGHT] * len(quick_measured))
    exp_x = np.array([e[0] for e in expected])
    exp_y = np.array([e[1] for e in expected])
    coef_x, coef_y, _, _ = fit_poly_with_affine_fallback(
        measured, exp_x, exp_y, weights)

    res_after = np.mean([abs(float(coef_x @ poly_features(*m)) - e[0])
                         for m, e in zip(quick_measured, quick_expected)])
    assert res_after < res_before * 0.6, \
        f"微调应把快验点残差显著拉回 ({res_before:.3f}→{res_after:.3f})"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            print(f"[run] {name}")
            fn()
    print("ALL PASS")
