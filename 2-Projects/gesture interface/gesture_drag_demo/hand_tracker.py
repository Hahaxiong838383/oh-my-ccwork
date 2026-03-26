"""
hand_tracker.py - 摄像头与手部关键点检测模块

职责：
- 打开摄像头并读取帧
- 使用 MediaPipe Hands 检测手部关键点
- 提供拇指尖、食指尖、手掌尺度等关键数据
"""

import cv2
import numpy as np
import mediapipe as mp
from dataclasses import dataclass
from typing import Optional


# MediaPipe 手部关键点索引
WRIST = 0
THUMB_TIP = 4
INDEX_MCP = 5
INDEX_TIP = 8
MIDDLE_MCP = 9
PINKY_MCP = 17


@dataclass
class HandData:
    """单帧手部检测结果"""
    thumb_tip: np.ndarray       # 拇指尖 (x, y) 像素坐标
    index_tip: np.ndarray       # 食指尖 (x, y) 像素坐标
    pinch_center: np.ndarray    # 拇指尖与食指尖中点
    pinch_distance: float       # 拇指尖与食指尖像素距离
    hand_scale: float           # 手部尺度参考值（像素）
    pinch_ratio: float          # pinch_distance / hand_scale
    landmarks_px: list          # 所有关键点像素坐标 [(x,y), ...]


class HandTracker:
    """摄像头 + MediaPipe Hands 封装"""

    def __init__(
        self,
        camera_index: int = 0,
        width: int = 1280,
        height: int = 720,
        max_num_hands: int = 1,
        min_detection_confidence: float = 0.7,
        min_tracking_confidence: float = 0.6,
    ):
        # 初始化摄像头（macOS 用 AVFoundation，Windows 用 DirectShow）
        import platform
        if platform.system() == "Darwin":
            self.cap = cv2.VideoCapture(camera_index)
        else:
            self.cap = cv2.VideoCapture(camera_index, cv2.CAP_DSHOW)
        self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
        self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
        self.cap.set(cv2.CAP_PROP_FPS, 30)

        if not self.cap.isOpened():
            raise RuntimeError(f"无法打开摄像头 (index={camera_index})")

        # 读取实际分辨率
        self.frame_w = int(self.cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        self.frame_h = int(self.cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

        # 初始化 MediaPipe Hands
        self.mp_hands = mp.solutions.hands
        self.hands = self.mp_hands.Hands(
            static_image_mode=False,
            max_num_hands=max_num_hands,
            min_detection_confidence=min_detection_confidence,
            min_tracking_confidence=min_tracking_confidence,
        )
        self.mp_draw = mp.solutions.drawing_utils

    def read_frame(self) -> Optional[np.ndarray]:
        """读取一帧，返回 BGR 图像（已水平翻转为镜像）"""
        ret, frame = self.cap.read()
        if not ret:
            return None
        return cv2.flip(frame, 1)  # 镜像翻转，更符合用户直觉

    def detect(self, frame: np.ndarray) -> Optional[HandData]:
        """
        检测手部关键点，返回 HandData 或 None（未检测到手）。
        frame: BGR 图像
        """
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        results = self.hands.process(rgb)

        if not results.multi_hand_landmarks:
            return None

        hand_lms = results.multi_hand_landmarks[0]
        h, w = frame.shape[:2]

        # 将归一化坐标转为像素坐标
        landmarks_px = []
        for lm in hand_lms.landmark:
            px = int(lm.x * w)
            py = int(lm.y * h)
            landmarks_px.append((px, py))

        thumb_tip = np.array(landmarks_px[THUMB_TIP], dtype=np.float64)
        index_tip = np.array(landmarks_px[INDEX_TIP], dtype=np.float64)
        wrist = np.array(landmarks_px[WRIST], dtype=np.float64)
        middle_mcp = np.array(landmarks_px[MIDDLE_MCP], dtype=np.float64)

        # pinch 中点
        pinch_center = (thumb_tip + index_tip) / 2.0

        # pinch 距离
        pinch_distance = float(np.linalg.norm(thumb_tip - index_tip))

        # 手部尺度：wrist → middle_mcp 距离（较稳定）
        hand_scale = float(np.linalg.norm(wrist - middle_mcp))
        if hand_scale < 1.0:
            hand_scale = 1.0  # 防止除零

        pinch_ratio = pinch_distance / hand_scale

        return HandData(
            thumb_tip=thumb_tip,
            index_tip=index_tip,
            pinch_center=pinch_center,
            pinch_distance=pinch_distance,
            hand_scale=hand_scale,
            pinch_ratio=pinch_ratio,
            landmarks_px=landmarks_px,
        )

    def draw_landmarks(self, frame: np.ndarray, hand_data: HandData):
        """在画面上绘制关键点和连线"""
        # 拇指尖 - 红色
        cv2.circle(frame, tuple(hand_data.thumb_tip.astype(int)), 10, (0, 0, 255), -1)
        # 食指尖 - 蓝色
        cv2.circle(frame, tuple(hand_data.index_tip.astype(int)), 10, (255, 0, 0), -1)
        # pinch 中点 - 绿色
        cv2.circle(frame, tuple(hand_data.pinch_center.astype(int)), 8, (0, 255, 0), -1)
        # 拇指尖到食指尖连线
        cv2.line(
            frame,
            tuple(hand_data.thumb_tip.astype(int)),
            tuple(hand_data.index_tip.astype(int)),
            (0, 255, 255), 2,
        )

    def release(self):
        """释放摄像头资源"""
        self.cap.release()
        self.hands.close()
