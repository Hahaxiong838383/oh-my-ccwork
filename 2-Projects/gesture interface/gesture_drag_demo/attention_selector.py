"""
attention_selector.py - 注视候选卡片选择器

根据粗粒度注视方向，对所有卡片评分并选出候选卡片：
- 高斯评分：卡片水平位置越接近注视方向，评分越高
- 帧计数锁定：连续多帧评分最高才锁定候选
- 迟滞切换：当前候选有切换余量保护，防抖动
- 拖拽暂停：拖拽期间冻结候选，释放后恢复

使用 duck typing 引用 Card 对象，避免循环导入。
"""

import math
from dataclasses import dataclass, field
from typing import Optional, Any

from config import (
    CANDIDATE_LOCK_FRAMES, CANDIDATE_RELEASE_FRAMES,
    CANDIDATE_MIN_CONFIDENCE, ATTENTION_SWITCH_MARGIN,
    ATTENTION_SCORE_SIGMA,
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


class AttentionSelector:
    """注视候选卡片选择器"""

    def __init__(self, frame_w: int):
        self.frame_w = frame_w
        self._candidate: Optional[Any] = None   # 当前候选卡片
        self._locked: bool = False               # 是否已锁定
        self._lock_count: int = 0                # 连续锁定帧计数
        self._release_count: int = 0             # 连续释放帧计数
        self._dragging: bool = False             # 是否正在拖拽

    def set_dragging(self, dragging: bool):
        """进入/退出拖拽状态"""
        self._dragging = dragging
        if dragging:
            # 拖拽开始：冻结候选状态
            pass
        else:
            # 拖拽结束：清除候选，重新选择
            self._candidate = None
            self._locked = False
            self._lock_count = 0
            self._release_count = 0

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
            )

        # 可信度太低，不做选择
        if confidence < 0.15:
            return AttentionState(
                mode="free",
                gaze_direction=direction_label,
                confidence=confidence,
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
        )

    def reset(self):
        """重置选择器状态"""
        self._candidate = None
        self._locked = False
        self._lock_count = 0
        self._release_count = 0
        self._dragging = False
