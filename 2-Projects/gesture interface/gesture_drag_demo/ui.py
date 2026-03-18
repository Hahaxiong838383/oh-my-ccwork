"""
ui.py - 桌面、卡片绘制、命中测试、拖拽逻辑

职责：
- 管理 4 个底部桌面和卡片列表
- 绘制桌面（黑色背景区域）
- 绘制卡片（普通 / 高亮 / 拖拽中）
- 命中测试（点是否在卡片区域内）
- 拖拽逻辑（抓住、跟随、释放，支持跨桌面）
- 绘制调试信息叠加层
"""

import cv2
import time
import random
import math
import numpy as np
from dataclasses import dataclass, field
from typing import Optional
from gesture_state import GesturePhase


# --- 特效参数 ---
DRAG_SCALE = 1.15            # 拖拽中卡片放大倍率
SHADOW_OFFSET = (6, 8)       # 拖拽阴影偏移 (dx, dy)
SHADOW_COLOR = (0, 0, 0)     # 阴影颜色
SHADOW_ALPHA = 0.4            # 阴影不透明度
REPEL_STRENGTH = 0.35         # 挤压排斥力强度 (0~1)
REPEL_DAMPING = 0.7           # 挤压运动阻尼

# --- 卡片样式表（12 种颜色，每桌面 3 张） ---
CARD_STYLES = [
    ((80, 50, 50), (200, 100, 100)),    # 红
    ((50, 80, 50), (100, 200, 100)),    # 绿
    ((50, 50, 80), (100, 100, 200)),    # 蓝
    ((80, 80, 50), (200, 200, 100)),    # 黄
    ((80, 50, 80), (200, 100, 200)),    # 紫
    ((50, 80, 80), (100, 200, 200)),    # 青
    ((90, 60, 40), (220, 140, 80)),     # 橙
    ((60, 40, 70), (140, 80, 160)),     # 紫罗兰
    ((40, 70, 60), (80, 160, 140)),     # 青绿
    ((70, 70, 70), (180, 180, 180)),    # 灰
    ((90, 50, 60), (220, 100, 140)),    # 粉
    ((50, 70, 40), (100, 160, 80)),     # 青柠
]

# --- 气泡样本数据 ---
BUBBLE_SAMPLES = [
    {"title": "Meeting", "content": "Team standup 10am\nSprint review"},
    {"title": "Task", "content": "Review PR #42\nFix login bug"},
    {"title": "Remind", "content": "Call client 3pm\nPrepare slides"},
    {"title": "Note", "content": "New API endpoint\n/api/v2/users"},
    {"title": "Alert", "content": "Server CPU > 90%\nCheck logs"},
    {"title": "Mail", "content": "From: boss\nQ3 report due"},
    {"title": "Event", "content": "Product launch\nFriday 2pm"},
    {"title": "Update", "content": "v2.1 released\n3 bug fixes"},
]

BUBBLE_COLORS = [
    (80, 180, 255),   # 橙 (BGR)
    (255, 180, 80),   # 蓝
    (80, 255, 180),   # 绿
    (180, 80, 255),   # 紫
    (80, 255, 255),   # 黄
    (255, 80, 180),   # 粉
]


# ================================================================
# 数据结构
# ================================================================

@dataclass
class Desktop:
    """底部桌面区域（黑色背景）"""
    x: int
    y: int
    w: int
    h: int
    index: int
    color: tuple = (15, 15, 15)          # 近黑色背景
    border_color: tuple = (50, 50, 50)   # 暗灰边框

    def contains(self, px: int, py: int) -> bool:
        return self.x <= px <= self.x + self.w and self.y <= py <= self.y + self.h

    def center(self) -> tuple:
        return (self.x + self.w // 2, self.y + self.h // 2)


@dataclass
class Card:
    """一张可拖拽的卡片"""
    x: int              # 左上角 x
    y: int              # 左上角 y
    w: int = 85         # 宽度
    h: int = 60         # 高度
    color: tuple = (60, 60, 60)        # 默认颜色 (BGR)
    border_color: tuple = (180, 180, 180)  # 边框颜色
    label: str = ""     # 卡片上显示的文字
    # 初始位置（用于重置）
    init_x: int = 0
    init_y: int = 0
    # 挤压速度（内部状态）
    vx: float = 0.0
    vy: float = 0.0
    desktop_index: int = 0
    slot_index: int = 0
    init_desktop_index: int = 0
    init_slot_index: int = 0
    # 气泡内容（当卡片被气泡替换时）
    has_bubble: bool = False
    bubble_title: str = ""
    bubble_content: str = ""
    bubble_color: tuple = (0, 0, 0)

    def __post_init__(self):
        self.init_x = self.x
        self.init_y = self.y
        self.init_desktop_index = self.desktop_index
        self.init_slot_index = self.slot_index

    def contains(self, px: int, py: int) -> bool:
        """判断点 (px, py) 是否在卡片区域内"""
        return self.x <= px <= self.x + self.w and self.y <= py <= self.y + self.h

    def center(self) -> tuple:
        return (self.x + self.w // 2, self.y + self.h // 2)

    def rect(self) -> tuple:
        """返回 (x1, y1, x2, y2)"""
        return (self.x, self.y, self.x + self.w, self.y + self.h)

    def reset(self):
        self.x = self.init_x
        self.y = self.init_y
        self.vx = 0.0
        self.vy = 0.0
        self.desktop_index = self.init_desktop_index
        self.slot_index = self.init_slot_index
        self.has_bubble = False
        self.bubble_title = ""
        self.bubble_content = ""
        self.bubble_color = (0, 0, 0)


@dataclass
class Bubble:
    """随机出现的气泡，可拖拽到桌面替换卡片"""
    cx: int             # 中心 x
    cy: int             # 中心 y
    radius: int = 35
    color: tuple = (200, 100, 50)
    title: str = ""
    content: str = ""
    spawn_time: float = 0.0
    lifetime: float = 5.0
    being_dragged: bool = False

    def contains(self, px: int, py: int) -> bool:
        dx = px - self.cx
        dy = py - self.cy
        return dx * dx + dy * dy <= self.radius * self.radius

    def is_expired(self, now: float) -> bool:
        return now - self.spawn_time >= self.lifetime

    def alpha(self, now: float) -> float:
        """返回 0.0~1.0，最后 1 秒淡出"""
        remaining = self.lifetime - (now - self.spawn_time)
        if remaining <= 0:
            return 0.0
        if remaining <= 1.0:
            return remaining
        return 1.0


# ================================================================
# 拖拽管理
# ================================================================

class DragManager:
    """拖拽管理器（支持卡片和气泡）"""

    def __init__(self):
        self.dragging_card: Optional[Card] = None
        self.dragging_bubble: Optional[Bubble] = None
        self.offset_x: float = 0.0
        self.offset_y: float = 0.0
        self.hover_card: Optional[Card] = None
        self.drop_target_card: Optional[Card] = None  # 气泡拖拽时的目标卡片

    @property
    def is_dragging(self) -> bool:
        return self.dragging_card is not None or self.dragging_bubble is not None

    def try_grab_bubble(self, bubbles: list, px: float, py: float) -> bool:
        """尝试抓住气泡（优先于卡片）。返回是否成功。"""
        if self.is_dragging:
            return self.dragging_bubble is not None
        for bubble in reversed(bubbles):
            if bubble.contains(int(px), int(py)):
                self.dragging_bubble = bubble
                bubble.being_dragged = True
                self.offset_x = bubble.cx - px
                self.offset_y = bubble.cy - py
                return True
        return False

    def try_grab(self, cards: list[Card], px: float, py: float) -> bool:
        """尝试抓住卡片。返回是否成功抓住。"""
        if self.is_dragging:
            return self.dragging_card is not None

        for card in reversed(cards):
            if card.contains(int(px), int(py)):
                self.dragging_card = card
                self.offset_x = card.x - px
                self.offset_y = card.y - py
                return True
        return False

    def update_drag(self, px: float, py: float):
        """更新拖拽位置（卡片或气泡）"""
        if self.dragging_card is not None:
            self.dragging_card.x = int(px + self.offset_x)
            self.dragging_card.y = int(py + self.offset_y)
        elif self.dragging_bubble is not None:
            self.dragging_bubble.cx = int(px + self.offset_x)
            self.dragging_bubble.cy = int(py + self.offset_y)

    def release(self) -> Optional[Bubble]:
        """释放拖拽。如果释放的是气泡，返回该气泡。"""
        released_bubble = None
        if self.dragging_bubble is not None:
            self.dragging_bubble.being_dragged = False
            released_bubble = self.dragging_bubble
            self.dragging_bubble = None
        self.dragging_card = None
        self.offset_x = 0.0
        self.offset_y = 0.0
        self.drop_target_card = None
        return released_bubble

    def update_hover(self, cards: list[Card], px: float, py: float):
        """更新 hover 状态（pinch 点靠近哪张卡片）"""
        self.hover_card = None
        for card in reversed(cards):
            if card.contains(int(px), int(py)):
                self.hover_card = card
                break

    def update_drop_target(self, cards: list[Card], desktops: list):
        """更新气泡拖拽时的放置目标卡片（桌面内最近的卡片）"""
        self.drop_target_card = None
        if self.dragging_bubble is None:
            return

        desk_idx = find_desktop_at(desktops, self.dragging_bubble.cx,
                                    self.dragging_bubble.cy)
        if desk_idx < 0:
            return

        desk = desktops[desk_idx]
        best_card = None
        best_dist = float('inf')
        for card in cards:
            if card.desktop_index != desk_idx:
                continue
            sx, sy = get_slot_xy(desk, card.slot_index, card.w, card.h)
            ccx = sx + card.w // 2
            ccy = sy + card.h // 2
            dx = self.dragging_bubble.cx - ccx
            dy = self.dragging_bubble.cy - ccy
            dist = dx * dx + dy * dy
            if dist < best_dist:
                best_dist = dist
                best_card = card
        self.drop_target_card = best_card


# ================================================================
# 气泡管理
# ================================================================

class BubbleManager:
    """气泡生成与生命周期管理"""

    def __init__(self, frame_w: int, frame_h: int, desktop_top_y: int):
        self.frame_w = frame_w
        self.frame_h = frame_h
        self.spawn_y_max = desktop_top_y - 30  # 不在桌面区域生成
        self.bubbles: list[Bubble] = []
        self.max_bubbles = 2
        self.next_spawn_time = time.time() + 2.0  # 2 秒后开始生成
        self._used_samples: list[int] = []  # 避免连续重复

    def update(self):
        """更新气泡：移除过期的，生成新的"""
        now = time.time()

        # 移除过期的气泡（正在拖拽的不移除）
        self.bubbles = [
            b for b in self.bubbles
            if not b.is_expired(now) or b.being_dragged
        ]

        # 生成新气泡
        active_count = len([b for b in self.bubbles if not b.being_dragged])
        if active_count < self.max_bubbles and now >= self.next_spawn_time:
            self._spawn()
            # 下次生成间隔 1~3 秒
            self.next_spawn_time = now + random.uniform(1.0, 3.0)

    def _spawn(self):
        """生成一个新气泡"""
        margin = 80
        cx = random.randint(margin, self.frame_w - margin)
        cy = random.randint(margin, min(self.spawn_y_max, self.frame_h * 3 // 4))
        radius = random.randint(30, 45)

        # 选择不重复的样本
        available = [i for i in range(len(BUBBLE_SAMPLES)) if i not in self._used_samples]
        if not available:
            self._used_samples.clear()
            available = list(range(len(BUBBLE_SAMPLES)))
        idx = random.choice(available)
        self._used_samples.append(idx)
        if len(self._used_samples) > 4:
            self._used_samples.pop(0)

        sample = BUBBLE_SAMPLES[idx]
        color = random.choice(BUBBLE_COLORS)

        bubble = Bubble(
            cx=cx, cy=cy, radius=radius, color=color,
            title=sample["title"], content=sample["content"],
            spawn_time=time.time(),
        )
        self.bubbles.append(bubble)

    def remove(self, bubble: Bubble):
        """移除指定气泡"""
        if bubble in self.bubbles:
            self.bubbles.remove(bubble)

    def find_at(self, px: float, py: float) -> Optional[Bubble]:
        """查找指定位置的气泡"""
        for bubble in reversed(self.bubbles):
            if bubble.contains(int(px), int(py)):
                return bubble
        return None


# ================================================================
# 创建桌面和卡片
# ================================================================

def create_desktops(frame_w: int, frame_h: int) -> list[Desktop]:
    """
    创建 4 个底部桌面，原始尺寸 1280x400，等比例缩放。
    横向平均分布在界面底部。
    """
    gap = 6           # 桌面之间的间距
    margin_x = 6       # 左右边距
    margin_bottom = 6  # 底部边距

    available_w = frame_w - margin_x * 2 - gap * 3
    desk_w = available_w // 4
    scale = desk_w / 1280.0
    desk_h = int(400 * scale)
    desk_y = frame_h - desk_h - margin_bottom - desk_h // 2

    desktops = []
    for i in range(4):
        x = margin_x + i * (desk_w + gap)
        desktops.append(Desktop(x=x, y=desk_y, w=desk_w, h=desk_h, index=i))
    return desktops


def create_desktop_cards(desktops: list[Desktop]) -> list[Card]:
    """
    在每个桌面中创建 3 张均匀分布的卡片（共 12 张）。
    卡片大小根据桌面尺寸自动计算。
    """
    cards = []
    style_idx = 0

    for desk in desktops:
        padding = 10
        usable_w = desk.w - padding * 2
        usable_h = desk.h - padding * 2

        # 动态计算卡片尺寸
        gap_between = 10
        card_w = (usable_w - gap_between * 2) // 3
        card_h = min(usable_h - 6, int(card_w * 0.72))

        for j in range(3):
            cx = desk.x + padding + j * (card_w + gap_between)
            cy = desk.y + (desk.h - card_h) // 2

            color, border = CARD_STYLES[style_idx % len(CARD_STYLES)]
            cards.append(Card(
                x=cx, y=cy,
                w=card_w, h=card_h,
                color=color,
                border_color=border,
                label=f"{desk.index + 1}-{chr(65 + j)}",
                desktop_index=desk.index,
                slot_index=j,
            ))
            style_idx += 1

    return cards


def find_desktop_at(desktops: list[Desktop], px: int, py: int) -> int:
    """返回包含点 (px, py) 的桌面索引，不在任何桌面上返回 -1"""
    for desk in desktops:
        if desk.contains(px, py):
            return desk.index
    return -1


# ================================================================
# 绘制函数
# ================================================================

def _draw_rounded_rect(frame: np.ndarray, x: int, y: int, w: int, h: int,
                       color: tuple, thickness: int = -1, radius: int = 12):
    """绘制圆角矩形"""
    r = min(radius, w // 2, h // 2)
    x1, y1, x2, y2 = x, y, x + w, y + h

    if thickness == -1:
        # 填充：中间矩形 + 四个角圆
        cv2.rectangle(frame, (x1 + r, y1), (x2 - r, y2), color, -1)
        cv2.rectangle(frame, (x1, y1 + r), (x2, y2 - r), color, -1)
        cv2.circle(frame, (x1 + r, y1 + r), r, color, -1)
        cv2.circle(frame, (x2 - r, y1 + r), r, color, -1)
        cv2.circle(frame, (x1 + r, y2 - r), r, color, -1)
        cv2.circle(frame, (x2 - r, y2 - r), r, color, -1)
    else:
        # 描边：四条线 + 四个角弧
        cv2.line(frame, (x1 + r, y1), (x2 - r, y1), color, thickness)
        cv2.line(frame, (x1 + r, y2), (x2 - r, y2), color, thickness)
        cv2.line(frame, (x1, y1 + r), (x1, y2 - r), color, thickness)
        cv2.line(frame, (x2, y1 + r), (x2, y2 - r), color, thickness)
        cv2.ellipse(frame, (x1 + r, y1 + r), (r, r), 180, 0, 90, color, thickness)
        cv2.ellipse(frame, (x2 - r, y1 + r), (r, r), 270, 0, 90, color, thickness)
        cv2.ellipse(frame, (x1 + r, y2 - r), (r, r), 90, 0, 90, color, thickness)
        cv2.ellipse(frame, (x2 - r, y2 - r), (r, r), 0, 0, 90, color, thickness)


def draw_desktops(frame: np.ndarray, desktops: list[Desktop],
                  highlight_index: int = -1):
    """
    绘制 4 个底部桌面区域。
    highlight_index：拖拽目标桌面索引（高亮显示边框）
    """
    for desk in desktops:
        # 黑色背景填充
        _draw_rounded_rect(frame, desk.x, desk.y, desk.w, desk.h,
                           desk.color, -1, 8)

        # 边框
        if desk.index == highlight_index:
            border = (0, 200, 200)  # 青色高亮（拖拽目标）
            thickness = 2
        else:
            border = desk.border_color
            thickness = 1
        _draw_rounded_rect(frame, desk.x, desk.y, desk.w, desk.h,
                           border, thickness, 8)

        # 桌面编号（右上角小字）
        num_label = str(desk.index + 1)
        label_x = desk.x + desk.w - 18
        label_y = desk.y + 16
        cv2.putText(frame, num_label, (label_x, label_y),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.35, (70, 70, 70), 1)


def draw_card(frame: np.ndarray, card: Card, is_hover: bool, is_dragging: bool,
              is_drop_target: bool = False,
              is_candidate: bool = False, candidate_locked: bool = False):
    """绘制单张卡片（支持拖拽放大 + 阴影 + 放置目标高亮 + 注视候选高亮）"""
    cx_card = card.x + card.w / 2.0
    cy_card = card.y + card.h / 2.0
    # 字体大小根据卡片宽度动态缩放
    base_font = card.w / 250.0

    if is_dragging:
        # 放大：以卡片中心为基点
        scale = DRAG_SCALE
        sw = int(card.w * scale)
        sh = int(card.h * scale)
        sx = int(cx_card - sw / 2)
        sy = int(cy_card - sh / 2)

        # --- 第一层：扩散阴影（远、大、柔）= 悬浮深度感 ---
        overlay_far = frame.copy()
        far_dx, far_dy = 10, 14
        far_pad = 6
        _draw_rounded_rect(overlay_far,
                            sx + far_dx - far_pad, sy + far_dy - far_pad,
                            sw + far_pad * 2, sh + far_pad * 2,
                            (0, 0, 0), -1, 14)
        cv2.addWeighted(overlay_far, 0.18, frame, 0.82, 0, frame)

        # --- 第二层：近阴影（紧、实）= 接触面感 ---
        sdx, sdy = SHADOW_OFFSET
        overlay = frame.copy()
        _draw_rounded_rect(overlay, sx + sdx, sy + sdy, sw, sh, SHADOW_COLOR, -1, 10)
        cv2.addWeighted(overlay, SHADOW_ALPHA, frame, 1 - SHADOW_ALPHA, 0, frame)

        # --- 填充（提亮）---
        base_color = card.bubble_color if card.has_bubble else card.color
        fill_color = tuple(min(c + 50, 255) for c in base_color)
        _draw_rounded_rect(frame, sx, sy, sw, sh, fill_color, -1, 10)

        # --- 顶部高光条（模拟从上方打来的光照）---
        highlight_color = tuple(min(c + 120, 255) for c in base_color)
        hl_h = max(4, sh // 7)
        overlay_hl = frame.copy()
        _draw_rounded_rect(overlay_hl, sx, sy, sw, hl_h, highlight_color, -1, 10)
        cv2.addWeighted(overlay_hl, 0.30, frame, 0.70, 0, frame)

        # --- 底部暗边（加深底部模拟厚度/立体感）---
        dk_h = max(3, sh // 8)
        overlay_dk = frame.copy()
        _draw_rounded_rect(overlay_dk, sx, sy + sh - dk_h, sw, dk_h, (0, 0, 0), -1, 10)
        cv2.addWeighted(overlay_dk, 0.15, frame, 0.85, 0, frame)

        # 边框 - 发光
        glow = card.bubble_color if card.has_bubble else (0, 255, 255)
        _draw_rounded_rect(frame, sx, sy, sw, sh, glow, 2, 10)

        # 文字
        drag_label = card.bubble_title if card.has_bubble else card.label
        font_scale = base_font * scale
        text_size = cv2.getTextSize(drag_label, cv2.FONT_HERSHEY_SIMPLEX,
                                     font_scale, 2)[0]
        text_x = sx + (sw - text_size[0]) // 2
        text_y = sy + (sh + text_size[1]) // 2
        cv2.putText(frame, drag_label,
                    (text_x, text_y),
                    cv2.FONT_HERSHEY_SIMPLEX, font_scale, (255, 255, 255), 2)
    else:
        x, y, w, h = card.x, card.y, card.w, card.h

        # 放置目标：上浮 + 外发光效果（在卡片内容之前绘制）
        if is_drop_target:
            y = y - 8  # 上浮几像素，模拟被"顶起"
            pulse = 0.5 + 0.5 * math.sin(time.time() * 6.0)
            glow_pad = 4
            overlay_glow = frame.copy()
            _draw_rounded_rect(overlay_glow, x - glow_pad, y - glow_pad,
                                w + glow_pad * 2, h + glow_pad * 2,
                                (0, 220, 255), -1, 10)
            blend = 0.15 + pulse * 0.15
            cv2.addWeighted(overlay_glow, blend, frame, 1 - blend, 0, frame)

        # 注视候选：已锁定 → 金色脉冲边框 + 外发光 + 上浮
        elif candidate_locked:
            y = y - 5  # 上浮 5px
            pulse = 0.5 + 0.5 * math.sin(time.time() * 4.0)
            glow_pad = 3
            overlay_glow = frame.copy()
            gold = (0, 200, 255)  # BGR 金色
            _draw_rounded_rect(overlay_glow, x - glow_pad, y - glow_pad,
                                w + glow_pad * 2, h + glow_pad * 2,
                                gold, -1, 10)
            blend = 0.12 + pulse * 0.12
            cv2.addWeighted(overlay_glow, blend, frame, 1 - blend, 0, frame)

        # 注视候选：未锁定 → 淡金色外框提示
        elif is_candidate:
            glow_pad = 2
            overlay_glow = frame.copy()
            gold_dim = (0, 160, 200)  # 暗金
            _draw_rounded_rect(overlay_glow, x - glow_pad, y - glow_pad,
                                w + glow_pad * 2, h + glow_pad * 2,
                                gold_dim, -1, 10)
            cv2.addWeighted(overlay_glow, 0.10, frame, 0.90, 0, frame)

        if card.has_bubble:
            # --- 气泡内容卡片 ---
            fill_color = tuple(max(c // 3, 15) for c in card.bubble_color)
            _draw_rounded_rect(frame, x, y, w, h, fill_color, -1, 8)

            # 边框用气泡颜色
            border = (0, 255, 0) if is_hover else card.bubble_color
            thickness = 2 if is_hover else 1
            _draw_rounded_rect(frame, x, y, w, h, border, thickness, 8)

            # 标题
            title_font = base_font * 0.9
            tt_size = cv2.getTextSize(card.bubble_title, cv2.FONT_HERSHEY_SIMPLEX,
                                       title_font, 1)[0]
            tt_x = x + (w - tt_size[0]) // 2
            tt_y = y + h // 3 + tt_size[1] // 2
            cv2.putText(frame, card.bubble_title, (tt_x, tt_y),
                        cv2.FONT_HERSHEY_SIMPLEX, title_font, card.bubble_color, 1)

            # 内容第一行
            content_line = card.bubble_content.split('\n')[0] if card.bubble_content else ""
            if content_line:
                small_font = base_font * 0.6
                ct_size = cv2.getTextSize(content_line, cv2.FONT_HERSHEY_SIMPLEX,
                                           small_font, 1)[0]
                ct_x = x + (w - ct_size[0]) // 2
                ct_y = y + h * 2 // 3 + ct_size[1] // 2
                cv2.putText(frame, content_line, (ct_x, ct_y),
                            cv2.FONT_HERSHEY_SIMPLEX, small_font, (200, 200, 200), 1)
        else:
            # --- 普通卡片 ---
            fill_color = card.color
            _draw_rounded_rect(frame, x, y, w, h, fill_color, -1, 8)

            if is_hover:
                border = (0, 255, 0)
                thickness = 2
            else:
                border = card.border_color
                thickness = 1
            _draw_rounded_rect(frame, x, y, w, h, border, thickness, 8)

            # 文字（居中）
            font_scale = base_font
            text_size = cv2.getTextSize(card.label, cv2.FONT_HERSHEY_SIMPLEX,
                                         font_scale, 2)[0]
            text_x = x + (w - text_size[0]) // 2
            text_y = y + (h + text_size[1]) // 2
            cv2.putText(frame, card.label,
                        (text_x, text_y),
                        cv2.FONT_HERSHEY_SIMPLEX, font_scale, (255, 255, 255), 2)

        # 放置目标：脉冲边框叠加（在卡片内容之后绘制）
        if is_drop_target:
            pulse = 0.5 + 0.5 * math.sin(time.time() * 6.0)
            thick = 2 + int(pulse)
            _draw_rounded_rect(frame, x - 1, y - 1, w + 2, h + 2,
                                (0, 255, 255), thick, 9)
        # 注视候选已锁定：金色边框叠加（在卡片内容之后绘制）
        elif candidate_locked:
            pulse = 0.5 + 0.5 * math.sin(time.time() * 4.0)
            thick = 2 + int(pulse)
            _draw_rounded_rect(frame, x - 1, y - 1, w + 2, h + 2,
                                (0, 200, 255), thick, 9)  # 金色 BGR


def get_slot_xy(desk: Desktop, slot_idx: int, card_w: int, card_h: int) -> tuple:
    """计算桌面内某个槽位的 (x, y) 坐标"""
    padding = 10
    gap_between = 10
    sx = desk.x + padding + slot_idx * (card_w + gap_between)
    sy = desk.y + (desk.h - card_h) // 2
    return sx, sy


def handle_card_swap(cards: list[Card], desktops: list[Desktop],
                     dragging_card: Optional[Card]):
    """
    手机桌面式卡片交互：
    - 拖拽卡片覆盖到其他卡片的槽位时，两张卡片交换槽位
    - 非拖拽卡片平滑动画到各自的槽位位置
    - 卡片在高度方向锁定在桌面内
    """
    LERP_SPEED = 0.25  # 平滑插值速度

    if dragging_card is not None:
        # 检测拖拽卡片中心是否覆盖了其他卡片的槽位
        dcx = dragging_card.x + dragging_card.w // 2
        dcy = dragging_card.y + dragging_card.h // 2

        for card in cards:
            if card is dragging_card:
                continue
            # 计算该卡片的槽位位置
            desk = desktops[card.desktop_index]
            tx, ty = get_slot_xy(desk, card.slot_index, card.w, card.h)
            # 缩小检测区域避免边界抖动
            mx = card.w * 0.15
            my = card.h * 0.15
            if (tx + mx <= dcx <= tx + card.w - mx and
                    ty + my <= dcy <= ty + card.h - my):
                # 交换槽位分配
                dragging_card.desktop_index, card.desktop_index = \
                    card.desktop_index, dragging_card.desktop_index
                dragging_card.slot_index, card.slot_index = \
                    card.slot_index, dragging_card.slot_index
                break

    # 非拖拽卡片平滑移动到各自的槽位
    for card in cards:
        if card is dragging_card:
            continue
        desk = desktops[card.desktop_index]
        tx, ty = get_slot_xy(desk, card.slot_index, card.w, card.h)

        dx = tx - card.x
        dy = ty - card.y
        if abs(dx) <= 2:
            card.x = tx
        else:
            step = max(1, int(abs(dx) * LERP_SPEED))
            card.x += step if dx > 0 else -step
        if abs(dy) <= 2:
            card.y = ty
        else:
            step = max(1, int(abs(dy) * LERP_SPEED))
            card.y += step if dy > 0 else -step


def draw_cards(frame: np.ndarray, cards: list[Card], drag_mgr: DragManager,
               attn_state=None):
    """绘制所有卡片（被拖拽的最后绘制，确保在最上层）"""
    # 先画非拖拽卡片
    for card in cards:
        if card is drag_mgr.dragging_card:
            continue
        is_hover = (card is drag_mgr.hover_card)
        is_target = (card is drag_mgr.drop_target_card)
        # 注视候选状态
        is_cand = False
        cand_locked = False
        if attn_state is not None and attn_state.candidate_card is card:
            is_cand = True
            cand_locked = attn_state.candidate_locked
        draw_card(frame, card, is_hover, False, is_target, is_cand, cand_locked)

    # 最后画拖拽中的卡片（在最上层）
    if drag_mgr.dragging_card is not None:
        draw_card(frame, drag_mgr.dragging_card, False, True)


def draw_bubble(frame: np.ndarray, bubble: Bubble, now: float,
                is_candidate: bool = False, candidate_locked: bool = False):
    """绘制单个气泡（半透明圆 + 浮动动画 + 淡出 + 捏住动效 + 注视候选高亮）"""
    alpha = bubble.alpha(now)
    if alpha <= 0:
        return

    age = now - bubble.spawn_time
    cx = bubble.cx
    cy = bubble.cy
    r = bubble.radius

    if bubble.being_dragged:
        # === 被捏住状态：椭圆挤压 + 脉冲光圈 ===
        squeeze_x = 0.80  # 水平压缩
        squeeze_y = 1.18  # 垂直拉伸
        rx = int(r * squeeze_x)
        ry = int(r * squeeze_y)

        pulse = 0.5 + 0.5 * math.sin(now * 6.0)

        # 外发光光圈（脉冲呼吸）
        glow_overlay = frame.copy()
        glow_rx = rx + 6
        glow_ry = ry + 6
        cv2.ellipse(glow_overlay, (cx, cy), (glow_rx, glow_ry), 0, 0, 360,
                     (255, 255, 255), -1)
        glow_blend = 0.08 + pulse * 0.10
        cv2.addWeighted(glow_overlay, glow_blend, frame, 1 - glow_blend, 0, frame)

        # 半透明椭圆填充
        overlay = frame.copy()
        cv2.ellipse(overlay, (cx, cy), (rx, ry), 0, 0, 360, bubble.color, -1)
        blend = alpha * 0.65
        cv2.addWeighted(overlay, blend, frame, 1 - blend, 0, frame)

        # 白色脉冲边框
        border_thick = 2 + int(pulse)
        cv2.ellipse(frame, (cx, cy), (rx, ry), 0, 0, 360,
                     (255, 255, 255), border_thick)

    elif candidate_locked:
        # === 注视锁定候选：金色脉冲 + 高频蹦跳 ===
        # 加速蹦跳：频率 5Hz，振幅 12px
        bounce_y = int(abs(math.sin(age * 5.0)) * 12)
        cy = cy - bounce_y  # 向上蹦

        pulse = 0.5 + 0.5 * math.sin(now * 8.0)

        # 外层金色发光光圈（脉冲呼吸）
        glow_overlay = frame.copy()
        glow_r = r + 8 + int(pulse * 4)
        gold_color = (0, 200, 255)  # BGR: 金黄色
        cv2.circle(glow_overlay, (cx, cy), glow_r, gold_color, -1)
        glow_blend = 0.12 + pulse * 0.10
        cv2.addWeighted(glow_overlay, glow_blend, frame, 1 - glow_blend, 0, frame)

        # 半透明圆形填充（比普通更亮更实）
        overlay = frame.copy()
        bright_color = tuple(min(c + 80, 255) for c in bubble.color)
        cv2.circle(overlay, (cx, cy), r, bright_color, -1)
        blend = alpha * 0.85
        cv2.addWeighted(overlay, blend, frame, 1 - blend, 0, frame)

        # 金色脉冲边框
        border_thick = 2 + int(pulse * 2)
        cv2.circle(frame, (cx, cy), r, gold_color, border_thick)

        # 向下箭头 ▼（气泡上方，表示"被盯上了"）
        arrow_color = (0, 200, 255)  # BGR: 金色
        arrow_tip_y = cy - r - 6
        arrow_top_y = arrow_tip_y - 16
        arrow_half_w = 8
        pts = np.array([
            [cx, arrow_tip_y],
            [cx - arrow_half_w, arrow_top_y],
            [cx + arrow_half_w, arrow_top_y],
        ], dtype=np.int32)
        cv2.fillPoly(frame, [pts], arrow_color)
        cv2.polylines(frame, [pts], True, (255, 255, 255), 1)

    elif is_candidate:
        # === 注视候选（未锁定）：淡金色提示 + 稍大蹦跳 ===
        # 稍快蹦跳：频率 3Hz，振幅 8px
        bounce_y = int(math.sin(age * 3.0) * 8)
        cy = cy + bounce_y

        # 淡金色外圈提示
        glow_overlay = frame.copy()
        glow_r = r + 4
        dark_gold = (0, 160, 200)  # BGR: 暗金色
        cv2.circle(glow_overlay, (cx, cy), glow_r, dark_gold, -1)
        cv2.addWeighted(glow_overlay, 0.10, frame, 0.90, 0, frame)

        # 半透明圆形填充
        overlay = frame.copy()
        cv2.circle(overlay, (cx, cy), r, bubble.color, -1)
        blend = alpha * 0.60
        cv2.addWeighted(overlay, blend, frame, 1 - blend, 0, frame)

        # 淡金色边框
        cv2.circle(frame, (cx, cy), r, dark_gold, 2)

    else:
        # === 普通状态：圆形 + 浮动 + 淡出 ===
        bob_y = int(math.sin(age * 2.0) * 5)
        cy = cy + bob_y

        # 半透明圆形填充
        overlay = frame.copy()
        cv2.circle(overlay, (cx, cy), r, bubble.color, -1)
        blend = alpha * 0.55
        cv2.addWeighted(overlay, blend, frame, 1 - blend, 0, frame)

        # 外圈边框
        border_color = tuple(min(c + 60, 255) for c in bubble.color)
        cv2.circle(frame, (cx, cy), r, border_color, 1)

    # 标题文字（所有状态共用）
    font_scale = r / 80.0
    text_size = cv2.getTextSize(bubble.title, cv2.FONT_HERSHEY_SIMPLEX,
                                 font_scale, 1)[0]
    tx = cx - text_size[0] // 2
    ty = cy + text_size[1] // 2
    cv2.putText(frame, bubble.title, (tx, ty),
                cv2.FONT_HERSHEY_SIMPLEX, font_scale, (255, 255, 255), 1)


def draw_bubbles(frame: np.ndarray, bubble_mgr: 'BubbleManager',
                 dragging_bubble: Optional[Bubble] = None,
                 attn_state=None):
    """绘制所有气泡（拖拽中的最后绘制，含注视候选高亮）"""
    now = time.time()
    # 从 attn_state 取出候选气泡信息
    cand_bubble = attn_state.candidate_bubble if attn_state else None
    cand_locked = attn_state.candidate_bubble_locked if attn_state else False

    for bubble in bubble_mgr.bubbles:
        if bubble is dragging_bubble:
            continue
        is_cand = (bubble is cand_bubble) if cand_bubble is not None else False
        is_locked = is_cand and cand_locked
        draw_bubble(frame, bubble, now,
                    is_candidate=is_cand, candidate_locked=is_locked)

    # 拖拽中的气泡最后画（最上层）
    if dragging_bubble is not None:
        draw_bubble(frame, dragging_bubble, now)


def drop_bubble_on_desktop(bubble: Bubble, cards: list[Card],
                           desktops: list[Desktop]) -> bool:
    """
    尝试将气泡放到桌面上，替换最近的卡片。
    返回是否成功放置。
    """
    # 找到气泡中心所在的桌面
    desk_idx = find_desktop_at(desktops, bubble.cx, bubble.cy)
    if desk_idx < 0:
        return False

    desk = desktops[desk_idx]

    # 找该桌面上最近的卡片
    best_card = None
    best_dist = float('inf')
    for card in cards:
        if card.desktop_index != desk_idx:
            continue
        slot_x, slot_y = get_slot_xy(desk, card.slot_index, card.w, card.h)
        card_cx = slot_x + card.w // 2
        card_cy = slot_y + card.h // 2
        dx = bubble.cx - card_cx
        dy = bubble.cy - card_cy
        dist = dx * dx + dy * dy
        if dist < best_dist:
            best_dist = dist
            best_card = card

    if best_card is None:
        return False

    # 替换卡片内容
    best_card.has_bubble = True
    best_card.bubble_title = bubble.title
    best_card.bubble_content = bubble.content
    best_card.bubble_color = bubble.color
    return True


def draw_debug_overlay(
    frame: np.ndarray,
    hand_detected: bool,
    phase: GesturePhase,
    pinch_ratio: float,
    is_grabbing: bool,
    smooth_center: Optional[np.ndarray],
    fps: float,
    attn_state=None,
    gaze_result=None,
    show_gaze: bool = True,
):
    """绘制调试信息叠加层（含注视 & 注意力状态）"""
    y_offset = 30
    line_h = 28

    def put(text: str, color=(255, 255, 255)):
        nonlocal y_offset
        cv2.putText(frame, text, (15, y_offset),
                     cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)
        y_offset += line_h

    # FPS
    put(f"FPS: {fps:.0f}", (200, 200, 200))

    # 手部检测状态
    if hand_detected:
        put("Hand: DETECTED", (0, 255, 0))
    else:
        put("Hand: LOST", (0, 0, 255))

    # Pinch ratio
    ratio_color = (0, 255, 255) if pinch_ratio < 0.4 else (200, 200, 200)
    put(f"Pinch Ratio: {pinch_ratio:.3f}", ratio_color)

    # 状态
    phase_colors = {
        GesturePhase.IDLE: (150, 150, 150),
        GesturePhase.HOVERING: (200, 200, 0),
        GesturePhase.PINCHING: (0, 255, 0),
        GesturePhase.RELEASED: (0, 150, 255),
    }
    put(f"State: {phase.value}", phase_colors.get(phase, (255, 255, 255)))

    # 是否抓住卡片
    if is_grabbing:
        put("Grabbing: YES", (0, 255, 255))
    else:
        put("Grabbing: NO", (150, 150, 150))

    # Pinch 中点坐标
    if smooth_center is not None:
        cx, cy = int(smooth_center[0]), int(smooth_center[1])
        put(f"Pinch Pos: ({cx}, {cy})", (0, 255, 0))

    # ============================================================
    # 右侧：注视 & 注意力调试面板
    # ============================================================
    if show_gaze:
        frame_w = frame.shape[1]
        rx = frame_w - 300  # 右侧面板起始 x
        ry = 30
        rline_h = 24

        def put_r(text: str, color=(255, 255, 255)):
            nonlocal ry
            cv2.putText(frame, text, (rx, ry),
                         cv2.FONT_HERSHEY_SIMPLEX, 0.50, color, 1)
            ry += rline_h

        put_r("--- Gaze & Attention ---", (180, 180, 180))

        if gaze_result is not None:
            # 面部检测
            if gaze_result.face_detected:
                put_r("Face: DETECTED", (0, 255, 0))
            else:
                put_r("Face: LOST", (0, 0, 255))

            # 注视方向
            dir_label = gaze_result.direction_label
            dir_colors = {
                "LEFT": (255, 150, 50),
                "CENTER-L": (200, 200, 100),
                "CENTER": (100, 255, 100),
                "CENTER-R": (200, 200, 100),
                "RIGHT": (255, 150, 50),
            }
            put_r(f"Gaze Dir: {dir_label}",
                  dir_colors.get(dir_label, (200, 200, 200)))

            # 水平注视
            put_r(f"Gaze X: {gaze_result.gaze_x:+.2f}", (200, 200, 200))

            # 垂直注视
            dir_label_y = gaze_result.direction_label_y
            dir_colors_y = {
                "UP": (255, 150, 50),
                "CENTER-U": (200, 200, 100),
                "CENTER": (100, 255, 100),
                "CENTER-D": (200, 200, 100),
                "DOWN": (255, 150, 50),
            }
            put_r(f"Gaze Y: {gaze_result.gaze_y:+.2f}  [{dir_label_y}]",
                  dir_colors_y.get(dir_label_y, (200, 200, 200)))

            # 可信度
            conf = gaze_result.confidence
            conf_color = (0, 255, 0) if conf > 0.5 else (0, 200, 255) if conf > 0.25 else (0, 0, 255)
            put_r(f"Confidence: {conf:.2f}", conf_color)

            # 头部 vs 虹膜分量（X + Y）
            put_r(f"Head: X{gaze_result.head_direction:+.2f} "
                  f"Y{gaze_result.head_direction_y:+.2f}  "
                  f"Iris: X{gaze_result.iris_direction:+.2f} "
                  f"Y{gaze_result.iris_direction_y:+.2f}", (150, 150, 150))

            # 绘制虹膜标记
            if gaze_result.left_iris is not None:
                cv2.circle(frame, gaze_result.left_iris, 3, (0, 255, 255), -1)
            if gaze_result.right_iris is not None:
                cv2.circle(frame, gaze_result.right_iris, 3, (0, 255, 255), -1)
            # 鼻尖标记
            if gaze_result.nose_tip is not None:
                cv2.circle(frame, gaze_result.nose_tip, 3, (0, 200, 200), -1)

        if attn_state is not None:
            ry += 4  # 间隔
            put_r(f"Mode: {attn_state.mode}", (180, 180, 180))

            # 候选卡片
            if attn_state.candidate_card is not None:
                card_label = attn_state.candidate_card.label
                if attn_state.candidate_locked:
                    put_r(f"Candidate: {card_label} [LOCKED]", (0, 200, 255))
                else:
                    prog = attn_state.lock_progress
                    put_r(f"Candidate: {card_label} ({prog:.0%})", (0, 160, 200))

                    # 锁定进度条
                    bar_x = rx
                    bar_y = ry
                    bar_w = 160
                    bar_h = 10
                    cv2.rectangle(frame, (bar_x, bar_y),
                                  (bar_x + bar_w, bar_y + bar_h),
                                  (60, 60, 60), -1)
                    fill_w = int(bar_w * prog)
                    if fill_w > 0:
                        cv2.rectangle(frame, (bar_x, bar_y),
                                      (bar_x + fill_w, bar_y + bar_h),
                                      (0, 200, 255), -1)
                    ry += rline_h
            else:
                put_r("Candidate: None", (100, 100, 100))

            # 评分排名（前 3）
            if attn_state.scores:
                sorted_scores = sorted(attn_state.scores.items(),
                                       key=lambda x: x[1], reverse=True)[:3]
                score_text = "  ".join(f"{lbl}:{s:.2f}" for lbl, s in sorted_scores)
                put_r(f"Top: {score_text}", (120, 120, 120))

    # 操作提示
    h = frame.shape[0]
    cv2.putText(frame, "ESC: Quit | R: Reset | G: Toggle Gaze | C: Recalibrate",
                (15, h - 15), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (150, 150, 150), 1)
