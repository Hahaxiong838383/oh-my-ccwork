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

from implicit_calib import fit_poly_with_affine_fallback

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
CALIB_DOT_RADIUS = 18      # 校准圆点半径
CALIB_SCALE_CLAMP = (0.3, 5.0)  # scale 钳位范围
CALIB_MIN_SAMPLES = 5      # 降级通过时每个点最少合格样本数

# ── 质量门控（2026-07 v3.3：时间驱动 → 质量驱动闭环）──
# 只有"盯稳了"的帧才计入合格样本：滑窗 std 低于阈值 = 真实注视
# （扫视/走神/眨眼时 std 天然飙高，物理上装不出来）
CALIB_STABILITY_WINDOW = 15   # 稳定性判定滑窗（帧）
CALIB_STD_THRESHOLD = 0.05    # 滑窗 std 阈值（raw gaze 单位，per-axis）
CALIB_TARGET_SAMPLES = 30     # 每点合格样本目标（转满一圈）
CALIB_STAGE_TIMEOUT = 6.0     # 单阶段超时（秒）→ 放宽阈值重试
CALIB_RELAX_FACTOR = 1.25     # 每次超时放宽阈值的倍数
CALIB_MAX_RELAX = 2           # 最多放宽次数；之后降级通过（防转圈卡死）


class FixationGate:
    """单点注视质量门控状态机（纯逻辑，无 UI/摄像头依赖，可单测）。

    feed() 每帧喂 raw gaze，内部维护：
    - 稳定性滑窗：最近 N 帧 std 低于阈值才算"盯稳"
    - 合格样本池：仅稳定帧计入，攒满 target → complete
    - 超时降级：每 CALIB_STAGE_TIMEOUT 秒没攒满 → 放宽阈值重试，
      放宽 CALIB_MAX_RELAX 次后 exhausted=True（调用方降级通过）
    """

    def __init__(self,
                 window: int = CALIB_STABILITY_WINDOW,
                 std_threshold: float = CALIB_STD_THRESHOLD,
                 target: int = CALIB_TARGET_SAMPLES,
                 stage_timeout: float = CALIB_STAGE_TIMEOUT,
                 relax_factor: float = CALIB_RELAX_FACTOR,
                 max_relax: int = CALIB_MAX_RELAX):
        from collections import deque
        self._recent = deque(maxlen=window)
        self._window = window
        self.std_threshold = std_threshold
        self._target = target
        self._stage_timeout = stage_timeout
        self._relax_factor = relax_factor
        self._max_relax = max_relax
        self.qualified: List[Tuple[float, float]] = []
        self.all_samples: List[Tuple[float, float]] = []
        self.relax_count = 0
        self.is_stable = False
        self._stage_start: Optional[float] = None

    @property
    def progress(self) -> float:
        return min(1.0, len(self.qualified) / self._target)

    @property
    def complete(self) -> bool:
        return len(self.qualified) >= self._target

    @property
    def exhausted(self) -> bool:
        """放宽次数用尽且仍未攒满 → 调用方应降级通过"""
        return (self.relax_count >= self._max_relax
                and self._stage_start is not None
                and not self.complete)

    def interrupt(self):
        """人脸丢失等中断：清稳定性滑窗（合格样本保留）"""
        self._recent.clear()
        self.is_stable = False

    def feed(self, x: float, y: float, now_s: float):
        """喂一帧 raw gaze。返回当前是否稳定。"""
        if self._stage_start is None:
            self._stage_start = now_s
        self._recent.append((x, y))
        self.all_samples.append((x, y))

        self.is_stable = False
        if len(self._recent) == self._window:
            xs = np.array([p[0] for p in self._recent])
            ys = np.array([p[1] for p in self._recent])
            if (float(np.std(xs)) < self.std_threshold
                    and float(np.std(ys)) < self.std_threshold):
                self.is_stable = True
                self.qualified.append((x, y))

        # 阶段超时 → 放宽阈值（防"永远转不满"）
        if (not self.complete
                and self.relax_count < self._max_relax
                and now_s - self._stage_start > self._stage_timeout):
            self.relax_count += 1
            self.std_threshold *= self._relax_factor
            self._stage_start = now_s
            print(f"[Calibration] 阶段超时，放宽稳定阈值至 "
                  f"{self.std_threshold:.3f}（第 {self.relax_count} 次）")
        return self.is_stable

    def result(self) -> Optional[Tuple[float, float]]:
        """最终点位值：合格样本中位数；降级时用全量样本中位数兜底。"""
        pool = self.qualified if len(self.qualified) >= CALIB_MIN_SAMPLES \
            else self.all_samples
        if len(pool) < CALIB_MIN_SAMPLES:
            return None
        xs = [p[0] for p in pool]
        ys = [p[1] for p in pool]
        return float(np.median(xs)), float(np.median(ys))


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
        校准完成 → anchors dict（measured/expected/coef_x/coef_y，
        供路线C 隐式校准器做锚点）；跳过或失败 → None
    """
    print("\n[Calibration] 进入 9 点 2D 校准模式...")

    # ── Phase 0: 欢迎 / 等待人脸 ─────────────────────────
    face_ok = False
    while True:
        frame = tracker.read_frame()
        if frame is None:
            return None

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
            return None
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
        gate = FixationGate()
        start_time = time.time()
        done_flash_until = None   # 完成后绿圈定格时刻
        degraded = False
        dot_x = int(w * screen_rx)
        dot_y = int(h * screen_ry)

        label = _LABELS[pt_idx]
        print(f"[Calibration] 点 {pt_idx + 1}/{total_points}: {label} "
              f"(screen=({screen_rx:.0%},{screen_ry:.0%}), "
              f"expect=({exp_gx:+.2f},{exp_gy:+.2f}))")

        while True:
            now = time.time()
            frame = tracker.read_frame()
            if frame is None:
                return None

            gaze_result = gaze_est.update(frame)

            # ── 质量门控：只有盯稳的帧才算数 ──
            if done_flash_until is None:
                if gaze_result.face_detected:
                    gate.feed(gaze_result.raw_gaze_x,
                              gaze_result.raw_gaze_y, now)
                else:
                    gate.interrupt()

                if gate.complete:
                    done_flash_until = now + 0.45
                    print(f"  → 合格样本 {len(gate.qualified)}，"
                          f"用时 {now - start_time:.1f}s"
                          + (f"（放宽 {gate.relax_count} 次）"
                             if gate.relax_count else ""))
                elif gate.exhausted:
                    degraded = True
                    done_flash_until = now + 0.45
                    print(f"  ⚠️ 降级通过：合格 {len(gate.qualified)}/"
                          f"{CALIB_TARGET_SAMPLES}，用全量样本兜底")

            if done_flash_until is not None and now >= done_flash_until:
                break

            # ── 绘制校准 UI ──
            overlay = frame.copy()
            cv2.rectangle(overlay, (0, 0), (w, h), (30, 30, 30), -1)
            cv2.addWeighted(overlay, 0.65, frame, 0.35, 0, frame)

            _draw_text_centered(frame,
                                f"Look at the dot ({pt_idx + 1}/{total_points})",
                                40, scale=0.7, color=(200, 200, 200))
            _draw_dot_grid(frame, pt_idx, w, h)

            # 脉动校准圆点
            pulse = 0.5 + 0.5 * math.sin(time.time() * 4.0)
            dot_r = CALIB_DOT_RADIUS + int(pulse * 6)
            cv2.circle(frame, (dot_x, dot_y), dot_r + 8, (0, 100, 200), -1)
            cv2.addWeighted(frame, 0.85, frame, 0.15, 0, frame)
            done = done_flash_until is not None
            dot_color = (80, 220, 80) if done else (0, 200, 255)
            cv2.circle(frame, (dot_x, dot_y), dot_r, dot_color, -1)
            cv2.circle(frame, (dot_x, dot_y), 4, (255, 255, 255), -1)

            # ── 质量进度环（v3.3 核心闭环反馈）──
            ring_r = CALIB_DOT_RADIUS + 20
            # 底环（暗灰）
            cv2.circle(frame, (dot_x, dot_y), ring_r, (70, 70, 70), 3)
            # 进度弧：完成=绿 / 盯稳采集中=亮青 / 未稳=灰
            if done:
                arc_color = (80, 220, 80)
            elif gate.is_stable:
                arc_color = (0, 220, 255)
            else:
                arc_color = (120, 120, 120)
            arc_end = int(360 * (1.0 if done else gate.progress))
            if arc_end > 0:
                cv2.ellipse(frame, (dot_x, dot_y), (ring_r, ring_r),
                            -90, 0, arc_end, arc_color, 4)

            # 状态提示
            if done:
                status, s_color = ("DEGRADED - moving on" if degraded
                                   else "OK!"), (80, 220, 80)
            elif gate.is_stable:
                status, s_color = "Collecting... hold your gaze", (0, 220, 255)
            else:
                status, s_color = "Fixate on the dot & hold still", (170, 170, 170)
            _draw_text_centered(frame, status, h - 60, scale=0.55, color=s_color)
            _draw_text_centered(frame,
                                f"Quality samples: {len(gate.qualified)}"
                                f"/{CALIB_TARGET_SAMPLES}",
                                h - 30, scale=0.4, color=(150, 150, 150))

            cv2.imshow(window_name, frame)
            key = cv2.waitKey(1) & 0xFF
            if key == 27:  # ESC 中途退出
                print("[Calibration] 用户中途取消")
                return None

        # 计算本点值（合格样本中位数；降级时全量兜底）
        med = gate.result()
        if med is None:
            print(f"[Calibration] 点 {pt_idx + 1} 样本不足，校准失败")
            return None
        medians_x.append(med[0])
        medians_y.append(med[1])
        print(f"  → median=({med[0]:.3f}, {med[1]:.3f})")

    # ── Phase 2: 最小二乘回归计算校准参数 ─────────────────
    # 2026-07 路线A：含 xy 交叉项的二阶多项式 + 仿射兜底择优
    # （拟合器与路线C 隐式校准共用，见 implicit_calib.py）
    expected_x = np.array([pt[2] for pt in CALIB_POINTS_2D])  # [-0.5, 0, 0.5, ...]
    expected_y = np.array([pt[3] for pt in CALIB_POINTS_2D])  # [-0.5, ..., 0.5]
    measured = list(zip(medians_x, medians_y))

    try:
        coef_x, coef_y, model, (mae_x, mae_y) = fit_poly_with_affine_fallback(
            measured, expected_x, expected_y)
    except (np.linalg.LinAlgError, ValueError):
        print("[Calibration] 回归失败")
        return None

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
    return {
        "measured": measured,
        "expected": [(pt[2], pt[3]) for pt in CALIB_POINTS_2D],
        "coef_x": coef_x,
        "coef_y": coef_y,
    }
