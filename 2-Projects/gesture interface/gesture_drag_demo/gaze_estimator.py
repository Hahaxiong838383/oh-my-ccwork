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
    GAZE_SMOOTHING_ALPHA_Y, HEAD_WEIGHT_Y,
    HEAD_SCALE_Y, IRIS_SCALE_Y,
)


# MediaPipe FaceMesh 关键点索引
_NOSE_TIP = 1
_LEFT_EYE_OUTER = 33
_LEFT_EYE_INNER = 133
_RIGHT_EYE_INNER = 362
_RIGHT_EYE_OUTER = 263
_LEFT_IRIS_CENTER = 468
_RIGHT_IRIS_CENTER = 473

# 上下眼睑（用于垂直注视估计）
_LEFT_EYE_UPPER = 159     # 左眼上睑
_LEFT_EYE_LOWER = 145     # 左眼下睑
_RIGHT_EYE_UPPER = 386    # 右眼上睑
_RIGHT_EYE_LOWER = 374    # 右眼下睑


@dataclass
class GazeResult:
    """单帧注视估计结果"""
    face_detected: bool = False
    gaze_x: float = 0.0          # 平滑后的水平注视方向 [-1, 1]
    raw_gaze_x: float = 0.0      # 未平滑的原始值
    head_direction: float = 0.0   # 头部朝向分量
    iris_direction: float = 0.0   # 虹膜朝向分量
    gaze_y: float = 0.0          # 平滑后的垂直注视方向 [-1, 1]（-1=上, +1=下）
    raw_gaze_y: float = 0.0      # 未平滑的垂直原始值
    head_direction_y: float = 0.0 # 垂直头部朝向分量
    iris_direction_y: float = 0.0 # 垂直虹膜朝向分量
    confidence: float = 0.0       # 估计可信度 [0, 1]
    face_center: Optional[tuple] = None   # 面部中心像素坐标 (x, y)
    nose_tip: Optional[tuple] = None      # 鼻尖像素坐标
    left_iris: Optional[tuple] = None     # 左虹膜中心
    right_iris: Optional[tuple] = None    # 右虹膜中心
    face_landmarks: object = None         # 原始 FaceMesh landmarks（供 FaceTracker 使用）

    @property
    def direction_label(self) -> str:
        """返回可读的水平方向标签"""
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

    @property
    def direction_label_y(self) -> str:
        """返回可读的垂直方向标签"""
        g = self.gaze_y
        if g < -0.35:
            return "UP"
        elif g < -0.12:
            return "CENTER-U"
        elif g <= 0.12:
            return "CENTER"
        elif g <= 0.35:
            return "CENTER-D"
        else:
            return "DOWN"


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
        self._smooth_gaze_y: Optional[float] = None
        self._lost_count = 0

        # 2D 校准参数（仿射：calibrated = a * raw + b）
        self._calib_a_x: float = 1.0
        self._calib_b_x: float = 0.0
        self._calib_a_y: float = 1.0
        self._calib_b_y: float = 0.0
        self._calibrated: bool = False

    # ---------- 校准接口 ----------
    @property
    def is_calibrated(self) -> bool:
        return self._calibrated

    def set_calibration(self, a_x: float, b_x: float,
                        a_y: float, b_y: float):
        """设置 2D 仿射校准参数（calibrated = a * raw + b）"""
        self._calib_a_x = a_x
        self._calib_b_x = b_x
        self._calib_a_y = a_y
        self._calib_b_y = b_y
        self._calibrated = True
        self._smooth_gaze_x = None  # 重置平滑，避免旧值残留
        self._smooth_gaze_y = None
        print(f"[Gaze] 2D 校准已应用: "
              f"X: a={a_x:.3f} b={b_x:.3f}, "
              f"Y: a={a_y:.3f} b={b_y:.3f}")

    def clear_calibration(self):
        """清除校准参数，回到未校准状态（重新校准前必须调用）"""
        self._calib_a_x = 1.0
        self._calib_b_x = 0.0
        self._calib_a_y = 1.0
        self._calib_b_y = 0.0
        self._calibrated = False
        self._smooth_gaze_x = None
        self._smooth_gaze_y = None
        self._lost_count = 0
        print("[Gaze] 校准已清除，回到原始状态")

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
                self._smooth_gaze_y = None
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
        # 上下眼睑（垂直注视用）
        left_eye_upper = _px(_LEFT_EYE_UPPER)
        left_eye_lower = _px(_LEFT_EYE_LOWER)
        right_eye_upper = _px(_RIGHT_EYE_UPPER)
        right_eye_lower = _px(_RIGHT_EYE_LOWER)

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
        # 3. 水平加权融合
        # ============================================================
        raw_gaze_x = HEAD_WEIGHT * head_dir + (1 - HEAD_WEIGHT) * iris_dir
        raw_gaze_x = max(-1.0, min(1.0, raw_gaze_x))

        # ============================================================
        # 4. 垂直注视估计
        # ============================================================
        # 4a. 头部垂直朝向（鼻尖 y 相对面部中心 y）
        #     鼻子偏下 → 用户低头 → 正值
        # 用双眼外角 y 差的 2 倍近似面部高度
        eye_y_span = abs(left_eye_outer[1] - right_eye_outer[1])
        half_face_h = max(face_width * 0.6, eye_y_span * 2.0, 1.0)
        head_dir_y = (nose_tip[1] - face_center_y) / half_face_h * HEAD_SCALE_Y
        head_dir_y = max(-1.0, min(1.0, head_dir_y))

        # 4b. 虹膜垂直朝向（虹膜在上下眼睑之间的位置）
        iris_dir_y = 0.0
        iris_count_y = 0

        # 左眼垂直
        left_eye_h = left_eye_lower[1] - left_eye_upper[1]
        if left_eye_h > 3:
            left_ratio_y = (left_iris[1] - left_eye_upper[1]) / left_eye_h
            left_dir_y = (left_ratio_y - 0.5) * 2.0  # 映射到 [-1, 1]
            iris_dir_y += left_dir_y
            iris_count_y += 1

        # 右眼垂直
        right_eye_h = right_eye_lower[1] - right_eye_upper[1]
        if right_eye_h > 3:
            right_ratio_y = (right_iris[1] - right_eye_upper[1]) / right_eye_h
            right_dir_y = (right_ratio_y - 0.5) * 2.0
            iris_dir_y += right_dir_y
            iris_count_y += 1

        if iris_count_y > 0:
            iris_dir_y = iris_dir_y / iris_count_y * IRIS_SCALE_Y
            iris_dir_y = max(-1.0, min(1.0, iris_dir_y))

        # 4c. 垂直加权融合
        raw_gaze_y = HEAD_WEIGHT_Y * head_dir_y + (1 - HEAD_WEIGHT_Y) * iris_dir_y
        raw_gaze_y = max(-1.0, min(1.0, raw_gaze_y))

        # ============================================================
        # 5. 应用 2D 校准（在平滑之前）
        # ============================================================
        if self._calibrated:
            raw_gaze_x = self._calib_a_x * raw_gaze_x + self._calib_b_x
            raw_gaze_x = max(-1.0, min(1.0, raw_gaze_x))
            raw_gaze_y = self._calib_a_y * raw_gaze_y + self._calib_b_y
            raw_gaze_y = max(-1.0, min(1.0, raw_gaze_y))

        # ============================================================
        # 6. EMA 平滑
        # ============================================================
        # 水平
        if self._smooth_gaze_x is None:
            self._smooth_gaze_x = raw_gaze_x
        else:
            self._smooth_gaze_x = (GAZE_SMOOTHING_ALPHA * raw_gaze_x
                                   + (1 - GAZE_SMOOTHING_ALPHA) * self._smooth_gaze_x)

        # 垂直
        if self._smooth_gaze_y is None:
            self._smooth_gaze_y = raw_gaze_y
        else:
            self._smooth_gaze_y = (GAZE_SMOOTHING_ALPHA_Y * raw_gaze_y
                                   + (1 - GAZE_SMOOTHING_ALPHA_Y) * self._smooth_gaze_y)

        # 可信度：基于面部宽度（太小 → 太远 → 不可靠）
        confidence = min(1.0, face_width / 150.0)

        return GazeResult(
            face_detected=True,
            gaze_x=self._smooth_gaze_x,
            raw_gaze_x=raw_gaze_x,
            head_direction=head_dir,
            iris_direction=iris_dir,
            gaze_y=self._smooth_gaze_y,
            raw_gaze_y=raw_gaze_y,
            head_direction_y=head_dir_y,
            iris_direction_y=iris_dir_y,
            confidence=confidence,
            face_center=(int(face_center_x), int(face_center_y)),
            nose_tip=nose_tip,
            left_iris=left_iris,
            right_iris=right_iris,
            face_landmarks=face_lms,
        )

    def reset(self):
        """重置平滑状态"""
        self._smooth_gaze_x = None
        self._smooth_gaze_y = None
        self._lost_count = 0

    def close(self):
        """释放 FaceMesh 资源"""
        self._face_mesh.close()
