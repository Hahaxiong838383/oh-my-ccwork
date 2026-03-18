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
    CANDIDATE_MIN_CONFIDENCE, ATTENTION_SWITCH_MARGIN,
    ATTENTION_SCORE_SIGMA,
    BUBBLE_LOCK_FRAMES, BUBBLE_RELEASE_FRAMES,
    BUBBLE_SCORE_SIGMA, BUBBLE_SWITCH_MARGIN,
)


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
        self._bubble_lock_count: int = 0
        self._bubble_release_count: int = 0

    def set_dragging(self, dragging: bool):
        """进入/退出拖拽状态"""
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
            self._bubble_lock_count = 0
            self._bubble_release_count = 0

    def update(self, gaze_x: float, confidence: float,
               cards: list, direction_label: str = "N/A") -> AttentionState:
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
                bubble_lock_progress=self._bubble_lock_count / max(1, BUBBLE_LOCK_FRAMES),
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

        # ============================================================
        # 2. 候选跟踪与锁定
        # ============================================================
        if best_card is None or best_score < CANDIDATE_MIN_CONFIDENCE:
            # 无有效候选
            self._release_count += 1
            self._lock_count = 0
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
                bubble_lock_progress=self._bubble_lock_count / max(1, BUBBLE_LOCK_FRAMES),
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
            bubble_lock_progress=min(1.0, self._bubble_lock_count / max(1, BUBBLE_LOCK_FRAMES)),
        )

    def update_bubbles(self, gaze_x: float, confidence: float,
                       bubbles: list) -> None:
        """
        每帧调用（在 update() 之后），根据 gaze_x 更新候选气泡。

        气泡候选独立于卡片候选，锁定更快（气泡短命 5s）。
        气泡使用 cx 中心坐标（Bubble.cx），与卡片的 x+w/2 不同。

        参数：
            gaze_x: 平滑后的水平注视方向 [-1, 1]
            confidence: 注视估计可信度 [0, 1]
            bubbles: 当前存活的气泡列表（需要 .cx, .title 属性）
        """
        # 拖拽期间冻结
        if self._dragging:
            return

        # 没有气泡 → 清除候选
        if not bubbles or confidence < 0.15:
            self._bubble_release_count += 1
            self._bubble_lock_count = 0
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
            self._bubble_lock_count = 0
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
            self._bubble_lock_count = 0
            if self._bubble_release_count >= BUBBLE_RELEASE_FRAMES:
                self._bubble_candidate = None
                self._bubble_locked = False
                self._bubble_release_count = 0
            return

        if self._bubble_candidate is None:
            self._bubble_candidate = best_bubble
            self._bubble_lock_count = 1
            self._bubble_release_count = 0
        elif best_bubble is self._bubble_candidate:
            self._bubble_lock_count += 1
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
                self._bubble_lock_count = 1
                self._bubble_release_count = 0
                self._bubble_locked = False
            else:
                self._bubble_lock_count += 1
                self._bubble_release_count = 0

        if self._bubble_lock_count >= BUBBLE_LOCK_FRAMES and not self._bubble_locked:
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
        self._bubble_lock_count = 0
        self._bubble_release_count = 0
