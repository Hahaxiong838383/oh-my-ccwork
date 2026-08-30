"""
gaze_estimator.py - 粗粒度注视方向估计

使用 MediaPipe FaceMesh + Iris Landmarks：
- 头部朝向：鼻尖相对于双眼中心的偏移比例
- 虹膜朝向：虹膜中心在眼白中的位置比例
- 加权融合得到粗粒度水平注视方向 gaze_x ∈ [-1, 1]
  （-1 = 向左，0 = 正前方，1 = 向右，镜像画面视角）

不做精确注视点映射，只做方向级别的估计。
"""

import time

import cv2
import numpy as np
import mediapipe as mp
from dataclasses import dataclass
from typing import Optional

from config import (
    FACE_CONF_THRESHOLD, FACE_TRACK_THRESHOLD,
    HEAD_WEIGHT,
    HEAD_SCALE, IRIS_SCALE, MIN_FACE_WIDTH,
    HEAD_WEIGHT_Y,
    HEAD_SCALE_Y, IRIS_SCALE_Y,
    GAZE_MIN_CUTOFF, GAZE_BETA, GAZE_MIN_CUTOFF_Y, GAZE_BETA_Y,
    GAZE_D_CUTOFF,
    GAZE_BACKEND, GAZE_PT_DEG_SCALE, GAZE_PT_DEVICE,
    CAMERA_WIDTH, CAMERA_HEIGHT,
)
from one_euro import OneEuroFilter


def build_ptgaze_backend(cam_w: int = CAMERA_WIDTH, cam_h: int = CAMERA_HEIGHT):
    """构造 ptgaze ETH-XGaze 估计器（v3.8 路线B 信号源；probe_ab_gaze 共用）。

    lazy import：legacy 后端不碰 torch/ptgaze，零额外开销。
    模型文件优先用项目 models/（离线可用+可打包）；缺失时下载并自愈补齐，
    face_landmarker 决不落 ~/.ptgaze（HOME 顶层白名单）。
    """
    import os
    import shutil
    import pathlib
    import ptgaze
    from omegaconf import OmegaConf
    from ptgaze.gaze_estimator import GazeEstimator as PtGazeEstimator
    from ptgaze.config_schema import AppConfig
    from ptgaze.utils import (download_ethxgaze_model,
                              download_mediapipe_face_landmarker)

    pkg_root = pathlib.Path(ptgaze.__file__).parent.resolve()
    loaded = OmegaConf.load(pkg_root / "data/configs/eth-xgaze.yaml")
    config = OmegaConf.merge(OmegaConf.structured(AppConfig), loaded)
    config.PACKAGE_ROOT = pkg_root.as_posix()

    models_dir = pathlib.Path(__file__).parent / "models"
    local_task = models_dir / "face_landmarker.task"
    if not local_task.exists():
        download_mediapipe_face_landmarker()
        models_dir.mkdir(exist_ok=True)
        legacy_task = pathlib.Path(
            "~/.ptgaze/mediapipe/face_landmarker.task").expanduser()
        shutil.move(legacy_task, local_task)
        shutil.rmtree(pathlib.Path("~/.ptgaze").expanduser(),
                      ignore_errors=True)
    config.face_detector.mediapipe_model_path = local_task.as_posix()

    local_ckpt = models_dir / "eth-xgaze_resnet18.safetensors"
    if not local_ckpt.exists():
        models_dir.mkdir(exist_ok=True)
        shutil.copy(download_ethxgaze_model(), local_ckpt)
    config.gaze_estimator.checkpoint = local_ckpt.as_posix()

    config.gaze_estimator.use_dummy_camera_params = True
    config.gaze_estimator.dummy_camera_size = [cam_w, cam_h]

    # v3.8.1：MPS 推理（CPU 19.5ms 致帧率腰斩）；不可用回退 cpu
    device = GAZE_PT_DEVICE
    if device == "mps":
        import torch
        if not torch.backends.mps.is_available():
            print("[Gaze] ⚠️ MPS 不可用，回退 CPU 推理")
            device = "cpu"
    config.device = device
    print(f"[Gaze] ptgaze 推理设备: {device}")
    return PtGazeEstimator(config)


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
    raw_gaze_x: float = 0.0      # 未平滑的原始值（校准后）
    uncal_gaze_x: float = 0.0    # 未校准原始值（隐式校准采样用，勿混用）
    uncal_gaze_y: float = 0.0    # 未校准垂直原始值
    head_direction: float = 0.0   # 头部朝向分量
    iris_direction: float = 0.0   # 虹膜朝向分量
    gaze_y: float = 0.0          # 平滑后的垂直注视方向 [-1, 1]（-1=上, +1=下）
    raw_gaze_y: float = 0.0      # 未平滑的垂直原始值
    head_direction_y: float = 0.0 # 垂直头部朝向分量
    iris_direction_y: float = 0.0 # 垂直虹膜朝向分量
    confidence: float = 0.0       # 估计可信度 [0, 1]
    backend: str = "legacy"       # 本帧 gaze 信号源（"ptgaze"/"legacy"）
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
        # OneEuro 平滑（2026-07 路线A：替代固定 EMA——慢速强平滑抗抖、
        # 快速低滞后跟手；调研依据 UnitEye MuC'24 三滤波实测对比）
        self._filter_x = OneEuroFilter(
            min_cutoff=GAZE_MIN_CUTOFF, beta=GAZE_BETA, d_cutoff=GAZE_D_CUTOFF)
        self._filter_y = OneEuroFilter(
            min_cutoff=GAZE_MIN_CUTOFF_Y, beta=GAZE_BETA_Y, d_cutoff=GAZE_D_CUTOFF)
        self._lost_count = 0

        # 2D 校准参数（2026-07 路线A：per-axis 仿射 → 含 xy 交叉项的
        # 二阶多项式，联合输入 (x,y) 修正边缘/垂直非线性与轴间耦合；
        # coef 为 6 维：[1, x, y, x², xy, y²] 的系数）
        self._calib_coef_x: Optional[np.ndarray] = None
        self._calib_coef_y: Optional[np.ndarray] = None
        self._calibrated: bool = False

        # ── v3.8 路线B：ptgaze ETH-XGaze 信号源 ──
        # FaceMesh 仍每帧照跑（face_tracker 眨眼/EAR、UI、confidence 全靠
        # 它），ptgaze 只接管 raw gaze；模型侧偶发丢脸自动回退 legacy 顶帧
        self._backend = GAZE_BACKEND
        self._ptgaze = None
        self.ptgaze_miss_count = 0     # 模型侧丢脸帧计数（诊断）
        if self._backend == "ptgaze":
            print("[Gaze] 初始化 ptgaze ETH-XGaze 后端...")
            self._ptgaze = build_ptgaze_backend()
            print("[Gaze] ptgaze 后端就绪（回滚：config.GAZE_BACKEND='legacy'）")

    # ---------- 校准接口 ----------
    @property
    def is_calibrated(self) -> bool:
        return self._calibrated

    @staticmethod
    def poly_features(x: float, y: float) -> np.ndarray:
        """二阶多项式特征向量 [1, x, y, x², xy, y²]（校准拟合与应用共用）"""
        return np.array([1.0, x, y, x * x, x * y, y * y])

    def set_calibration(self, coef_x: np.ndarray, coef_y: np.ndarray,
                        reset_filters: bool = True):
        """设置 2D 多项式校准系数（各 6 维，对应 [1,x,y,x²,xy,y²]）。

        reset_filters：显式校准（系数大变）保持 True 清旧平滑值；
        隐式在线重拟合（v3.7）传 False——参数只微调，reset 反而让
        OneEuro 瞬断跳变，每 3 次抓卡闪一次。
        """
        self._calib_coef_x = np.asarray(coef_x, dtype=float)
        self._calib_coef_y = np.asarray(coef_y, dtype=float)
        self._calibrated = True
        if reset_filters:
            self._filter_x.reset()  # 重置平滑，避免旧值残留
            self._filter_y.reset()
        print(f"[Gaze] 2D 多项式校准已应用: "
              f"coef_x={np.round(self._calib_coef_x, 3).tolist()}, "
              f"coef_y={np.round(self._calib_coef_y, 3).tolist()}")

    def clear_calibration(self):
        """清除校准参数，回到未校准状态（重新校准前必须调用）"""
        self._calib_coef_x = None
        self._calib_coef_y = None
        self._calibrated = False
        self._filter_x.reset()
        self._filter_y.reset()
        self._lost_count = 0
        print("[Gaze] 校准已清除，回到原始状态")

    def _ptgaze_infer(self, frame: np.ndarray) -> Optional[tuple]:
        """ptgaze 推理一帧 → 归一化 (x, y)；模型侧无脸 → None。

        符号按 2026-08-30 川哥真人探针实测定标（镜像帧坐标系）：
        看右 yaw 变负 → x=-yaw/scale；看下 pitch 变负 → y=-pitch/scale。
        摄像头俯仰导致的整体偏置由校准 bias 项吸收。
        """
        faces = self._ptgaze.detect_faces(frame)
        if not faces:
            return None
        self._ptgaze.estimate_gaze(frame, faces[0])
        gv = faces[0].gaze_vector
        if gv is None:
            return None
        pitch, yaw = np.rad2deg(faces[0].vector_to_angle(gv))
        x = max(-1.0, min(1.0, -float(yaw) / GAZE_PT_DEG_SCALE))
        y = max(-1.0, min(1.0, -float(pitch) / GAZE_PT_DEG_SCALE))
        return x, y

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
                self._filter_x.reset()
                self._filter_y.reset()
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
        # 4d. v3.8 信号源分叉：ptgaze 后端覆盖 raw gaze
        # （AB 探针实测：垂直 SNR 11.43 vs 手工 0.52，probe_ab_result.txt）
        # 模型侧偶发丢脸 → 保留上面算好的 legacy 值顶一帧（自动降级）
        # ============================================================
        frame_backend = "legacy"
        if self._ptgaze is not None:
            pg = self._ptgaze_infer(frame)
            if pg is not None:
                raw_gaze_x, raw_gaze_y = pg
                frame_backend = "ptgaze"
            else:
                self.ptgaze_miss_count += 1

        # ============================================================
        # 5. 应用 2D 校准（在平滑之前）
        # 二阶多项式联合映射：cal = coef · [1, x, y, x², xy, y²]
        # （x/y 联合输入 → 能拟合"看角落时两轴耦合"的非线性）
        # ============================================================
        # 保留未校准原始值（隐式校准采样必须用它——校准后的值喂回
        # 拟合器会形成"校准套校准"复合漂移）
        uncal_gaze_x, uncal_gaze_y = raw_gaze_x, raw_gaze_y
        if self._calibrated:
            feats = self.poly_features(raw_gaze_x, raw_gaze_y)
            raw_gaze_x = max(-1.0, min(1.0, float(self._calib_coef_x @ feats)))
            raw_gaze_y = max(-1.0, min(1.0, float(self._calib_coef_y @ feats)))

        # ============================================================
        # 6. OneEuro 平滑（速度自适应：静视强平滑、扫视低滞后）
        # ============================================================
        now = time.monotonic()
        self._smooth_gaze_x = self._filter_x.filter(raw_gaze_x, now)
        self._smooth_gaze_y = self._filter_y.filter(raw_gaze_y, now)

        # 可信度：基于面部宽度（太小 → 太远 → 不可靠）
        confidence = min(1.0, face_width / 150.0)

        return GazeResult(
            face_detected=True,
            backend=frame_backend,
            gaze_x=self._smooth_gaze_x,
            raw_gaze_x=raw_gaze_x,
            uncal_gaze_x=uncal_gaze_x,
            uncal_gaze_y=uncal_gaze_y,
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
        self._filter_x.reset()
        self._filter_y.reset()
        self._lost_count = 0

    def close(self):
        """释放 FaceMesh / ptgaze 资源"""
        self._face_mesh.close()
        if self._ptgaze is not None:
            try:
                self._ptgaze.close()
            except Exception:
                pass  # 退出清理，尽力而为
