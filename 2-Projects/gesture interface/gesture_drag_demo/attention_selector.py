"""
attention_selector.py - 注视候选卡片 & 气泡选择器

根据粗粒度注视方向，对所有卡片和气泡评分并选出候选：
- 高斯评分：水平位置越接近注视方向，评分越高
- 帧计数锁定：连续多帧评分最高才锁定候选
- 迟滞切换：当前候选有切换余量保护，防抖动
- 拖拽暂停：拖拽期间冻结候选，释放后恢复
- 气泡候选：独立于卡片候选，锁定更快（气泡短命）

使用 duck typing 引用 Card / Bubble 对象，避免循环导入。
"""

import math
from dataclasses import dataclass, field
from typing import Optional, Any

from config import (
    CANDIDATE_LOCK_FRAMES, CANDIDATE_RELEASE_FRAMES,
    CANDIDATE_PROGRESS_DECAY,
    CARD_GAZE_Y_MIN, BUBBLE_GAZE_Y_MAX, GAZE_Y_GATE_MARGIN,
    CANDIDATE_MIN_CONFIDENCE, ATTENTION_SWITCH_MARGIN,
    ATTENTION_SCORE_SIGMA,
    BUBBLE_LOCK_FRAMES, BUBBLE_RELEASE_FRAMES, BUBBLE_PROGRESS_DECAY,
    BUBBLE_SCORE_SIGMA, BUBBLE_SWITCH_MARGIN,
)

# v3.8.1 dwell 时间制：帧率波动不再改变手感。标称 30fps 下与旧帧数制
# 数学精确等价（LOCK=30帧→1.0s；不传 dt 的调用按标称 dt 走，旧测试语义不变）
_NOMINAL_DT = 1.0 / 30.0
_BUBBLE_LOCK_SECONDS = BUBBLE_LOCK_FRAMES * _NOMINAL_DT


@dataclass
class AttentionState:
    """每帧的注视选择状态快照（传给 UI 用于渲染）"""
    candidate_card: Optional[Any] = None    # 当前候选卡片（Card 对象）
    candidate_locked: bool = False           # 是否已锁定
    scores: dict = field(default_factory=dict)  # {card_label: score}
    mode: str = "free"                       # free / candidate / dragging
    gaze_direction: str = "N/A"              # 注视方向标签
    confidence: float = 0.0                  # 注视可信度
    lock_progress: float = 0.0               # 锁定进度 [0, 1]
    # --- 气泡候选 ---
    candidate_bubble: Optional[Any] = None   # 当前候选气泡（Bubble 对象）
    candidate_bubble_locked: bool = False     # 气泡候选是否已锁定
    bubble_lock_progress: float = 0.0        # 气泡锁定进度 [0, 1]


class AttentionSelector:
    """注视候选卡片选择器"""

    def __init__(self, frame_w: int):
        self.frame_w = frame_w
        # --- 卡片候选 ---
        self._candidate: Optional[Any] = None   # 当前候选卡片
        self._locked: bool = False               # 是否已锁定
        self._lock_count: int = 0                # 连续锁定帧计数
        self._release_count: int = 0             # 连续释放帧计数
        self._dragging: bool = False             # 是否正在拖拽
        # --- 气泡候选 ---
        self._bubble_candidate: Optional[Any] = None
        self._bubble_locked: bool = False
        self._bubble_lock_t: float = 0.0         # dwell 累积秒数（v3.8.1 时间制）
        self._bubble_release_count: int = 0
        # --- 垂直门控阈值（v3.8.1 布局几何推导；未 set_layout 用 config 兜底）---
        self._card_gaze_y_min: float = CARD_GAZE_Y_MIN
        self._bubble_gaze_y_max: float = BUBBLE_GAZE_Y_MAX

    def set_layout(self, frame_h: int, desktop_top_y: int):
        """按布局推导垂直门控分界（v3.8.1）。

        v3.5 拍死的常数是 legacy 垂直信号坏死年代标定的——换真信号后，
        低位气泡（屏高 62.5%~75%）被 0.25 阈值稳定封锁。改为以桌面顶线
        的期望 gaze_y 为分界 ± 余量带：布局变阈值自动跟，此病根治。
        映射与 CALIB_POINTS_2D/card_expected_gaze 同款：(ratio-0.5)/0.5。
        """
        boundary = (desktop_top_y / frame_h - 0.5) / 0.5
        self._card_gaze_y_min = boundary - GAZE_Y_GATE_MARGIN
        self._bubble_gaze_y_max = boundary + GAZE_Y_GATE_MARGIN
        print(f"[Attention] 垂直门控分界={boundary:+.3f} "
              f"(卡片下限 {self._card_gaze_y_min:+.3f} / "
              f"气泡上限 {self._bubble_gaze_y_max:+.3f})")

    def set_dragging(self, dragging: bool):
        """进入/退出拖拽状态（仅在状态转换沿动作）。

        v3.4.1 历史 bug 修复：app.py 每帧都调本方法，旧实现无条件走
        else 分支清空锁定状态 → 卡片 8 帧锁定 / 气泡锁定的计数每帧被
        打回零，「锁定」从未真正达成（候选高亮每帧重算所以看不出来）。
        改为只在拖拽状态转换沿清一次。
        """
        if dragging == self._dragging:
            return  # 状态未变：每帧调用不得清进度
        self._dragging = dragging
        if dragging:
            # 拖拽开始：冻结候选状态
            pass
        else:
            # 拖拽结束：清除卡片和气泡候选，重新选择
            self._candidate = None
            self._locked = False
            self._lock_count = 0
            self._release_count = 0
            self._bubble_candidate = None
            self._bubble_locked = False
            self._bubble_lock_t = 0.0
            self._bubble_release_count = 0

    def update(self, gaze_x: float, confidence: float,
               cards: list, direction_label: str = "N/A",
               gaze_y: float = None) -> AttentionState:
        """
        每帧调用，根据 gaze_x 更新候选卡片。

        参数：
            gaze_x: 平滑后的水平注视方向 [-1, 1]
            confidence: 注视估计可信度 [0, 1]
            cards: 所有卡片列表（需要 .x, .w, .label 属性）
            direction_label: 可读方向标签

        返回：
            AttentionState 快照
        """
        # 拖拽期间不更新
        if self._dragging:
            return AttentionState(
                candidate_card=self._candidate,
                candidate_locked=self._locked,
                mode="dragging",
                gaze_direction=direction_label,
                confidence=confidence,
                lock_progress=1.0 if self._locked else 0.0,
                candidate_bubble=self._bubble_candidate,
                candidate_bubble_locked=self._bubble_locked,
                bubble_lock_progress=1.0 if self._bubble_locked else 0.0,
            )

        # 可信度太低，不做选择
        if confidence < 0.15:
            return AttentionState(
                mode="free",
                gaze_direction=direction_label,
                confidence=confidence,
                candidate_bubble=self._bubble_candidate,
                candidate_bubble_locked=self._bubble_locked,
                bubble_lock_progress=self.bubble_lock_progress,
            )

        # ============================================================
        # 1. 对所有卡片评分
        # ============================================================
        scores = {}
        best_card = None
        best_score = -1.0

        for card in cards:
            # 卡片中心的归一化水平位置 [0, 1] → 映射到 [-1, 1]
            card_center_x = card.x + card.w / 2.0
            card_nx = (card_center_x / self.frame_w) * 2.0 - 1.0

            # 高斯评分：注视方向与卡片位置的接近程度
            dist = abs(gaze_x - card_nx)
            sigma = ATTENTION_SCORE_SIGMA
            score = math.exp(-(dist * dist) / (2.0 * sigma * sigma))

            # 乘以可信度
            score *= confidence

            scores[card.label] = score

            if score > best_score:
                best_score = score
                best_card = card

        # v3.5 垂直门控：视线在上方（如看气泡）时，底部卡片不得成为
        # 候选——修"盯气泡时底部卡片躺枪跳选中"（评分是 1D 水平的历史设计）
        # v3.8.1：阈值改布局几何推导（set_layout），常数仅兜底
        if gaze_y is not None and gaze_y < self._card_gaze_y_min:
            best_card = None
            best_score = -1.0

        # ============================================================
        # 2. 候选跟踪与锁定
        # ============================================================
        if best_card is None or best_score < CANDIDATE_MIN_CONFIDENCE:
            # 无有效候选
            self._release_count += 1
            # v3.7：进度衰减而非清零（视线微抖/分数瞬跌不再把 8 帧
            # 进度打回原点——「进度一直跳」主因之一；气泡 v3.4 已用此范式）
            self._lock_count = max(
                0, self._lock_count - CANDIDATE_PROGRESS_DECAY)
            if self._release_count >= CANDIDATE_RELEASE_FRAMES:
                self._candidate = None
                self._locked = False
                self._release_count = 0
            mode = "free" if self._candidate is None else "candidate"
            return AttentionState(
                candidate_card=self._candidate,
                candidate_locked=self._locked,
                scores=scores,
                mode=mode,
                gaze_direction=direction_label,
                confidence=confidence,
                lock_progress=self._lock_count / max(1, CANDIDATE_LOCK_FRAMES),
                candidate_bubble=self._bubble_candidate,
                candidate_bubble_locked=self._bubble_locked,
                bubble_lock_progress=self.bubble_lock_progress,
            )

        # 有有效候选
        if self._candidate is None:
            # 首次选中
            self._candidate = best_card
            self._lock_count = 1
            self._release_count = 0
        elif best_card is self._candidate:
            # 同一张卡片，累加锁定帧
            self._lock_count += 1
            self._release_count = 0
        else:
            # 不同卡片，检查迟滞余量
            if self._candidate is not None:
                current_score = scores.get(self._candidate.label, 0.0)
                if best_score > current_score + ATTENTION_SWITCH_MARGIN:
                    # 新卡片明显更好，切换候选
                    self._candidate = best_card
                    self._lock_count = 1
                    self._release_count = 0
                    self._locked = False
                else:
                    # 差距不够大，保持当前候选
                    self._lock_count += 1
                    self._release_count = 0

        # 检查是否满足锁定条件
        if self._lock_count >= CANDIDATE_LOCK_FRAMES and not self._locked:
            self._locked = True

        mode = "candidate"
        return AttentionState(
            candidate_card=self._candidate,
            candidate_locked=self._locked,
            scores=scores,
            mode=mode,
            gaze_direction=direction_label,
            confidence=confidence,
            lock_progress=min(1.0, self._lock_count / max(1, CANDIDATE_LOCK_FRAMES)),
            candidate_bubble=self._bubble_candidate,
            candidate_bubble_locked=self._bubble_locked,
            bubble_lock_progress=self.bubble_lock_progress,
        )

    @property
    def bubble_lock_progress(self) -> float:
        """气泡凝视驻留进度 [0,1]（v3.4 进度环 UI 用；v3.8.1 时间制）"""
        return min(1.0, self._bubble_lock_t / _BUBBLE_LOCK_SECONDS)

    def update_bubbles(self, gaze_x: float, confidence: float,
                       bubbles: list, gaze_y: float = None,
                       dt: float = _NOMINAL_DT) -> None:
        """
        每帧调用（在 update() 之后），根据 gaze_x 更新候选气泡。

        气泡候选独立于卡片候选，锁定更快（气泡短命 5s）。
        气泡使用 cx 中心坐标（Bubble.cx），与卡片的 x+w/2 不同。

        参数：
            gaze_x: 平滑后的水平注视方向 [-1, 1]
            confidence: 注视估计可信度 [0, 1]
            bubbles: 当前存活的气泡列表（需要 .cx, .title 属性）
            dt: 距上帧秒数（v3.8.1 时间制 dwell；不传按标称 30fps）
        """
        # 拖拽期间冻结
        if self._dragging:
            return

        # v3.5 垂直门控：视线在下方（真看卡片区）时气泡进度衰减
        # v3.8.1：阈值改布局几何推导（set_layout），常数仅兜底
        _y_gated = gaze_y is not None and gaze_y > self._bubble_gaze_y_max

        # 没有气泡 → 清除候选
        if not bubbles or confidence < 0.15 or _y_gated:
            self._bubble_release_count += 1
            # v3.4：进度衰减而非清零（短暂低置信不打回原点）
            self._bubble_lock_t = max(
                0.0, self._bubble_lock_t - BUBBLE_PROGRESS_DECAY * dt)
            if self._bubble_release_count >= BUBBLE_RELEASE_FRAMES:
                self._bubble_candidate = None
                self._bubble_locked = False
                self._bubble_release_count = 0
            return

        # 清理已过期的候选（气泡可能已消失）
        if (self._bubble_candidate is not None
                and self._bubble_candidate not in bubbles):
            self._bubble_candidate = None
            self._bubble_locked = False
            self._bubble_lock_t = 0.0
            self._bubble_release_count = 0

        # 对所有气泡评分
        best_bubble = None
        best_score = -1.0

        for bubble in bubbles:
            # 气泡中心归一化到 [-1, 1]
            bubble_nx = (bubble.cx / self.frame_w) * 2.0 - 1.0
            dist = abs(gaze_x - bubble_nx)
            score = math.exp(-(dist * dist) / (2.0 * BUBBLE_SCORE_SIGMA * BUBBLE_SCORE_SIGMA))
            score *= confidence
            if score > best_score:
                best_score = score
                best_bubble = bubble

        # 候选跟踪与锁定（和卡片逻辑类似，但更快）
        if best_bubble is None or best_score < CANDIDATE_MIN_CONFIDENCE:
            self._bubble_release_count += 1
            # v3.4：进度衰减而非清零（视线短暂飘走回来接着涨）
            self._bubble_lock_t = max(
                0.0, self._bubble_lock_t - BUBBLE_PROGRESS_DECAY * dt)
            if self._bubble_release_count >= BUBBLE_RELEASE_FRAMES:
                self._bubble_candidate = None
                self._bubble_locked = False
                self._bubble_release_count = 0
            return

        if self._bubble_candidate is None:
            self._bubble_candidate = best_bubble
            self._bubble_lock_t = dt
            self._bubble_release_count = 0
        elif best_bubble is self._bubble_candidate:
            self._bubble_lock_t += dt
            self._bubble_release_count = 0
        else:
            # 迟滞切换：需要比当前候选明显更好
            current_nx = (self._bubble_candidate.cx / self.frame_w) * 2.0 - 1.0
            current_dist = abs(gaze_x - current_nx)
            current_score = math.exp(
                -(current_dist * current_dist) / (2.0 * BUBBLE_SCORE_SIGMA * BUBBLE_SCORE_SIGMA)
            ) * confidence
            if best_score > current_score + BUBBLE_SWITCH_MARGIN:
                self._bubble_candidate = best_bubble
                self._bubble_lock_t = dt
                self._bubble_release_count = 0
                self._bubble_locked = False
            else:
                self._bubble_lock_t += dt
                self._bubble_release_count = 0

        if self._bubble_lock_t >= _BUBBLE_LOCK_SECONDS and not self._bubble_locked:
            self._bubble_locked = True

    def reset(self):
        """重置选择器状态"""
        self._candidate = None
        self._locked = False
        self._lock_count = 0
        self._release_count = 0
        self._dragging = False
        self._bubble_candidate = None
        self._bubble_locked = False
        self._bubble_lock_t = 0.0
        self._bubble_release_count = 0
