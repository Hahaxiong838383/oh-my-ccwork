"""
calibration.py - 眼动追踪校准模块

启动时引导用户注视屏幕上 3 个校准点（左 / 中 / 右），
采集原始注视数据并计算线性校准参数（offset + scale），
写入 GazeEstimator 以提高后续注视估计精度。

校准模型：calibrated = (raw - offset) * scale
"""

import cv2
import time
import math
import numpy as np
from typing import List, Tuple, Optional

# ── 校准配置 ──────────────────────────────────────────────
# 3 个水平校准点：(屏幕 x 比例, 期望 gaze_x 值)
CALIB_POINTS: List[Tuple[float, float]] = [
    (0.20, -0.50),   # 左
    (0.50,  0.00),   # 中
    (0.80,  0.50),   # 右
]
CALIB_DURATION = 2.5     # 每个点采集秒数
CALIB_WARMUP = 0.5       # 预热丢弃秒数（让眼睛先稳定）
CALIB_DOT_RADIUS = 18    # 校准圆点半径
CALIB_SCALE_CLAMP = (0.3, 5.0)  # scale 钳位范围


# ── 辅助绘制 ──────────────────────────────────────────────

def _draw_text_centered(frame: np.ndarray, text: str, cy: int,
                        scale: float = 0.8, color=(255, 255, 255),
                        thickness: int = 2):
    """居中绘制带阴影的文字"""
    h, w = frame.shape[:2]
    text_size = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX,
                                scale, thickness)[0]
    tx = (w - text_size[0]) // 2
    ty = cy + text_size[1] // 2
    # 阴影
    cv2.putText(frame, text, (tx + 2, ty + 2),
                cv2.FONT_HERSHEY_SIMPLEX, scale, (0, 0, 0), thickness + 1)
    # 正文
    cv2.putText(frame, text, (tx, ty),
                cv2.FONT_HERSHEY_SIMPLEX, scale, color, thickness)


def _draw_progress_bar(frame: np.ndarray, progress: float,
                       cy: int, bar_w: int = 300):
    """绘制水平进度条"""
    h, w = frame.shape[:2]
    x1 = (w - bar_w) // 2
    x2 = x1 + bar_w
    y1 = cy - 8
    y2 = cy + 8
    # 背景
    cv2.rectangle(frame, (x1, y1), (x2, y2), (60, 60, 60), -1)
    # 填充
    fill_x = x1 + int(bar_w * min(1.0, max(0.0, progress)))
    cv2.rectangle(frame, (x1, y1), (fill_x, y2), (0, 200, 255), -1)
    # 边框
    cv2.rectangle(frame, (x1, y1), (x2, y2), (180, 180, 180), 1)


# ── 主校准函数 ────────────────────────────────────────────

def run_calibration(tracker, gaze_est, window_name: str) -> bool:
    """
    运行 3 点水平校准流程。

    参数：
        tracker  : HandTracker（用于读摄像头帧）
        gaze_est : GazeEstimator（接收校准参数）
        window_name : OpenCV 窗口名

    返回：
        True = 校准完成, False = 用户跳过
    """
    print("\n[Calibration] 进入校准模式...")

    # ── Phase 0: 欢迎 / 等待人脸 ─────────────────────────
    face_ok = False
    while True:
        frame = tracker.read_frame()
        if frame is None:
            return False

        h, w = frame.shape[:2]

        # 检测人脸（复用 gaze_est）
        gaze_result = gaze_est.update(frame)
        face_ok = gaze_result.face_detected

        # 半透明遮罩
        overlay = frame.copy()
        cv2.rectangle(overlay, (0, 0), (w, h), (30, 30, 30), -1)
        cv2.addWeighted(overlay, 0.70, frame, 0.30, 0, frame)

        _draw_text_centered(frame, "Gaze Calibration", h // 4,
                            scale=1.2, color=(0, 200, 255))

        if face_ok:
            _draw_text_centered(frame, "Face detected! Press SPACE to start",
                                h // 2, scale=0.7, color=(100, 255, 100))
        else:
            _draw_text_centered(frame, "Looking for face...",
                                h // 2, scale=0.7, color=(100, 100, 255))

        _draw_text_centered(frame, "Press ESC or S to skip",
                            h * 3 // 4, scale=0.5, color=(150, 150, 150))

        cv2.imshow(window_name, frame)
        key = cv2.waitKey(30) & 0xFF

        if key == 27 or key == ord('s') or key == ord('S'):
            print("[Calibration] 用户跳过校准")
            gaze_est.reset()
            return False
        if key == 32 and face_ok:  # SPACE
            break

    # ── Phase 1: 逐点采集 ─────────────────────────────────
    gaze_est.reset()  # 重置平滑状态，从头采集
    medians: List[float] = []  # 每个校准点的 raw_gaze_x 中位数

    for pt_idx, (screen_ratio, expected_gaze) in enumerate(CALIB_POINTS):
        samples: List[float] = []
        start_time = time.time()
        dot_x = int(w * screen_ratio)
        dot_y = h // 2

        label = ["LEFT", "CENTER", "RIGHT"][pt_idx]
        print(f"[Calibration] 点 {pt_idx + 1}/3: {label} "
              f"(screen_x={screen_ratio:.0%}, expect={expected_gaze:+.2f})")

        while True:
            elapsed = time.time() - start_time
            if elapsed >= CALIB_DURATION:
                break

            frame = tracker.read_frame()
            if frame is None:
                return False

            gaze_result = gaze_est.update(frame)

            # 预热结束后开始采集
            if elapsed >= CALIB_WARMUP and gaze_result.face_detected:
                samples.append(gaze_result.raw_gaze_x)

            # ── 绘制校准 UI ──
            # 半透明遮罩
            overlay = frame.copy()
            cv2.rectangle(overlay, (0, 0), (w, h), (30, 30, 30), -1)
            cv2.addWeighted(overlay, 0.65, frame, 0.35, 0, frame)

            # 标题
            _draw_text_centered(frame,
                                f"Look at the dot ({pt_idx + 1}/3)",
                                50, scale=0.7, color=(200, 200, 200))

            # 脉动校准圆点
            pulse = 0.5 + 0.5 * math.sin(time.time() * 4.0)
            dot_r = CALIB_DOT_RADIUS + int(pulse * 6)
            # 外圈光晕
            cv2.circle(frame, (dot_x, dot_y), dot_r + 8,
                       (0, 100, 200), -1)
            cv2.addWeighted(frame, 0.85, frame, 0.15, 0, frame)
            # 实心圆点
            cv2.circle(frame, (dot_x, dot_y), dot_r, (0, 200, 255), -1)
            # 中心白点
            cv2.circle(frame, (dot_x, dot_y), 4, (255, 255, 255), -1)

            # 进度条
            progress = elapsed / CALIB_DURATION
            _draw_progress_bar(frame, progress, h - 60)

            # 样本数
            _draw_text_centered(frame,
                                f"Samples: {len(samples)}",
                                h - 30, scale=0.4, color=(150, 150, 150))

            cv2.imshow(window_name, frame)
            key = cv2.waitKey(1) & 0xFF
            if key == 27:  # ESC 中途退出
                print("[Calibration] 用户中途取消")
                gaze_est.reset()
                return False

        # 计算本点中位数
        if len(samples) < 3:
            print(f"[Calibration] 点 {pt_idx + 1} 样本不足 ({len(samples)})，跳过校准")
            gaze_est.reset()
            return False

        median_val = float(np.median(samples))
        medians.append(median_val)
        print(f"  → median={median_val:.3f} (samples={len(samples)})")

    # ── Phase 2: 计算校准参数 ─────────────────────────────
    # medians[0]=左, medians[1]=中, medians[2]=右
    # offset = 中心点偏移
    offset = medians[1]  # 看正中时的 raw 值应为 0

    # scale = 期望范围 / 实测范围
    measured_range = medians[2] - medians[0]  # 实测 右-左
    expected_range = CALIB_POINTS[2][1] - CALIB_POINTS[0][1]  # 0.5 - (-0.5) = 1.0

    if abs(measured_range) < 0.01:
        print("[Calibration] 实测范围太小，校准失败")
        gaze_est.reset()
        return False

    scale = expected_range / measured_range
    scale = max(CALIB_SCALE_CLAMP[0], min(CALIB_SCALE_CLAMP[1], scale))

    print(f"[Calibration] 结果: offset={offset:.3f}, scale={scale:.2f}")
    print(f"  raw medians: L={medians[0]:.3f}, C={medians[1]:.3f}, R={medians[2]:.3f}")

    # 应用校准
    gaze_est.set_calibration(offset, scale)

    # ── Phase 3: 完成提示 ─────────────────────────────────
    done_start = time.time()
    while time.time() - done_start < 1.5:
        frame = tracker.read_frame()
        if frame is None:
            break
        h, w = frame.shape[:2]

        overlay = frame.copy()
        cv2.rectangle(overlay, (0, 0), (w, h), (30, 30, 30), -1)
        cv2.addWeighted(overlay, 0.70, frame, 0.30, 0, frame)

        _draw_text_centered(frame, "Calibration Complete!",
                            h // 2 - 20, scale=1.0, color=(100, 255, 100))
        _draw_text_centered(frame,
                            f"offset={offset:.3f}  scale={scale:.2f}",
                            h // 2 + 30, scale=0.5, color=(180, 180, 180))

        cv2.imshow(window_name, frame)
        cv2.waitKey(30)

    print("[Calibration] 校准完成，进入主界面\n")
    return True
