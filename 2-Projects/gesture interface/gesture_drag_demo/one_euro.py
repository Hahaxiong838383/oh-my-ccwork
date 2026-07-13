"""
one_euro.py — OneEuro filter（Géry Casiez et al. 2012）速度自适应低通滤波

Why：MediaPipe Hands 在画面边缘 landmark 抖动严重（v4.6 之前已经收过）。
普通 EMA 强度固定 → 慢移动时仍抖 / 快移动有 lag。OneEuro 速度自适应：
- 慢速运动（疑似抖动）：cutoff 低 → 强平滑
- 快速运动（用户主动操作）：cutoff 高 → 几乎不平滑

经典实现（BSD-2-Clause，Géry Casiez 官方 Python port），自包含无外部依赖。

参考：https://gery.casiez.net/1euro/

参数（codex 5.5 xhigh 深度评审给的 cc-AirPlayer 起步值）：
- landmark px 坐标：min_cutoff=1.0, beta=0.015, d_cutoff=1.0
- pinch_ratio 一维 [0, 2]：min_cutoff=2.0, beta=0.2, d_cutoff=1.0

注意（同样来自 codex 评审）：
- 必须传真实 timestamp（time.monotonic 秒），不能假设 30fps 固定 dt
- dt<=0 或 dt>200ms 视为异常，应 reset 而不是用旧 t_prev
- 跨 hand switch / lost hand / handedness 翻转必须 reset filter
- persist 命中（沿用旧 hand）时不要重新喂 filter
"""
from __future__ import annotations

import math
import time
from typing import Optional, Sequence


def _smoothing_factor(t_e: float, cutoff: float) -> float:
    """OneEuro 公式：α = 1 / (1 + τ_c / dt) where τ_c = 1/(2π·cutoff)"""
    r = 2.0 * math.pi * cutoff * t_e
    return r / (r + 1.0)


def _exponential_smoothing(alpha: float, x: float, x_prev: float) -> float:
    return alpha * x + (1.0 - alpha) * x_prev


class OneEuroFilter:
    """单变量 OneEuro filter。

    用法:
        f = OneEuroFilter(min_cutoff=1.0, beta=0.015)
        x_smooth = f.filter(x_raw, t_seconds)
        ...
        f.reset()   # hand 丢检测/handedness 切换时
    """

    # dt 异常阈值：超过这个时间没收到新样本，filter 状态视为陈旧
    MAX_DT_S = 0.200

    def __init__(
        self,
        min_cutoff: float = 1.0,
        beta: float = 0.0,
        d_cutoff: float = 1.0,
    ):
        self.min_cutoff = float(min_cutoff)
        self.beta = float(beta)
        self.d_cutoff = float(d_cutoff)
        self._initialized: bool = False
        self._x_prev: float = 0.0
        self._dx_prev: float = 0.0
        self._t_prev: float = 0.0

    def filter(self, x: float, t: float) -> float:
        """对样本 x 在时刻 t（秒）做滤波，返回平滑后的 x。

        首次调用初始化（直接返回 x）；之后按 OneEuro 算法滤。
        dt 异常（<=0 或 >MAX_DT_S）时自动 reset 再用本帧重新初始化。
        """
        if not self._initialized:
            self._x_prev = float(x)
            self._dx_prev = 0.0
            self._t_prev = float(t)
            self._initialized = True
            return float(x)

        t_e = t - self._t_prev
        if t_e <= 0.0 or t_e > self.MAX_DT_S:
            # 时序异常（停顿/回拨）→ reset 当作首帧重新初始化
            self._x_prev = float(x)
            self._dx_prev = 0.0
            self._t_prev = float(t)
            return float(x)

        # 估计速度（用 d_cutoff 低通过滤 raw derivative）
        a_d = _smoothing_factor(t_e, self.d_cutoff)
        dx_raw = (x - self._x_prev) / t_e
        dx_hat = _exponential_smoothing(a_d, dx_raw, self._dx_prev)

        # 自适应 cutoff = min_cutoff + beta * |speed|
        cutoff = self.min_cutoff + self.beta * abs(dx_hat)
        a = _smoothing_factor(t_e, cutoff)
        x_hat = _exponential_smoothing(a, x, self._x_prev)

        self._x_prev = x_hat
        self._dx_prev = dx_hat
        self._t_prev = float(t)
        return x_hat

    def reset(self):
        """清空内部状态（下次 filter() 调用会重新初始化）"""
        self._initialized = False
        self._x_prev = 0.0
        self._dx_prev = 0.0
        self._t_prev = 0.0

    @property
    def initialized(self) -> bool:
        return self._initialized


class LandmarkFilter:
    """对 N 个 2D landmark 各 x/y 维独立 OneEuro 过滤（2N 个滤波器）。

    cc-AirPlayer 用于 MediaPipe Hands 21 个 landmarks_px 输出，
    在 int 转换前过滤 float px（避免 int 量化破坏低频信号）。
    """

    def __init__(
        self,
        n_landmarks: int = 21,
        min_cutoff: float = 1.0,
        beta: float = 0.015,
        d_cutoff: float = 1.0,
    ):
        self.n = n_landmarks
        self._filters: list[OneEuroFilter] = [
            OneEuroFilter(min_cutoff, beta, d_cutoff)
            for _ in range(n_landmarks * 2)
        ]

    def filter(
        self,
        landmarks_float_px: Sequence[tuple[float, float]],
        t: Optional[float] = None,
    ) -> list[tuple[float, float]]:
        """过滤 N 个 (x, y) 浮点 px 坐标，返回平滑后同样格式。

        t 默认用 time.monotonic()。
        """
        if t is None:
            t = time.monotonic()
        if len(landmarks_float_px) != self.n:
            # 输入维度不符（罕见情况，例如检测器返回数量异常）→ 不滤直接返回
            return [(float(x), float(y)) for x, y in landmarks_float_px]
        out: list[tuple[float, float]] = []
        for i, (x, y) in enumerate(landmarks_float_px):
            fx = self._filters[i * 2].filter(float(x), t)
            fy = self._filters[i * 2 + 1].filter(float(y), t)
            out.append((fx, fy))
        return out

    def reset(self):
        """所有 landmark 滤波器同时 reset（hand 切换 / lost / handedness 翻转用）"""
        for f in self._filters:
            f.reset()

    @property
    def initialized(self) -> bool:
        """任一 filter 已初始化 = 整组已初始化"""
        return any(f.initialized for f in self._filters)
