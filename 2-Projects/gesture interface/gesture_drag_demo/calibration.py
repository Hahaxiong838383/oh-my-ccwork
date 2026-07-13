"""
calibration.py - 眼动追踪 2D 校准模块（9 点 3×3 网格）

启动时引导用户注视屏幕上 9 个校准点（3×3 网格），
采集原始注视数据并用最小二乘回归计算仿射校准参数，
写入 GazeEstimator 以提高后续注视估计精度。

校准模型（仿射）：
  calibrated = a * raw + b
  其中 (a, b) 由 np.polyfit 从 9 个采集点回归得到。
"""

import cv2
import time
import math
import numpy as np
from typing import List, Tuple, Optional

# ── 校准配置 ──────────────────────────────────────────────
# 9 个校准点：(screen_x_ratio, screen_y_ratio, expected_gaze_x, expected_gaze_y)
CALIB_POINTS_2D: List[Tuple[float, float, float, float]] = [
    # 第一行（上）
    (0.20, 0.25, -0.50, -0.50),  # 左上
    (0.50, 0.25,  0.00, -0.50),  # 中上
    (0.80, 0.25,  0.50, -0.50),  # 右上
    # 第二行（中）
    (0.20, 0.50, -0.50,  0.00),  # 左中
    (0.50, 0.50,  0.00,  0.00),  # 中中
    (0.80, 0.50,  0.50,  0.00),  # 右中
    # 第三行（下）
    (0.20, 0.75, -0.50,  0.50),  # 左下
    (0.50, 0.75,  0.00,  0.50),  # 中下
    (0.80, 0.75,  0.50,  0.50),  # 右下
]
CALIB_DURATION = 2.0       # 每个点采集秒数（9 点，缩短每点时长）
CALIB_WARMUP = 0.4         # 预热丢弃秒数
CALIB_DOT_RADIUS = 18      # 校准圆点半径
CALIB_SCALE_CLAMP = (0.3, 5.0)  # scale 钳位范围
CALIB_MIN_SAMPLES = 3      # 每个点最少有效样本数


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


def _draw_dot_grid(frame: np.ndarray, current_idx: int,
                   w: int, h: int, alpha: float = 0.25):
    """绘制所有 9 个点的淡影位置（让用户知道完整布局）"""
    for i, (sx, sy, _, _) in enumerate(CALIB_POINTS_2D):
        if i == current_idx:
            continue  # 当前点单独绘制
        dx = int(w * sx)
        dy = int(h * sy)
        cv2.circle(frame, (dx, dy), 6, (80, 80, 80), -1)


# ── 主校准函数 ────────────────────────────────────────────

def run_calibration(tracker, gaze_est, window_name: str) -> bool:
    """
    运行 9 点 2D 校准流程。

    参数：
        tracker  : HandTracker（用于读摄像头帧）
        gaze_est : GazeEstimator（接收校准参数）
        window_name : OpenCV 窗口名

    返回：
        True = 校准完成, False = 用户跳过
    """
    print("\n[Calibration] 进入 9 点 2D 校准模式...")

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

        _draw_text_centered(frame, "Gaze Calibration (9-Point)", h // 4,
                            scale=1.2, color=(0, 200, 255))

        if face_ok:
            _draw_text_centered(frame, "Face detected! Press SPACE to start",
                                h // 2, scale=0.7, color=(100, 255, 100))
        else:
            _draw_text_centered(frame, "Looking for face...",
                                h // 2, scale=0.7, color=(100, 100, 255))

        _draw_text_centered(frame, "Press ESC or S to skip",
                            h * 3 // 4, scale=0.5, color=(150, 150, 150))

        # 显示 9 点网格预览
        _draw_dot_grid(frame, -1, w, h)

        cv2.imshow(window_name, frame)
        key = cv2.waitKey(30) & 0xFF

        if key == 27 or key == ord('s') or key == ord('S'):
            print("[Calibration] 用户跳过校准")
            return False
        if key == 32 and face_ok:  # SPACE
            break

    # ── Phase 1: 逐点采集 ─────────────────────────────────
    gaze_est.clear_calibration()  # 清除旧校准，确保采集的是原始值

    # 每个点的采集结果：(median_gaze_x, median_gaze_y)
    medians_x: List[float] = []
    medians_y: List[float] = []

    total_points = len(CALIB_POINTS_2D)

    # 方向标签
    _LABELS = [
        "TOP-LEFT", "TOP-CENTER", "TOP-RIGHT",
        "MID-LEFT", "MID-CENTER", "MID-RIGHT",
        "BOT-LEFT", "BOT-CENTER", "BOT-RIGHT",
    ]

    for pt_idx, (screen_rx, screen_ry, exp_gx, exp_gy) in enumerate(CALIB_POINTS_2D):
        samples_x: List[float] = []
        samples_y: List[float] = []
        start_time = time.time()
        dot_x = int(w * screen_rx)
        dot_y = int(h * screen_ry)

        label = _LABELS[pt_idx]
        print(f"[Calibration] 点 {pt_idx + 1}/{total_points}: {label} "
              f"(screen=({screen_rx:.0%},{screen_ry:.0%}), "
              f"expect=({exp_gx:+.2f},{exp_gy:+.2f}))")

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
                samples_x.append(gaze_result.raw_gaze_x)
                samples_y.append(gaze_result.raw_gaze_y)

            # ── 绘制校准 UI ──
            # 半透明遮罩
            overlay = frame.copy()
            cv2.rectangle(overlay, (0, 0), (w, h), (30, 30, 30), -1)
            cv2.addWeighted(overlay, 0.65, frame, 0.35, 0, frame)

            # 标题
            _draw_text_centered(frame,
                                f"Look at the dot ({pt_idx + 1}/{total_points})",
                                40, scale=0.7, color=(200, 200, 200))

            # 绘制所有点的淡影
            _draw_dot_grid(frame, pt_idx, w, h)

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
                                f"Samples: {len(samples_x)}",
                                h - 30, scale=0.4, color=(150, 150, 150))

            cv2.imshow(window_name, frame)
            key = cv2.waitKey(1) & 0xFF
            if key == 27:  # ESC 中途退出
                print("[Calibration] 用户中途取消")
                return False

        # 计算本点中位数
        if len(samples_x) < CALIB_MIN_SAMPLES:
            print(f"[Calibration] 点 {pt_idx + 1} 样本不足 "
                  f"({len(samples_x)})，跳过校准")
            return False

        median_x = float(np.median(samples_x))
        median_y = float(np.median(samples_y))
        medians_x.append(median_x)
        medians_y.append(median_y)
        print(f"  → median=({median_x:.3f}, {median_y:.3f}) "
              f"(samples={len(samples_x)})")

    # ── Phase 2: 最小二乘回归计算校准参数 ─────────────────
    # 2026-07 路线A：首选含 xy 交叉项的二阶多项式（联合输入，
    # 拟合边缘/垂直非线性与轴间耦合——学界实证眼动非线性集中在
    # 屏幕顶部行与左右边缘）；拟合退化时自动回退仿射。
    expected_x = np.array([pt[2] for pt in CALIB_POINTS_2D])  # [-0.5, 0, 0.5, ...]
    expected_y = np.array([pt[3] for pt in CALIB_POINTS_2D])  # [-0.5, ..., 0.5]
    measured_x = np.array(medians_x)
    measured_y = np.array(medians_y)

    def _affine_as_poly():
        """仿射兜底：拟合 per-axis y=ax+b，嵌进 6 维多项式系数格式。"""
        a_x, b_x = np.polyfit(measured_x, expected_x, 1)
        a_y, b_y = np.polyfit(measured_y, expected_y, 1)
        a_x = float(max(CALIB_SCALE_CLAMP[0], min(CALIB_SCALE_CLAMP[1], a_x)))
        a_y = float(max(CALIB_SCALE_CLAMP[0], min(CALIB_SCALE_CLAMP[1], a_y)))
        # coef 序：[1, x, y, x², xy, y²]
        cx = np.array([b_x, a_x, 0.0, 0.0, 0.0, 0.0])
        cy = np.array([b_y, 0.0, a_y, 0.0, 0.0, 0.0])
        return cx, cy

    def _mae(coef_x, coef_y):
        feats = np.stack([
            gaze_est.poly_features(mx, my)
            for mx, my in zip(measured_x, measured_y)
        ])
        ex = float(np.mean(np.abs(feats @ coef_x - expected_x)))
        ey = float(np.mean(np.abs(feats @ coef_y - expected_y)))
        return ex, ey

    try:
        affine_cx, affine_cy = _affine_as_poly()
    except (np.linalg.LinAlgError, ValueError):
        print("[Calibration] 仿射回归失败")
        return False

    model = "affine"
    coef_x, coef_y = affine_cx, affine_cy
    try:
        # 二阶多项式：9 个方程拟 6 系数，轻微 ridge 防病态
        feats = np.stack([
            gaze_est.poly_features(mx, my)
            for mx, my in zip(measured_x, measured_y)
        ])
        ridge = 1e-4 * np.eye(feats.shape[1])
        gram = feats.T @ feats + ridge
        poly_cx = np.linalg.solve(gram, feats.T @ expected_x)
        poly_cy = np.linalg.solve(gram, feats.T @ expected_y)
        # 择优：多项式拟合残差需真正优于仿射才启用（防过拟合退化）
        pmx, pmy = _mae(poly_cx, poly_cy)
        amx, amy = _mae(affine_cx, affine_cy)
        if pmx + pmy < amx + amy:
            model = "poly2"
            coef_x, coef_y = poly_cx, poly_cy
    except np.linalg.LinAlgError:
        pass  # 多项式病态 → 保持仿射兜底

    mae_x, mae_y = _mae(coef_x, coef_y)
    print(f"[Calibration] 2D 回归结果 (model={model}):")
    print(f"  MAE: X={mae_x:.3f}, Y={mae_y:.3f}")

    # 应用校准
    gaze_est.set_calibration(coef_x, coef_y)

    # ── Phase 3: 验证阶段（实时注视光标，5 秒） ─────────────
    VERIFY_DURATION = 5.0
    verify_start = time.time()
    print("[Calibration] 进入验证阶段（5 秒）...")

    while True:
        elapsed = time.time() - verify_start
        if elapsed >= VERIFY_DURATION:
            break

        frame = tracker.read_frame()
        if frame is None:
            break
        h, w = frame.shape[:2]

        # 获取校准后的注视值
        gaze_result = gaze_est.update(frame)

        # 半透明遮罩
        overlay = frame.copy()
        cv2.rectangle(overlay, (0, 0), (w, h), (30, 30, 30), -1)
        cv2.addWeighted(overlay, 0.60, frame, 0.40, 0, frame)

        # 标题
        remaining = max(0.0, VERIFY_DURATION - elapsed)
        _draw_text_centered(frame, "Verify - look around!",
                            35, scale=0.7, color=(100, 255, 100))
        _draw_text_centered(frame,
                            f"model={model}  MAE: {mae_x:.2f}/{mae_y:.2f}",
                            65, scale=0.4, color=(160, 160, 160))
        _draw_text_centered(frame, f"{remaining:.1f}s",
                            h - 25, scale=0.5, color=(150, 150, 150))

        # 绘制 9 个参考点（淡灰色）
        for (sx, sy, _, _) in CALIB_POINTS_2D:
            dx = int(w * sx)
            dy = int(h * sy)
            cv2.circle(frame, (dx, dy), 8, (80, 80, 80), -1)
            cv2.circle(frame, (dx, dy), 8, (120, 120, 120), 1)

        # 绘制注视光标（绿色十字）
        if gaze_result.face_detected:
            # gaze → 屏幕坐标映射
            cursor_x = int(w * (0.50 + gaze_result.gaze_x * 0.60))
            cursor_y = int(h * (0.50 + gaze_result.gaze_y * 0.50))
            cursor_x = max(0, min(w - 1, cursor_x))
            cursor_y = max(0, min(h - 1, cursor_y))

            # 十字线
            cross_len = 20
            cv2.line(frame, (cursor_x - cross_len, cursor_y),
                     (cursor_x + cross_len, cursor_y), (0, 255, 0), 2)
            cv2.line(frame, (cursor_x, cursor_y - cross_len),
                     (cursor_x, cursor_y + cross_len), (0, 255, 0), 2)
            # 中心圆
            cv2.circle(frame, (cursor_x, cursor_y), 6, (0, 255, 0), -1)

            # 注视数值
            _draw_text_centered(frame,
                                f"Gaze: ({gaze_result.gaze_x:+.2f}, {gaze_result.gaze_y:+.2f})",
                                h - 55, scale=0.45, color=(0, 200, 200))

        cv2.imshow(window_name, frame)
        key = cv2.waitKey(1) & 0xFF
        if key == 27 or key == 32:  # ESC 或 SPACE 跳过验证
            break

    print("[Calibration] 9 点校准完成，进入主界面\n")
    return True
