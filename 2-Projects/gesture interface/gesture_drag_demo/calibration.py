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

from implicit_calib import fit_poly_with_affine_fallback, poly_features
from config import VERSION

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

# ── 到位门（2026-08 v3.6：修「没看点也能完成标定」）──
# std 门控只测「稳」不测「在看点」：稳定看错地方 std 一样低。
# 到位门要求视线相对上一点参照位发生「方向一致的显著迁移」才开始计样本；
# 迁移检测基于滑窗中心位置（不是运动），用户提前看过去也能判对。
CALIB_ARRIVAL_MIN_SHIFT = 0.04   # 滑窗中心相对参照的最小位移（raw 单位）
CALIB_ARRIVAL_TIMEOUT = 6.0      # 超此秒数未到位 → UI 强提示
CALIB_ARRIVAL_GIVEUP = 12.0      # 超此秒数仍未到位 → 放弃该点（剔除不兜底）
CALIB_MIN_POINTS = 5             # 拟合最少有效点数（不足 → 校准失败）
CALIB_POLY_MIN_POINTS = 7        # 启用 poly2 的最少点数（防 6 参数过拟合）
CALIB_RESIDUAL_OUTLIER = 0.25    # 拟合后单点残差超此值 → 剔除重拟合一轮
CALIB_MAE_WARN = 0.15            # 最终 MAE 超此值 → 校准质量差警告


class FixationGate:
    """单点注视质量门控状态机（纯逻辑，无 UI/摄像头依赖，可单测）。

    feed() 每帧喂 raw gaze，内部维护：
    - 到位门（v3.6，ref_point 非 None 时启用）：滑窗中心相对参照位置的
      位移 ≥ arrival_min_shift 且与 expected_dir 同向（cos>0）才算"在看点"。
      std 门控只测「稳」，测不出「稳定地看错地方」——到位门补上这一维。
      判据基于位置而非运动：用户在上一点绿圈期间提前扫过去也判对。
    - 稳定性滑窗：最近 N 帧 std 低于阈值才算"盯稳"
    - 合格样本池：仅"到位 + 盯稳"的帧计入，攒满 target → complete
    - 到位超时：arrival_giveup 秒仍未到位 → given_up=True（调用方剔除
      该点，绝不拿没看点的数据兜底）
    - 稳定超时（到位后起算）：每 CALIB_STAGE_TIMEOUT 秒没攒满 → 放宽
      阈值重试，放宽 CALIB_MAX_RELAX 次后 exhausted=True（调用方降级）
    """

    def __init__(self,
                 window: int = CALIB_STABILITY_WINDOW,
                 std_threshold: float = CALIB_STD_THRESHOLD,
                 target: int = CALIB_TARGET_SAMPLES,
                 stage_timeout: float = CALIB_STAGE_TIMEOUT,
                 relax_factor: float = CALIB_RELAX_FACTOR,
                 max_relax: int = CALIB_MAX_RELAX,
                 ref_point: Optional[Tuple[float, float]] = None,
                 expected_dir: Optional[Tuple[float, float]] = None,
                 arrival_min_shift: float = CALIB_ARRIVAL_MIN_SHIFT,
                 arrival_timeout: float = CALIB_ARRIVAL_TIMEOUT,
                 arrival_giveup: float = CALIB_ARRIVAL_GIVEUP):
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
        # ── 到位门状态 ──
        self._ref = ref_point                  # 参照位置（raw 空间）；None=不启用
        self._expected_dir = expected_dir      # 期望位移方向；None=只查幅度
        self._arrival_min_shift = arrival_min_shift
        self._arrival_timeout = arrival_timeout
        self._arrival_giveup = arrival_giveup
        self.arrived = ref_point is None       # 无参照 = 视为已到位（旧行为）
        self.arrival_overdue = False           # 超 timeout 未到位（UI 强提示用）
        self.given_up = False                  # 超 giveup 未到位（调用方剔除该点）
        self._t0: Optional[float] = None       # 本点首帧时刻（到位计时基准）
        # ── 诊断快照（v3.7：远程排障全靠它，别删）──
        self._last_disp: Optional[Tuple[float, float]] = None   # 最近位移向量
        self._last_std: Optional[Tuple[float, float]] = None    # 最近滑窗 std
        self._mag_ok_frames = 0                # 位移幅度达标的累计帧数

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

    def _displacement_ok(self) -> bool:
        """到位判据：滑窗中心相对参照的位移幅度 + 方向（滑窗满时调用）。"""
        if self._ref is None:
            return True
        cx = float(np.mean([p[0] for p in self._recent]))
        cy = float(np.mean([p[1] for p in self._recent]))
        vx, vy = cx - self._ref[0], cy - self._ref[1]
        self._last_disp = (vx, vy)
        if math.hypot(vx, vy) < self._arrival_min_shift:
            return False
        self._mag_ok_frames += 1
        if self._expected_dir is not None:
            dx, dy = self._expected_dir
            if vx * dx + vy * dy <= 0:  # 与期望方向不同向（cos ≤ 0）
                return False
        return True

    def feed(self, x: float, y: float, now_s: float):
        """喂一帧 raw gaze。返回当前是否稳定。"""
        if self._t0 is None:
            self._t0 = now_s
        if self._stage_start is None:
            self._stage_start = now_s
        self._recent.append((x, y))

        self.is_stable = False
        window_full = len(self._recent) == self._window
        displacement_ok = window_full and self._displacement_ok()
        # v3.7 解耦：到位只看位置（滑窗中心均值天然抗噪），不再要求 std 稳。
        # v3.6 曾把两者耦合——高噪声点位（如中上：虹膜贴上睑+IRIS_SCALE_Y
        # 放大后在钳位边界削顶）std 永不达标，arrived 锁不上，而放宽机制
        # 只在到位后生效 → 死锁 12s 被剔除（模拟三 seed 复现，v3.5 同流能过）
        if displacement_ok and not self.arrived:
            self.arrived = True
            self._stage_start = now_s  # 稳定超时（放宽计时）从到位起算
        if window_full:
            xs = np.array([p[0] for p in self._recent])
            ys = np.array([p[1] for p in self._recent])
            std_x, std_y = float(np.std(xs)), float(np.std(ys))
            self._last_std = (std_x, std_y)
            std_ok = (std_x < self.std_threshold
                      and std_y < self.std_threshold)
            if std_ok and displacement_ok:
                self.is_stable = True
                self.qualified.append((x, y))

        # 降级兜底样本池：到位门启用时只收「位移判据通过」的帧，
        # 保证兜底中位数至少是看着点方向的数据（旧行为：无门时全收）
        if self._ref is None or displacement_ok:
            self.all_samples.append((x, y))

        # ── 到位超时（未到位期间不走稳定放宽——放宽救不了没看点的人）──
        if not self.arrived:
            elapsed = now_s - self._t0
            self.arrival_overdue = elapsed > self._arrival_timeout
            # v3.7 方向自愈：位移幅度持续显著、只是方向与期望不符 →
            # 用户在看某个明确的新位置（大概率就是点位，只是该用户的
            # raw 几何与期望方向不一致），弃方向只留幅度。真不看的人
            # 位移幅度不显著，_mag_ok_frames 涨不起来，拦截力不损失。
            if (self.arrival_overdue and self._expected_dir is not None
                    and self._mag_ok_frames >= self._window):
                print("[Calibration] 位移显著但方向持续不符——弃方向判据自愈")
                self._expected_dir = None
            if elapsed > self._arrival_giveup:
                self.given_up = True
            return self.is_stable

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

    def diag(self) -> str:
        """判据快照一行（v3.7：每点结束落盘，远程排障的眼睛）。"""
        disp = (f"({self._last_disp[0]:+.3f},{self._last_disp[1]:+.3f})"
                if self._last_disp else "n/a")
        std = (f"({self._last_std[0]:.3f},{self._last_std[1]:.3f})"
               if self._last_std else "n/a")
        exp = (f"({self._expected_dir[0]:+.2f},{self._expected_dir[1]:+.2f})"
               if self._expected_dir else "None")
        return (f"arrived={self.arrived} disp={disp} exp_dir={exp} "
                f"std={std} thr={self.std_threshold:.3f} "
                f"mag_ok={self._mag_ok_frames} q={len(self.qualified)} "
                f"pool={len(self.all_samples)} relax={self.relax_count}")

    def result(self) -> Optional[Tuple[float, float]]:
        """最终点位值：合格样本中位数；降级时用全量样本中位数兜底。

        到位门启用时 all_samples 只含位移判据通过的帧，兜底不吃
        「没看点」的数据；从未到位 → 两池皆空 → None（调用方剔除该点）。
        """
        pool = self.qualified if len(self.qualified) >= CALIB_MIN_SAMPLES \
            else self.all_samples
        if len(pool) < CALIB_MIN_SAMPLES:
            return None
        xs = [p[0] for p in pool]
        ys = [p[1] for p in pool]
        return float(np.median(xs)), float(np.median(ys))


# ── 拟合与质量评估（v3.6：纯函数，可单测）─────────────────

def fit_calib_points(
    point_medians: List[Optional[Tuple[float, float]]],
    calib_points: Optional[List[Tuple[float, float, float, float]]] = None,
) -> Optional[dict]:
    """校准点位中值（None=该点被剔除）→ 校准系数 + 质量评估。

    - 有效点 < CALIB_MIN_POINTS → None（校准失败，调用方要求重做）
    - 有效点 < CALIB_POLY_MIN_POINTS → 禁用 poly2（6 参数过拟合，
      训练 MAE 趋 0 会骗过择优）
    - 拟合后最差单点残差 > CALIB_RESIDUAL_OUTLIER → 剔除重拟合一轮
      （抓「某个点走神被污染」——到位门之外的最后防线）
    - MAE 超 CALIB_MAE_WARN → quality_ok=False（UI 警告建议重做）
    """
    if calib_points is None:
        calib_points = CALIB_POINTS_2D

    kept_idx = [i for i, m in enumerate(point_medians) if m is not None]
    if len(kept_idx) < CALIB_MIN_POINTS:
        return None

    dropped_idx = [i for i in range(len(point_medians)) if i not in kept_idx]

    def _fit(indices):
        measured = [point_medians[i] for i in indices]
        exp_x = np.array([calib_points[i][2] for i in indices])
        exp_y = np.array([calib_points[i][3] for i in indices])
        allow_poly = len(indices) >= CALIB_POLY_MIN_POINTS
        coef_x, coef_y, model, mae = fit_poly_with_affine_fallback(
            measured, exp_x, exp_y, allow_poly=allow_poly)
        feats = np.stack([poly_features(mx, my) for mx, my in measured])
        residuals = np.hypot(feats @ coef_x - exp_x, feats @ coef_y - exp_y)
        return measured, exp_x, exp_y, coef_x, coef_y, model, mae, residuals

    measured, exp_x, exp_y, coef_x, coef_y, model, mae, residuals = _fit(kept_idx)

    # 残差离群剔除（一轮，leave-one-out）。不能用训练残差：污染点与
    # 某好点在 measured 空间相邻时（走神看向别的校准点位——现实主形态），
    # 两个矛盾标签让拟合折中，残差被"传染"给无辜邻居，argmax 指错人。
    # LOO 下污染点由"其余好点的一致模型"评判，误差必然巨大且指向真凶。
    if len(kept_idx) - 1 >= CALIB_MIN_POINTS:
        loo_errors = []
        for i in kept_idx:
            others = [j for j in kept_idx if j != i]
            _, _, _, cx_i, cy_i, _, _, _ = _fit(others)
            f = poly_features(*point_medians[i])
            loo_errors.append(math.hypot(
                float(cx_i @ f) - calib_points[i][2],
                float(cy_i @ f) - calib_points[i][3]))
        worst_pos = int(np.argmax(loo_errors))
        if loo_errors[worst_pos] > CALIB_RESIDUAL_OUTLIER:
            outlier = kept_idx[worst_pos]
            print(f"[Calibration] 点 {outlier + 1} LOO 残差离群 "
                  f"({loo_errors[worst_pos]:.3f} > {CALIB_RESIDUAL_OUTLIER})，"
                  f"剔除重拟合")
            kept_idx = [i for i in kept_idx if i != outlier]
            dropped_idx.append(outlier)
            measured, exp_x, exp_y, coef_x, coef_y, model, mae, residuals = \
                _fit(kept_idx)

    mae_x, mae_y = mae
    quality_ok = max(mae_x, mae_y) <= CALIB_MAE_WARN
    return {
        "coef_x": coef_x,
        "coef_y": coef_y,
        "model": model,
        "mae_x": mae_x,
        "mae_y": mae_y,
        "kept_idx": kept_idx,
        "dropped_idx": sorted(dropped_idx),
        "quality_ok": quality_ok,
        "measured": measured,
        "expected": [(calib_points[i][2], calib_points[i][3]) for i in kept_idx],
    }


# ── 诊断日志（v3.7）──────────────────────────────────────
import os

_DIAG_LOG = os.path.expanduser("~/Library/Logs/GestureDemo-calib.log")


def _append_diag(line: str):
    """诊断行落盘（.app 双击启动时 stdout 不可见，文件是唯一取证出口）。"""
    try:
        os.makedirs(os.path.dirname(_DIAG_LOG), exist_ok=True)
        with open(_DIAG_LOG, "a") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {line}\n")
    except OSError:
        pass  # 日志写不进不影响校准本身


# ── 辅助绘制 ──────────────────────────────────────────────

def _draw_version(frame: np.ndarray):
    """右下角版本水印（校准屏独立绘制循环，主界面水印覆盖不到这里；
    验收时用户全程在校准屏，须能就地核对版本）"""
    cv2.putText(frame, VERSION,
                (frame.shape[1] - 58, frame.shape[0] - 15),
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (130, 130, 130), 1)


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

def run_calibration(tracker, gaze_est, window_name: str) -> Optional[dict]:
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
    # 顺便采集用户当前注视参照（uncal 空间，供第一个点的到位判定；
    # uncal 字段与旧校准是否残留无关，跨 Phase 比较恒安全）
    from collections import deque
    ref_window: deque = deque(maxlen=CALIB_STABILITY_WINDOW)
    face_ok = False
    while True:
        frame = tracker.read_frame()
        if frame is None:
            return None

        h, w = frame.shape[:2]

        # 检测人脸（复用 gaze_est）
        gaze_result = gaze_est.update(frame)
        # confidence=0 的帧（脸太小提前返回）uncal 是未赋值的默认 0，不可用
        face_ok = gaze_result.face_detected and gaze_result.confidence > 0
        if face_ok:
            ref_window.append((gaze_result.uncal_gaze_x,
                               gaze_result.uncal_gaze_y))

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

        _draw_version(frame)
        cv2.imshow(window_name, frame)
        key = cv2.waitKey(30) & 0xFF

        if key == 27 or key == ord('s') or key == ord('S'):
            print("[Calibration] 用户跳过校准")
            return None
        if key == 32 and face_ok and len(ref_window) >= 5:  # SPACE
            break

    # ── Phase 1: 逐点采集 ─────────────────────────────────
    gaze_est.clear_calibration()  # 清除旧校准，确保采集的是原始值

    # 到位门参照链：上一个成功点的 (raw median, expected)；
    # 首点参照 = Phase 0 用户注视中位数（expected 未知 → 只查位移幅度）
    prev_ref: Optional[Tuple[float, float]] = (
        float(np.median([p[0] for p in ref_window])),
        float(np.median([p[1] for p in ref_window])),
    )
    prev_expected: Optional[Tuple[float, float]] = None

    # 每个点的采集结果：(median_x, median_y)；None = 该点被剔除
    point_medians: List[Optional[Tuple[float, float]]] = []

    total_points = len(CALIB_POINTS_2D)

    # 方向标签
    _LABELS = [
        "TOP-LEFT", "TOP-CENTER", "TOP-RIGHT",
        "MID-LEFT", "MID-CENTER", "MID-RIGHT",
        "BOT-LEFT", "BOT-CENTER", "BOT-RIGHT",
    ]

    for pt_idx, (screen_rx, screen_ry, exp_gx, exp_gy) in enumerate(CALIB_POINTS_2D):
        # 到位门：参照 = 上一成功点；期望方向 = expected 空间位移
        # （raw 与 expected 空间正相关映射，方向符号一致，cos 判据可跨空间）
        expected_dir = None
        if prev_expected is not None:
            expected_dir = (exp_gx - prev_expected[0],
                            exp_gy - prev_expected[1])
        gate = FixationGate(ref_point=prev_ref, expected_dir=expected_dir)
        start_time = time.time()
        done_flash_until = None   # 完成后绿圈定格时刻
        degraded = False
        skipped = False
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

            # ── 质量门控：只有「到位 + 盯稳」的帧才算数 ──
            if done_flash_until is None:
                if gaze_result.face_detected and gaze_result.confidence > 0:
                    # 喂 uncal（Phase 1 已清校准，与 raw 等价；uncal 语义
                    # 不依赖清除动作，防未来流程改动引入跨空间混用）
                    gate.feed(gaze_result.uncal_gaze_x,
                              gaze_result.uncal_gaze_y, now)
                else:
                    gate.interrupt()

                if gate.complete:
                    done_flash_until = now + 0.45
                    print(f"  → 合格样本 {len(gate.qualified)}，"
                          f"用时 {now - start_time:.1f}s"
                          + (f"（放宽 {gate.relax_count} 次）"
                             if gate.relax_count else ""))
                elif gate.given_up:
                    skipped = True
                    done_flash_until = now + 0.45
                    print(f"  ⚠️ 未检测到注视到位（{CALIB_ARRIVAL_GIVEUP:.0f}s），"
                          f"该点剔除（不吃没看点的数据）")
                elif gate.exhausted:
                    degraded = True
                    done_flash_until = now + 0.45
                    print(f"  ⚠️ 降级通过：合格 {len(gate.qualified)}/"
                          f"{CALIB_TARGET_SAMPLES}，用到位后全量样本兜底")

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
            if done and skipped:
                dot_color = (90, 90, 90)      # 剔除点：灰（不给假绿）
            elif done:
                dot_color = (80, 220, 80)
            else:
                dot_color = (0, 200, 255)
            cv2.circle(frame, (dot_x, dot_y), dot_r, dot_color, -1)
            cv2.circle(frame, (dot_x, dot_y), 4, (255, 255, 255), -1)

            # ── 质量进度环（v3.3 核心闭环反馈）──
            ring_r = CALIB_DOT_RADIUS + 20
            # 底环（暗灰）
            cv2.circle(frame, (dot_x, dot_y), ring_r, (70, 70, 70), 3)
            # 进度弧：完成=绿（剔除=灰） / 盯稳采集中=亮青 / 未稳=灰
            if done:
                arc_color = (90, 90, 90) if skipped else (80, 220, 80)
            elif gate.is_stable:
                arc_color = (0, 220, 255)
            else:
                arc_color = (120, 120, 120)
            arc_end = int(360 * (1.0 if done and not skipped else gate.progress))
            if arc_end > 0:
                cv2.ellipse(frame, (dot_x, dot_y), (ring_r, ring_r),
                            -90, 0, arc_end, arc_color, 4)

            # 状态提示（v3.6：未到位时明确喊话，不再默默转圈骗人）
            if done:
                if skipped:
                    status, s_color = "Point skipped - not fixated", (100, 100, 230)
                elif degraded:
                    status, s_color = "DEGRADED - moving on", (80, 220, 80)
                else:
                    status, s_color = "OK!", (80, 220, 80)
            elif not gate.arrived:
                if gate.arrival_overdue:
                    status, s_color = ">>> LOOK AT THE DOT <<<", (0, 120, 255)
                else:
                    status, s_color = "Look at the dot", (0, 180, 255)
            elif gate.is_stable:
                status, s_color = "Collecting... hold your gaze", (0, 220, 255)
            else:
                status, s_color = "Fixate on the dot & hold still", (170, 170, 170)
            _draw_text_centered(frame, status, h - 60, scale=0.55, color=s_color)
            _draw_text_centered(frame,
                                f"Quality samples: {len(gate.qualified)}"
                                f"/{CALIB_TARGET_SAMPLES}",
                                h - 30, scale=0.4, color=(150, 150, 150))

            _draw_version(frame)
            cv2.imshow(window_name, frame)
            key = cv2.waitKey(1) & 0xFF
            if key == 27:  # ESC 中途退出
                print("[Calibration] 用户中途取消")
                return None

        # 每点诊断快照（print + 落盘，下轮排障不再盲猜）
        outcome = "SKIP" if skipped else ("DEGRADED" if degraded else "OK")
        diag_line = (f"pt{pt_idx + 1}/{total_points} {label} {outcome} "
                     f"{now - start_time:.1f}s {gate.diag()}")
        print(f"  [diag] {diag_line}")
        _append_diag(diag_line)

        # 计算本点值（合格样本中位数；降级时到位后全量兜底）
        med = None if skipped else gate.result()
        if med is None:
            if not skipped:
                print(f"[Calibration] 点 {pt_idx + 1} 样本不足，剔除该点")
            point_medians.append(None)
        else:
            point_medians.append(med)
            # 成功点成为下一点的到位参照
            prev_ref = med
            prev_expected = (exp_gx, exp_gy)
            print(f"  → median=({med[0]:.3f}, {med[1]:.3f})")

    # ── Phase 2: 拟合 + 质量评估（v3.6：剔除点过滤 + 残差
    # 离群剔除 + MAE 质量门，见 fit_calib_points）──────────
    try:
        fit = fit_calib_points(point_medians)
    except (np.linalg.LinAlgError, ValueError):
        print("[Calibration] 回归失败")
        return None
    if fit is None:
        n_valid = sum(1 for m in point_medians if m is not None)
        print(f"[Calibration] 有效点不足（{n_valid}/{total_points} < "
              f"{CALIB_MIN_POINTS}），校准失败——请重新校准并注视每个点")
        return None

    coef_x, coef_y = fit["coef_x"], fit["coef_y"]
    model, mae_x, mae_y = fit["model"], fit["mae_x"], fit["mae_y"]
    print(f"[Calibration] 2D 回归结果 (model={model}, "
          f"有效点 {len(fit['kept_idx'])}/{total_points}"
          + (f", 剔除 {[i + 1 for i in fit['dropped_idx']]}"
             if fit["dropped_idx"] else "") + "):")
    print(f"  MAE: X={mae_x:.3f}, Y={mae_y:.3f}"
          + ("" if fit["quality_ok"] else "  ⚠️ 质量差，建议按 C 重做"))
    _append_diag(f"FIT model={model} kept={len(fit['kept_idx'])}"
                 f" dropped={[i + 1 for i in fit['dropped_idx']]}"
                 f" MAE=({mae_x:.3f},{mae_y:.3f})"
                 f" quality={'ok' if fit['quality_ok'] else 'LOW'}")

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
        if not fit["quality_ok"]:
            _draw_text_centered(frame, "LOW QUALITY - press C to redo",
                                95, scale=0.55, color=(80, 80, 255))
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

        _draw_version(frame)
        cv2.imshow(window_name, frame)
        key = cv2.waitKey(1) & 0xFF
        if key == 27 or key == 32:  # ESC 或 SPACE 跳过验证
            break

    print("[Calibration] 9 点校准完成，进入主界面\n")
    # 锚点只含保留点（剔除的污染点不得进隐式校准锚点集）
    return {
        "measured": fit["measured"],
        "expected": fit["expected"],
        "coef_x": coef_x,
        "coef_y": coef_y,
    }
