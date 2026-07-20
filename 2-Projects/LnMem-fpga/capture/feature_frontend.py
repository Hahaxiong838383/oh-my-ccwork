"""视觉前端 F1 路线：MediaPipe FaceLandmarker → blendshapes(52) + 派生几何(12) = feat[64]。

与契约 §3 对应：本文件就是「前端投影」的 v0 实现；换前端（F2 embedding）只需
保持 64 维输出与本文件的 FeatureFrontend.extract 签名。
落盘 raw 值；per-dim μ/σ 标准化在训练侧做（契约 §3.2）。
"""
from __future__ import annotations

import math
import time
from collections import deque
from dataclasses import dataclass

import numpy as np

BLENDSHAPE_DIM = 52
DERIVED_DIM = 12
FEAT_DIM = BLENDSHAPE_DIM + DERIVED_DIM

# 派生 12 维定义（README 同步维护）：
# 0-2  pose_delta: yaw/pitch/roll 一阶差分（度/帧）
# 3-4  bbox_center_vel: 中心 x/y 速度（归一化/帧）
# 5    bbox_scale_vel: bbox 面积开方的一阶差分
# 6    bbox_y: bbox 顶边 y（躯干起身代理——上移=起身前兆，I5 关键信号）
# 7    face_presence_5s: 近 5s 有脸帧占比
# 8-10 jawOpen/browDown(L+R均值)/mouthSmile(L+R均值) 一阶差分
# 11   landmark_stability: 全部 landmark 帧间平均位移（抖动度）
DERIVED_NAMES = ["pose_d_yaw", "pose_d_pitch", "pose_d_roll", "bbox_vx", "bbox_vy",
                 "bbox_scale_v", "bbox_y", "presence_5s", "jawOpen_d", "browDown_d",
                 "mouthSmile_d", "landmark_stab"]


@dataclass
class FaceResult:
    present: bool
    bbox: list[float]          # 归一化 x,y,w,h
    pose: list[float]          # yaw,pitch,roll 度
    pose_valid: bool
    feat: list[float]          # FEAT_DIM
    quality: float
    bs_top: list = None        # [(name, score)] top6（面板显示用）
    expr: dict = None          # 规则表情关键键（面板 emoji 用）


class _History:
    def __init__(self):
        self.prev_pose: list[float] | None = None
        self.prev_center: tuple[float, float] | None = None
        self.prev_scale: float | None = None
        self.prev_bs: dict[str, float] | None = None
        self.prev_landmarks: np.ndarray | None = None
        self.presence = deque(maxlen=75)  # ~5s @15fps

    def reset(self):
        self.__init__()


def _euler_from_matrix(m: np.ndarray) -> list[float]:
    """4x4 变换矩阵 → yaw/pitch/roll（度）。"""
    r = m[:3, :3]
    sy = math.hypot(r[0, 0], r[1, 0])
    if sy > 1e-6:
        pitch = math.degrees(math.atan2(-r[2, 0], sy))
        yaw = math.degrees(math.atan2(r[1, 0], r[0, 0]))
        roll = math.degrees(math.atan2(r[2, 1], r[2, 2]))
    else:
        pitch = math.degrees(math.atan2(-r[2, 0], sy))
        yaw = 0.0
        roll = math.degrees(math.atan2(-r[1, 2], r[1, 1]))
    return [yaw, pitch, roll]


class FeatureFrontend:
    """封装 MediaPipe FaceLandmarker（VIDEO 模式）。"""

    def __init__(self, model_path: str):
        import mediapipe as mp
        from mediapipe.tasks import python as mp_python
        from mediapipe.tasks.python import vision

        base = mp_python.BaseOptions(model_asset_path=model_path)
        opts = vision.FaceLandmarkerOptions(
            base_options=base,
            running_mode=vision.RunningMode.VIDEO,
            num_faces=1,
            output_face_blendshapes=True,
            output_facial_transformation_matrixes=True,
        )
        self._mp = mp
        self._landmarker = vision.FaceLandmarker.create_from_options(opts)
        self._hist = _History()
        self.blendshape_names: list[str] = []  # 首个有脸帧填充；session_meta 落盘供训练侧对齐

    def reset_history(self):
        self._hist.reset()

    def extract(self, rgb_frame: np.ndarray, ts_ms: int) -> FaceResult:
        mp_img = self._mp.Image(image_format=self._mp.ImageFormat.SRGB, data=rgb_frame)
        res = self._landmarker.detect_for_video(mp_img, ts_ms)
        h = self._hist

        if not res.face_landmarks:
            h.presence.append(0)
            h.prev_landmarks = None
            return FaceResult(False, [0, 0, 0, 0], [0, 0, 0], False,
                              [0.0] * FEAT_DIM, 0.0, [], {})

        h.presence.append(1)
        lms = np.array([[p.x, p.y] for p in res.face_landmarks[0]], dtype=np.float32)
        x0, y0 = lms.min(axis=0)
        x1, y1 = lms.max(axis=0)
        bbox = [float(x0), float(y0), float(x1 - x0), float(y1 - y0)]
        center = (float(x0 + x1) / 2.0, float(y0 + y1) / 2.0)
        scale = math.sqrt(max(1e-9, (x1 - x0) * (y1 - y0)))

        # blendshapes: 52 维，按 MediaPipe 固定顺序
        bs_list = res.face_blendshapes[0]
        if not self.blendshape_names:
            self.blendshape_names = [c.category_name for c in bs_list][:BLENDSHAPE_DIM]
        bs = {c.category_name: float(c.score) for c in bs_list}
        bs_vec = [float(c.score) for c in bs_list][:BLENDSHAPE_DIM]
        bs_vec += [0.0] * (BLENDSHAPE_DIM - len(bs_vec))

        pose_valid = bool(res.facial_transformation_matrixes)
        pose = _euler_from_matrix(np.array(res.facial_transformation_matrixes[0])) \
            if pose_valid else [0.0, 0.0, 0.0]

        # 派生 12 维
        d = [0.0] * DERIVED_DIM
        if h.prev_pose is not None and pose_valid:
            d[0:3] = [pose[i] - h.prev_pose[i] for i in range(3)]
        if h.prev_center is not None:
            d[3] = center[0] - h.prev_center[0]
            d[4] = center[1] - h.prev_center[1]
        if h.prev_scale is not None:
            d[5] = scale - h.prev_scale
        d[6] = float(y0)
        d[7] = sum(h.presence) / max(1, len(h.presence))
        if h.prev_bs is not None:
            d[8] = bs.get("jawOpen", 0.0) - h.prev_bs.get("jawOpen", 0.0)
            brow = (bs.get("browDownLeft", 0.0) + bs.get("browDownRight", 0.0)) / 2
            brow_p = (h.prev_bs.get("browDownLeft", 0.0) + h.prev_bs.get("browDownRight", 0.0)) / 2
            d[9] = brow - brow_p
            smile = (bs.get("mouthSmileLeft", 0.0) + bs.get("mouthSmileRight", 0.0)) / 2
            smile_p = (h.prev_bs.get("mouthSmileLeft", 0.0) + h.prev_bs.get("mouthSmileRight", 0.0)) / 2
            d[10] = smile - smile_p
        if h.prev_landmarks is not None and len(h.prev_landmarks) == len(lms):
            d[11] = float(np.linalg.norm(lms - h.prev_landmarks, axis=1).mean())

        h.prev_pose = pose if pose_valid else h.prev_pose
        h.prev_center, h.prev_scale, h.prev_bs, h.prev_landmarks = center, scale, bs, lms

        # quality v0：有脸即 0.5 起步 + 尺度加成（太小的脸降分）；上线前按手册 §6 R4 校准
        quality = min(1.0, 0.5 + scale * 2.0)
        feat = [float(v) for v in bs_vec + d]  # numpy 标量统一转 python float（JSON 序列化）
        bs_top = sorted(((k, v) for k, v in bs.items() if k != "_neutral"),
                        key=lambda kv: -kv[1])[:6]
        expr = {
            "smile": (bs.get("mouthSmileLeft", 0) + bs.get("mouthSmileRight", 0)) / 2,
            "jawOpen": bs.get("jawOpen", 0.0),
            "browDown": (bs.get("browDownLeft", 0) + bs.get("browDownRight", 0)) / 2,
            "browInnerUp": bs.get("browInnerUp", 0.0),
        }
        return FaceResult(True, bbox, pose, pose_valid, feat, quality,
                          [(k, round(v, 3)) for k, v in bs_top], expr)

    def close(self):
        self._landmarker.close()


def now_mono_ms() -> int:
    return int(time.monotonic() * 1000)
