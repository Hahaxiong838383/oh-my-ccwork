"""
gaze_estimator.py - 粗粒度注视方向估计

使用 MediaPipe FaceMesh + Iris Landmarks：
- 头部朝向：鼻尖相对于双眼中心的偏移比例
- 虹膜朝向：虹膜中心在眼白中的位置比例
- 加权融合得到粗粒度水平注视方向 gaze_x ∈ [-1, 1]
  （-1 = 向左，0 = 正前方，1 = 向右，镜像画面视角）

不做精确注视点映射，只做方向级别的估计。
"""

import cv2
import numpy as np
import mediapipe as mp
from dataclasses import dataclass
from typing import Optional

from config import (
    FACE_CONF_THRESHOLD, FACE_TRACK_THRESHOLD,
    GAZE_SMOOTHING_ALPHA, HEAD_WEIGHT,
    HEAD_SCALE, IRIS_SCALE, MIN_FACE_WIDTH,
)


# MediaPipe FaceMesh 关键点索引
_NOSE_TIP = 1
_LEFT_EYE_OUTER = 33
_LEFT_EYE_INNER = 133
_RIGHT_EYE_INNER = 362
_RIGHT_EYE_OUTER = 263
_LEFT_IRIS_CENTER = 468
_RIGHT_IRIS_CENTER = 473


@dataclass
class GazeResult:
    """单帧注视估计结果"""
    face_detected: bool = False
    gaze_x: float = 0.0          # 平滑后的水平注视方向 [-1, 1]
    raw_gaze_x: float = 0.0      # 未平滑的原始值
    head_direction: float = 0.0   # 头部朝向分量
    iris_direction: float = 0.0   # 虹膜朝向分量
    confidence: float = 0.0       # 估计可信度 [0, 1]
    face_center: Optional[tuple] = None   # 面部中心像素坐标 (x, y)
    nose_tip: Optional[tuple] = None      # 鼻尖像素坐标
    left_iris: Optional[tuple] = None     # 左虹膜中心
    right_iris: Optional[tuple] = None    # 右虹膜中心

    @property
    def direction_label(self) -> str:
        """返回可读的方向标签"""
        g = self.gaze_x
        if g < -0.35:
            return "LEFT"
        elif g < -0.12:
            return "CENTER-L"
        elif g <= 0.12:
            return "CENTER"
        elif g <= 0.35:
            return "CENTER-R"
        else:
            return "RIGHT"


class GazeEstimator:
    """粗粒度注视方向估计器"""

    def __init__(self):
        self._mp_face_mesh = mp.solutions.face_mesh
        self._face_mesh = self._mp_face_mesh.FaceMesh(
            static_image_mode=False,
            max_num_faces=1,
            refine_landmarks=True,  # 启用虹膜关键点 (468-477)
            min_detection_confidence=FACE_CONF_THRESHOLD,
            min_tracking_confidence=FACE_TRACK_THRESHOLD,
        )
        self._smooth_gaze_x: Optional[float] = None
        self._lost_count = 0

    def update(self, frame: np.ndarray) -> GazeResult:
        """
        处理一帧，返回注视估计结果。
        frame: BGR 图像（已镜像翻转）
        """
        h, w = frame.shape[:2]
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        results = self._face_mesh.process(rgb)

        if not results.multi_face_landmarks:
            self._lost_count += 1
            if self._lost_count > 10:
                self._smooth_gaze_x = None
            return GazeResult(face_detected=False)

        self._lost_count = 0
        face_lms = results.multi_face_landmarks[0]

        # 提取关键点像素坐标
        def _px(idx):
            lm = face_lms.landmark[idx]
            return (int(lm.x * w), int(lm.y * h))

        nose_tip = _px(_NOSE_TIP)
        left_eye_outer = _px(_LEFT_EYE_OUTER)
        left_eye_inner = _px(_LEFT_EYE_INNER)
        right_eye_inner = _px(_RIGHT_EYE_INNER)
        right_eye_outer = _px(_RIGHT_EYE_OUTER)
        left_iris = _px(_LEFT_IRIS_CENTER)
        right_iris = _px(_RIGHT_IRIS_CENTER)

        # --- 面部宽度（双眼外角距离）---
        face_width = abs(right_eye_outer[0] - left_eye_outer[0])
        if face_width < MIN_FACE_WIDTH:
            return GazeResult(face_detected=True, confidence=0.0)

        # --- 面部中心（双眼中心）---
        face_center_x = (left_eye_outer[0] + right_eye_outer[0]) / 2.0
        face_center_y = (left_eye_outer[1] + right_eye_outer[1]) / 2.0
        half_face_w = face_width / 2.0

        # ============================================================
        # 1. 头部朝向（鼻尖偏移比例）
        # ============================================================
        # 镜像画面中：鼻子相对于双眼中心偏右 → 用户看右 → 正值
        head_dir = (nose_tip[0] - face_center_x) / half_face_w * HEAD_SCALE
        head_dir = max(-1.0, min(1.0, head_dir))

        # ============================================================
        # 2. 虹膜朝向（虹膜在眼白中的位置）
        # ============================================================
        # 左眼：在镜像画面中，外角在左、内角在右
        left_eye_w = abs(left_eye_inner[0] - left_eye_outer[0])
        right_eye_w = abs(right_eye_outer[0] - right_eye_inner[0])

        iris_dir = 0.0
        iris_count = 0

        if left_eye_w > 5:
            # 左眼虹膜位置比率：0=外角，1=内角
            left_ratio = (left_iris[0] - left_eye_outer[0]) / left_eye_w
            # 映射到 [-1, 1]：0.5 是中心
            left_dir = (left_ratio - 0.5) * 2.0
            iris_dir += left_dir
            iris_count += 1

        if right_eye_w > 5:
            # 右眼虹膜位置比率：0=内角，1=外角
            right_ratio = (right_iris[0] - right_eye_inner[0]) / right_eye_w
            # 映射到 [-1, 1]：0.5 是中心
            right_dir = (right_ratio - 0.5) * 2.0
            iris_dir += right_dir
            iris_count += 1

        if iris_count > 0:
            iris_dir = iris_dir / iris_count * IRIS_SCALE
            iris_dir = max(-1.0, min(1.0, iris_dir))

        # ============================================================
        # 3. 加权融合
        # ============================================================
        raw_gaze_x = HEAD_WEIGHT * head_dir + (1 - HEAD_WEIGHT) * iris_dir
        raw_gaze_x = max(-1.0, min(1.0, raw_gaze_x))

        # EMA 平滑
        if self._smooth_gaze_x is None:
            self._smooth_gaze_x = raw_gaze_x
        else:
            alpha = GAZE_SMOOTHING_ALPHA
            self._smooth_gaze_x = alpha * raw_gaze_x + (1 - alpha) * self._smooth_gaze_x

        # 可信度：基于面部宽度（太小 → 太远 → 不可靠）
        confidence = min(1.0, face_width / 150.0)

        return GazeResult(
            face_detected=True,
            gaze_x=self._smooth_gaze_x,
            raw_gaze_x=raw_gaze_x,
            head_direction=head_dir,
            iris_direction=iris_dir,
            confidence=confidence,
            face_center=(int(face_center_x), int(face_center_y)),
            nose_tip=nose_tip,
            left_iris=left_iris,
            right_iris=right_iris,
        )

    def reset(self):
        """重置平滑状态"""
        self._smooth_gaze_x = None
        self._lost_count = 0

    def close(self):
        """释放 FaceMesh 资源"""
        self._face_mesh.close()
