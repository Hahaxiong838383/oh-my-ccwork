"""
gesture_state.py - Pinch / Release 状态机

职责：
- 根据 pinch_ratio 判断捏住 / 松开
- 使用迟滞阈值避免抖动
- 连续帧确认后才切换状态
- 手丢失后自动释放
- 对 pinch 中点坐标做 EMA 平滑
"""

import numpy as np
from enum import Enum


class GesturePhase(Enum):
    """手势阶段"""
    IDLE = "idle"            # 无手 / 未捏住
    HOVERING = "hovering"    # 手在画面中但未捏住
    PINCHING = "pinching"    # 正在捏住
    RELEASED = "released"    # 刚松开（短暂状态）


class GestureStateMachine:
    """带迟滞与帧确认的 Pinch 状态机"""

    def __init__(
        self,
        pinch_on_threshold: float = 0.33,
        pinch_off_threshold: float = 0.45,
        confirm_frames: int = 3,
        lost_frames_release: int = 5,
        smoothing_alpha: float = 0.6,
    ):
        # --- 配置参数 ---
        self.pinch_on_threshold = pinch_on_threshold
        self.pinch_off_threshold = pinch_off_threshold
        self.confirm_frames = confirm_frames
        self.lost_frames_release = lost_frames_release
        self.smoothing_alpha = smoothing_alpha

        # --- 内部状态 ---
        self.phase = GesturePhase.IDLE
        self.pinch_ratio = 0.0

        # 帧计数器
        self._pinch_count = 0     # 连续满足 pinch_on 条件的帧数
        self._release_count = 0   # 连续满足 pinch_off 条件的帧数
        self._lost_count = 0      # 连续丢手帧数

        # 平滑后的 pinch 中点
        self._smooth_center: np.ndarray | None = None

    @property
    def smooth_center(self) -> np.ndarray | None:
        return self._smooth_center

    @property
    def is_pinching(self) -> bool:
        return self.phase == GesturePhase.PINCHING

    def update(self, hand_detected: bool, pinch_ratio: float = 0.0,
               raw_center: np.ndarray | None = None):
        """
        每帧调用，更新状态机。

        参数：
            hand_detected: 本帧是否检测到手
            pinch_ratio: 当前 pinch_distance / hand_scale
            raw_center: 拇指尖与食指尖中点（像素坐标）
        """
        self.pinch_ratio = pinch_ratio

        if not hand_detected:
            self._lost_count += 1
            self._pinch_count = 0
            self._release_count = 0

            # 丢手超过阈值，强制释放
            if self._lost_count >= self.lost_frames_release:
                if self.phase == GesturePhase.PINCHING:
                    self.phase = GesturePhase.RELEASED
                else:
                    self.phase = GesturePhase.IDLE
                self._smooth_center = None
            return

        # 手检测到了，重置丢手计数
        self._lost_count = 0

        # EMA 平滑 pinch 中点
        if raw_center is not None:
            if self._smooth_center is None:
                self._smooth_center = raw_center.copy()
            else:
                alpha = self.smoothing_alpha
                self._smooth_center = alpha * raw_center + (1 - alpha) * self._smooth_center

        # --- 状态转换逻辑 ---
        if self.phase in (GesturePhase.IDLE, GesturePhase.HOVERING, GesturePhase.RELEASED):
            # 当前未捏住，检查是否要进入 pinch
            if pinch_ratio < self.pinch_on_threshold:
                self._pinch_count += 1
                self._release_count = 0
                if self._pinch_count >= self.confirm_frames:
                    self.phase = GesturePhase.PINCHING
                    self._pinch_count = 0
            else:
                self._pinch_count = 0
                self.phase = GesturePhase.HOVERING

        elif self.phase == GesturePhase.PINCHING:
            # 当前捏住，检查是否要松开
            if pinch_ratio > self.pinch_off_threshold:
                self._release_count += 1
                self._pinch_count = 0
                if self._release_count >= self.confirm_frames:
                    self.phase = GesturePhase.RELEASED
                    self._release_count = 0
            else:
                self._release_count = 0

    def reset(self):
        """重置状态机"""
        self.phase = GesturePhase.IDLE
        self.pinch_ratio = 0.0
        self._pinch_count = 0
        self._release_count = 0
        self._lost_count = 0
        self._smooth_center = None
