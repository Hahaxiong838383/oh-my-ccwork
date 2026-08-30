"""implicit_calib.py — 捏取即校准：隐式在线校准（2026-07 路线C）

范式（Sugano et al., IEEE THMS 2015）：用户交互瞬间的目标位置 = 注视弱标签。
本 demo 的天然标签：pinch 抓取卡片的瞬间，视线必然在那张卡片上。
每次抓取产出一个 (raw_gaze, 卡片中心期望值) 样本 → 滑窗累积 → 增量重拟合
校准多项式 → 越用越准，且自动吸收"换坐姿/换距离后的校准漂移"。

标签噪声防御：
- 离群拒绝：当前校准把 raw 映射后距离标签太远（肌肉记忆盲抓）→ 丢弃
- 锚点保底：显式 9 点校准样本永驻且权重更高，隐式样本只能微调不能推翻
- 滑窗淘汰：最老的隐式样本先走，长期漂移由新样本主导
"""
from __future__ import annotations

from collections import deque
from typing import List, Optional, Sequence, Tuple

import numpy as np

from config import (
    IMPLICIT_MAX_SAMPLES, IMPLICIT_WEIGHT,
    IMPLICIT_OUTLIER_DIST, IMPLICIT_REFIT_EVERY,
)

# 仿射 scale 钳位（与显式校准一致）
SCALE_CLAMP = (0.3, 5.0)
# 多项式 ridge 正则
RIDGE_LAMBDA = 1e-4


def poly_features(x: float, y: float) -> np.ndarray:
    """二阶多项式特征 [1, x, y, x², xy, y²]（与 GazeEstimator.poly_features 一致）"""
    return np.array([1.0, x, y, x * x, x * y, y * y])


def fit_poly_with_affine_fallback(
    measured: Sequence[Tuple[float, float]],
    expected_x: np.ndarray,
    expected_y: np.ndarray,
    weights: Optional[np.ndarray] = None,
    allow_poly: bool = True,
) -> Tuple[np.ndarray, np.ndarray, str, Tuple[float, float]]:
    """加权拟合二阶多项式，退化时回退仿射（MAE 择优）。

    返回 (coef_x, coef_y, model_name, (mae_x, mae_y))；coef 均为 6 维。
    显式校准（calibration.py）与隐式校准共用，保证行为一致。
    allow_poly=False 时只拟合仿射——点数少时 6 参数 poly2 会在训练点上
    过拟合（训练 MAE 趋 0，择优必选它），调用方按点数关闭。
    """
    measured = list(measured)
    n = len(measured)
    if weights is None:
        weights = np.ones(n)
    weights = np.asarray(weights, dtype=float)

    feats = np.stack([poly_features(mx, my) for mx, my in measured])
    mxs = np.array([m[0] for m in measured])
    mys = np.array([m[1] for m in measured])

    def _mae(cx, cy):
        ex = float(np.mean(np.abs(feats @ cx - expected_x)))
        ey = float(np.mean(np.abs(feats @ cy - expected_y)))
        return ex, ey

    # 仿射兜底（per-axis 加权一次拟合，嵌进 6 维格式）
    w_sqrt = np.sqrt(weights)
    a_x, b_x = np.polyfit(mxs, expected_x, 1, w=w_sqrt)
    a_y, b_y = np.polyfit(mys, expected_y, 1, w=w_sqrt)
    a_x = float(max(SCALE_CLAMP[0], min(SCALE_CLAMP[1], a_x)))
    a_y = float(max(SCALE_CLAMP[0], min(SCALE_CLAMP[1], a_y)))
    affine_cx = np.array([b_x, a_x, 0.0, 0.0, 0.0, 0.0])
    affine_cy = np.array([b_y, 0.0, a_y, 0.0, 0.0, 0.0])

    coef_x, coef_y, model = affine_cx, affine_cy, "affine"
    if allow_poly:
        try:
            wmat = feats.T * weights  # (6, n)
            gram = wmat @ feats + RIDGE_LAMBDA * np.eye(feats.shape[1])
            poly_cx = np.linalg.solve(gram, wmat @ expected_x)
            poly_cy = np.linalg.solve(gram, wmat @ expected_y)
            pmx, pmy = _mae(poly_cx, poly_cy)
            amx, amy = _mae(affine_cx, affine_cy)
            if pmx + pmy < amx + amy:
                coef_x, coef_y, model = poly_cx, poly_cy, "poly2"
        except np.linalg.LinAlgError:
            pass

    return coef_x, coef_y, model, _mae(coef_x, coef_y)


class ImplicitCalibrator:
    """滑窗隐式校准器：锚点（显式校准样本）+ 隐式样本（捏取事件）。"""

    def __init__(self,
                 anchors_measured: Sequence[Tuple[float, float]],
                 anchors_expected: Sequence[Tuple[float, float]]):
        self._anchor_m = list(anchors_measured)
        self._anchor_e = list(anchors_expected)
        self._implicit: deque = deque(maxlen=IMPLICIT_MAX_SAMPLES)
        self._since_refit = 0
        self._coef_x: Optional[np.ndarray] = None
        self._coef_y: Optional[np.ndarray] = None
        self.total_accepted = 0
        self.total_rejected = 0
        # v3.9 失配哨兵：连续离群拒绝数（环境剧变后新样本会连续被拒——
        # 这本身是「旧校准已失配」的信号，app 层超阈提示按 C 重标）
        self.consecutive_rejects = 0

    # ── v3.9 持久化接口（跨会话「越用越准」）──
    def export_samples(self) -> list:
        """导出滑窗隐式样本（供 calib_store 落盘；ts 由调用方已存于样本）"""
        return [{"raw": [s[0][0], s[0][1]],
                 "expected": [s[1][0], s[1][1]],
                 "ts": s[2]} for s in self._implicit]

    def restore_samples(self, samples: Sequence[dict]):
        """回灌历史样本（已过保鲜过滤）。不走离群拒绝——它们入库时已过
        当时的拒绝判定；只进滑窗不触发逐条重拟合，末尾一次 refit。"""
        for s in samples:
            self._implicit.append(((float(s["raw"][0]), float(s["raw"][1])),
                                   (float(s["expected"][0]),
                                    float(s["expected"][1])),
                                   float(s.get("ts", 0))))
        if self._implicit:
            print(f"[implicit_calib] 回灌 {len(samples)} 条历史样本")

    def set_current_coefs(self, coef_x: np.ndarray, coef_y: np.ndarray):
        """同步当前生效的校准系数（用于离群判定）"""
        self._coef_x = np.asarray(coef_x, dtype=float)
        self._coef_y = np.asarray(coef_y, dtype=float)

    def add_sample(self, raw: Tuple[float, float],
                   expected: Tuple[float, float]
                   ) -> Optional[Tuple[np.ndarray, np.ndarray]]:
        """喂一个捏取样本。触发重拟合时返回新 (coef_x, coef_y)，否则 None。"""
        import time as _time
        # 离群拒绝：按当前校准映射后距标签太远 = 用户大概率没看目标
        if self._coef_x is not None:
            f = poly_features(*raw)
            cal_x = float(self._coef_x @ f)
            cal_y = float(self._coef_y @ f)
            dist = ((cal_x - expected[0]) ** 2 + (cal_y - expected[1]) ** 2) ** 0.5
            if dist > IMPLICIT_OUTLIER_DIST:
                self.total_rejected += 1
                self.consecutive_rejects += 1  # v3.9 失配哨兵
                print(f"[implicit_calib] 样本拒绝 (映射偏差 {dist:.2f} > "
                      f"{IMPLICIT_OUTLIER_DIST}, 连续 {self.consecutive_rejects})")
                return None

        self.consecutive_rejects = 0
        self._implicit.append((raw, expected, _time.time()))
        self.total_accepted += 1
        self._since_refit += 1
        if self._since_refit < IMPLICIT_REFIT_EVERY:
            return None
        self._since_refit = 0
        return self._refit()

    def _refit(self) -> Optional[Tuple[np.ndarray, np.ndarray]]:
        measured = self._anchor_m + [s[0] for s in self._implicit]
        expected = self._anchor_e + [s[1] for s in self._implicit]
        weights = np.array(
            [1.0] * len(self._anchor_m) + [IMPLICIT_WEIGHT] * len(self._implicit))
        exp_x = np.array([e[0] for e in expected])
        exp_y = np.array([e[1] for e in expected])
        try:
            coef_x, coef_y, model, (mae_x, mae_y) = fit_poly_with_affine_fallback(
                measured, exp_x, exp_y, weights)
        except (np.linalg.LinAlgError, ValueError):
            print("[implicit_calib] 重拟合失败，保持现有校准")
            return None
        self._coef_x, self._coef_y = coef_x, coef_y
        print(f"[implicit_calib] 重拟合 (model={model}, "
              f"隐式样本={len(self._implicit)}, MAE={mae_x:.3f}/{mae_y:.3f})")
        return coef_x, coef_y


def card_expected_gaze(card_cx: float, card_cy: float,
                       frame_w: int, frame_h: int) -> Tuple[float, float]:
    """卡片中心像素坐标 → 校准期望空间。

    与 CALIB_POINTS_2D 的约定一致：屏幕 20%-80% ↔ 注视 ±0.5，
    即 gaze = (ratio - 0.5) / 0.6（水平）、/ 0.5（垂直）。
    """
    gx = (card_cx / frame_w - 0.5) / 0.6
    gy = (card_cy / frame_h - 0.5) / 0.5
    return gx, gy
