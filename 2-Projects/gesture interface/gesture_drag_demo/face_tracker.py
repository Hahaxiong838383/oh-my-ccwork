"""
face_tracker.py - 面部特征识别与追踪模块

基于 MediaPipe FaceMesh 468+ 关键点，提供：
- 眼部特征：EAR（眼睛纵横比）、眨眼检测、眼睛开合度、瞳孔追踪
- 面部朝向：yaw（偏航）、pitch（俯仰）、roll（翻滚）
- 表情线索：嘴巴开合比、眉毛高度
- 面部轮廓：可视化用关键点分组

复用 GazeEstimator 的 FaceMesh 结果（通过 face_landmarks 字段），
避免重复推理。
"""

import math
import numpy as np
from dataclasses import dataclass, field
from typing import Optional, List, Tuple
from collections import deque

from config import (
    EAR_BLINK_THRESHOLD, EAR_SMOOTHING_ALPHA,
    BLINK_CONFIRM_FRAMES, BLINK_REFRACTORY_FRAMES,
    FACE_MESH_DRAW_TESSELATION, FACE_MESH_DRAW_CONTOURS,
    MAR_OPEN_THRESHOLD,
)


# ================================================================
# MediaPipe FaceMesh 关键点索引分组
# ================================================================

# 左眼轮廓（上下眼睑 6 点，用于 EAR 计算）
LEFT_EYE_EAR_IDX = [33, 160, 158, 133, 153, 144]
# 右眼轮廓（上下眼睑 6 点）
RIGHT_EYE_EAR_IDX = [362, 385, 387, 263, 373, 380]

# 左眼完整轮廓（16 点，用于绘制）
LEFT_EYE_CONTOUR = [
    33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246
]
# 右眼完整轮廓（16 点）
RIGHT_EYE_CONTOUR = [
    362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398
]

# 左眉
LEFT_EYEBROW = [70, 63, 105, 66, 107]
# 右眉
RIGHT_EYEBROW = [300, 293, 334, 296, 336]

# 嘴唇外轮廓
LIPS_OUTER = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185]
# 嘴唇内轮廓
LIPS_INNER = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191]

# MAR 计算用（嘴巴上下 + 左右）
MOUTH_TOP = 13
MOUTH_BOTTOM = 14
MOUTH_LEFT = 61
MOUTH_RIGHT = 291

# 面部朝向估计关键点
NOSE_TIP = 1
LEFT_EYE_OUTER = 33
RIGHT_EYE_OUTER = 263
CHIN = 152
FOREHEAD = 10  # 额头中心（近似）

# 虹膜中心
LEFT_IRIS_CENTER = 468
RIGHT_IRIS_CENTER = 473

# 面部轮廓（脸型）
FACE_OVAL = [
    10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288,
    397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136,
    172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109
]


@dataclass
class EyeFeatures:
    """单只眼睛的特征"""
    ear: float = 0.0           # Eye Aspect Ratio
    openness: float = 1.0      # 开合度 [0=闭, 1=全开]
    contour_px: list = field(default_factory=list)  # 轮廓像素坐标
    iris_px: Optional[Tuple[int, int]] = None       # 虹膜中心像素


@dataclass
class FaceFeatures:
    """单帧面部特征结果"""
    face_detected: bool = False

    # 眼部
    left_eye: EyeFeatures = field(default_factory=EyeFeatures)
    right_eye: EyeFeatures = field(default_factory=EyeFeatures)
    avg_ear: float = 0.0            # 双眼平均 EAR
    smooth_ear: float = 0.0         # 平滑后 EAR
    is_blinking: bool = False       # 当前是否在眨眼
    blink_count: int = 0            # 累计眨眼次数

    # 面部朝向（度）
    yaw: float = 0.0                # 偏航（左右转头）
    pitch: float = 0.0              # 俯仰（抬头低头）
    roll: float = 0.0               # 翻滚（歪头）

    # 表情
    mar: float = 0.0                # Mouth Aspect Ratio（嘴巴开合）
    mouth_open: bool = False        # 嘴巴是否张开
    left_eyebrow_height: float = 0.0   # 左眉高度（归一化）
    right_eyebrow_height: float = 0.0  # 右眉高度（归一化）

    # 可视化用
    face_oval_px: list = field(default_factory=list)
    left_eyebrow_px: list = field(default_factory=list)
    right_eyebrow_px: list = field(default_factory=list)
    lips_outer_px: list = field(default_factory=list)
    lips_inner_px: list = field(default_factory=list)
    all_landmarks_px: list = field(default_factory=list)


class FaceTracker:
    """面部特征识别与追踪器"""

    def __init__(self):
        self._smooth_ear: Optional[float] = None
        self._blink_count: int = 0
        self._blink_frame_count: int = 0     # 连续低 EAR 帧数
        self._in_blink: bool = False          # 当前是否处于眨眼状态
        self._refractory_count: int = 0       # 眨眼后不应期计数
        self._ear_history: deque = deque(maxlen=30)  # EAR 历史（用于基线估计）
        self._ear_baseline: float = 0.30      # EAR 基线（动态更新）

    def update(self, face_landmarks, frame_w: int, frame_h: int) -> FaceFeatures:
        """
        处理一帧的面部关键点，返回面部特征。

        参数：
            face_landmarks: MediaPipe FaceLandmarks 对象（468+ 点）
                           如果为 None，返回未检测状态
            frame_w: 帧宽度（像素）
            frame_h: 帧高度（像素）
        """
        if face_landmarks is None:
            return FaceFeatures(face_detected=False, blink_count=self._blink_count)

        # 辅助函数：关键点索引 → 像素坐标
        def _px(idx: int) -> Tuple[int, int]:
            lm = face_landmarks.landmark[idx]
            return (int(lm.x * frame_w), int(lm.y * frame_h))

        def _px_float(idx: int) -> Tuple[float, float]:
            lm = face_landmarks.landmark[idx]
            return (lm.x * frame_w, lm.y * frame_h)

        def _norm(idx: int) -> Tuple[float, float, float]:
            lm = face_landmarks.landmark[idx]
            return (lm.x, lm.y, lm.z)

        # ============================================================
        # 1. 眼部特征
        # ============================================================
        left_eye = self._compute_eye_features(
            face_landmarks, frame_w, frame_h,
            LEFT_EYE_EAR_IDX, LEFT_EYE_CONTOUR, LEFT_IRIS_CENTER
        )
        right_eye = self._compute_eye_features(
            face_landmarks, frame_w, frame_h,
            RIGHT_EYE_EAR_IDX, RIGHT_EYE_CONTOUR, RIGHT_IRIS_CENTER
        )

        avg_ear = (left_eye.ear + right_eye.ear) / 2.0

        # EAR 平滑
        if self._smooth_ear is None:
            self._smooth_ear = avg_ear
        else:
            self._smooth_ear = (EAR_SMOOTHING_ALPHA * avg_ear
                                + (1 - EAR_SMOOTHING_ALPHA) * self._smooth_ear)

        # 动态基线更新（只在非眨眼时更新）
        if not self._in_blink and avg_ear > EAR_BLINK_THRESHOLD:
            self._ear_history.append(avg_ear)
            if len(self._ear_history) >= 10:
                self._ear_baseline = float(np.percentile(list(self._ear_history), 50))

        # 眨眼检测
        is_blinking = self._detect_blink(self._smooth_ear)

        # 眼睛开合度（基于基线归一化）
        if self._ear_baseline > 0.01:
            left_eye.openness = min(1.0, left_eye.ear / self._ear_baseline)
            right_eye.openness = min(1.0, right_eye.ear / self._ear_baseline)

        # ============================================================
        # 2. 面部朝向
        # ============================================================
        yaw, pitch, roll = self._estimate_head_pose(face_landmarks, frame_w, frame_h)

        # ============================================================
        # 3. 表情特征
        # ============================================================
        # MAR（嘴巴纵横比）
        mar = self._compute_mar(face_landmarks, frame_w, frame_h)
        mouth_open = mar > MAR_OPEN_THRESHOLD

        # 眉毛高度
        left_brow_h = self._compute_eyebrow_height(
            face_landmarks, frame_w, frame_h,
            LEFT_EYEBROW, LEFT_EYE_EAR_IDX[0]  # 眼睛外角作参考
        )
        right_brow_h = self._compute_eyebrow_height(
            face_landmarks, frame_w, frame_h,
            RIGHT_EYEBROW, RIGHT_EYE_EAR_IDX[0]
        )

        # ============================================================
        # 4. 可视化关键点提取
        # ============================================================
        face_oval_px = [_px(i) for i in FACE_OVAL]
        left_eyebrow_px = [_px(i) for i in LEFT_EYEBROW]
        right_eyebrow_px = [_px(i) for i in RIGHT_EYEBROW]
        lips_outer_px = [_px(i) for i in LIPS_OUTER]
        lips_inner_px = [_px(i) for i in LIPS_INNER]

        # 全部 468 点（用于网格绘制）
        all_landmarks_px = [_px(i) for i in range(468)]

        return FaceFeatures(
            face_detected=True,
            left_eye=left_eye,
            right_eye=right_eye,
            avg_ear=avg_ear,
            smooth_ear=self._smooth_ear,
            is_blinking=is_blinking,
            blink_count=self._blink_count,
            yaw=yaw,
            pitch=pitch,
            roll=roll,
            mar=mar,
            mouth_open=mouth_open,
            left_eyebrow_height=left_brow_h,
            right_eyebrow_height=right_brow_h,
            face_oval_px=face_oval_px,
            left_eyebrow_px=left_eyebrow_px,
            right_eyebrow_px=right_eyebrow_px,
            lips_outer_px=lips_outer_px,
            lips_inner_px=lips_inner_px,
            all_landmarks_px=all_landmarks_px,
        )

    def _compute_eye_features(
        self, face_landmarks, frame_w: int, frame_h: int,
        ear_indices: List[int], contour_indices: List[int],
        iris_idx: int,
    ) -> EyeFeatures:
        """计算单只眼睛的特征"""

        def _px(idx: int) -> Tuple[float, float]:
            lm = face_landmarks.landmark[idx]
            return (lm.x * frame_w, lm.y * frame_h)

        # EAR 计算（6 个关键点）
        # p1=外角, p2=上眼睑外, p3=上眼睑内, p4=内角, p5=下眼睑内, p6=下眼睑外
        p1 = np.array(_px(ear_indices[0]))
        p2 = np.array(_px(ear_indices[1]))
        p3 = np.array(_px(ear_indices[2]))
        p4 = np.array(_px(ear_indices[3]))
        p5 = np.array(_px(ear_indices[4]))
        p6 = np.array(_px(ear_indices[5]))

        # EAR = (|p2-p6| + |p3-p5|) / (2 * |p1-p4|)
        vertical_1 = float(np.linalg.norm(p2 - p6))
        vertical_2 = float(np.linalg.norm(p3 - p5))
        horizontal = float(np.linalg.norm(p1 - p4))

        ear = 0.0
        if horizontal > 1.0:
            ear = (vertical_1 + vertical_2) / (2.0 * horizontal)

        # 轮廓像素坐标
        contour_px = []
        for idx in contour_indices:
            lm = face_landmarks.landmark[idx]
            contour_px.append((int(lm.x * frame_w), int(lm.y * frame_h)))

        # 虹膜中心
        iris_lm = face_landmarks.landmark[iris_idx]
        iris_px = (int(iris_lm.x * frame_w), int(iris_lm.y * frame_h))

        return EyeFeatures(
            ear=ear,
            contour_px=contour_px,
            iris_px=iris_px,
        )

    def _detect_blink(self, smooth_ear: float) -> bool:
        """基于 EAR 阈值 + 帧计数检测眨眼"""
        # 不应期：刚检测到一次眨眼后跳过几帧
        if self._refractory_count > 0:
            self._refractory_count -= 1
            self._blink_frame_count = 0
            self._in_blink = False
            return False

        if smooth_ear < EAR_BLINK_THRESHOLD:
            self._blink_frame_count += 1
            if self._blink_frame_count >= BLINK_CONFIRM_FRAMES and not self._in_blink:
                self._in_blink = True
                self._blink_count += 1
                return True
            return self._in_blink
        else:
            if self._in_blink:
                # 眨眼结束，进入不应期
                self._refractory_count = BLINK_REFRACTORY_FRAMES
            self._blink_frame_count = 0
            self._in_blink = False
            return False

    def _estimate_head_pose(
        self, face_landmarks, frame_w: int, frame_h: int
    ) -> Tuple[float, float, float]:
        """
        估计面部朝向（yaw, pitch, roll）。
        使用 2D 关键点几何估计，非精确 PnP 解算。
        """
        def _px(idx: int) -> np.ndarray:
            lm = face_landmarks.landmark[idx]
            return np.array([lm.x * frame_w, lm.y * frame_h])

        nose = _px(NOSE_TIP)
        left_eye = _px(LEFT_EYE_OUTER)
        right_eye = _px(RIGHT_EYE_OUTER)
        chin = _px(CHIN)
        forehead = _px(FOREHEAD)

        # 双眼中心
        eye_center = (left_eye + right_eye) / 2.0
        eye_dist = float(np.linalg.norm(right_eye - left_eye))
        if eye_dist < 5.0:
            return (0.0, 0.0, 0.0)

        # Yaw：鼻尖相对双眼中心的水平偏移
        yaw = math.degrees(math.atan2(nose[0] - eye_center[0], eye_dist / 2.0))
        yaw = max(-90.0, min(90.0, yaw))

        # Pitch：鼻尖相对双眼-下巴连线的垂直偏移
        face_h = float(np.linalg.norm(forehead - chin))
        if face_h > 5.0:
            vertical_ratio = (nose[1] - eye_center[1]) / face_h
            pitch = (vertical_ratio - 0.33) * 150.0  # 归一化到度数
            pitch = max(-45.0, min(45.0, pitch))
        else:
            pitch = 0.0

        # Roll：双眼连线角度
        dx = right_eye[0] - left_eye[0]
        dy = right_eye[1] - left_eye[1]
        roll = math.degrees(math.atan2(dy, dx))

        return (yaw, pitch, roll)

    def _compute_mar(
        self, face_landmarks, frame_w: int, frame_h: int
    ) -> float:
        """计算嘴巴纵横比 (Mouth Aspect Ratio)"""
        def _px(idx: int) -> np.ndarray:
            lm = face_landmarks.landmark[idx]
            return np.array([lm.x * frame_w, lm.y * frame_h])

        top = _px(MOUTH_TOP)
        bottom = _px(MOUTH_BOTTOM)
        left = _px(MOUTH_LEFT)
        right = _px(MOUTH_RIGHT)

        vertical = float(np.linalg.norm(top - bottom))
        horizontal = float(np.linalg.norm(left - right))

        if horizontal < 1.0:
            return 0.0
        return vertical / horizontal

    def _compute_eyebrow_height(
        self, face_landmarks, frame_w: int, frame_h: int,
        brow_indices: List[int], eye_ref_idx: int,
    ) -> float:
        """计算眉毛高度（眉毛中心到眼睛参考点的归一化距离）"""
        def _px(idx: int) -> np.ndarray:
            lm = face_landmarks.landmark[idx]
            return np.array([lm.x * frame_w, lm.y * frame_h])

        brow_pts = [_px(i) for i in brow_indices]
        brow_center = np.mean(brow_pts, axis=0)
        eye_ref = _px(eye_ref_idx)

        # 眉毛中心到眼角的垂直距离（向上为正）
        # 归一化到面部宽度
        left_eye = _px(LEFT_EYE_OUTER)
        right_eye = _px(RIGHT_EYE_OUTER)
        face_w = float(np.linalg.norm(right_eye - left_eye))
        if face_w < 5.0:
            return 0.0

        height = (eye_ref[1] - brow_center[1]) / face_w
        return max(0.0, min(1.0, height))

    def reset(self):
        """重置追踪器状态"""
        self._smooth_ear = None
        self._blink_count = 0
        self._blink_frame_count = 0
        self._in_blink = False
        self._refractory_count = 0
        self._ear_history.clear()
        self._ear_baseline = 0.30
