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


# ================================================================
# 拖拽管理
# ================================================================

class DragManager:
    """拖拽管理器"""

    def __init__(self):
        self.dragging_card: Optional[Card] = None
        self.offset_x: float = 0.0
        self.offset_y: float = 0.0
        self.hover_card: Optional[Card] = None

    def try_grab(self, cards: list[Card], px: float, py: float) -> bool:
        """尝试抓住卡片。返回是否成功抓住。"""
        if self.dragging_card is not None:
            return True  # 已经在拖拽

        # 从上到下检测（后绘制的在上面）
        for card in reversed(cards):
            if card.contains(int(px), int(py)):
                self.dragging_card = card
                self.offset_x = card.x - px
                self.offset_y = card.y - py
                return True
        return False

    def update_drag(self, px: float, py: float):
        """更新拖拽位置"""
        if self.dragging_card is not None:
            self.dragging_card.x = int(px + self.offset_x)
            self.dragging_card.y = int(py + self.offset_y)

    def release(self):
        """释放拖拽"""
        self.dragging_card = None
        self.offset_x = 0.0
        self.offset_y = 0.0

    def update_hover(self, cards: list[Card], px: float, py: float):
        """更新 hover 状态（pinch 点靠近哪张卡片）"""
        self.hover_card = None
        for card in reversed(cards):
            if card.contains(int(px), int(py)):
                self.hover_card = card
                break


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


def draw_card(frame: np.ndarray, card: Card, is_hover: bool, is_dragging: bool):
    """绘制单张卡片（支持拖拽放大 + 阴影）"""
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

        # --- 绘制阴影（半透明） ---
        sdx, sdy = SHADOW_OFFSET
        overlay = frame.copy()
        _draw_rounded_rect(overlay, sx + sdx, sy + sdy, sw, sh, SHADOW_COLOR, -1, 10)
        cv2.addWeighted(overlay, SHADOW_ALPHA, frame, 1 - SHADOW_ALPHA, 0, frame)

        # 填充（提亮）
        fill_color = tuple(min(c + 50, 255) for c in card.color)
        _draw_rounded_rect(frame, sx, sy, sw, sh, fill_color, -1, 10)

        # 边框 - 黄色发光
        _draw_rounded_rect(frame, sx, sy, sw, sh, (0, 255, 255), 2, 10)

        # 文字
        font_scale = base_font * scale
        text_size = cv2.getTextSize(card.label, cv2.FONT_HERSHEY_SIMPLEX,
                                     font_scale, 2)[0]
        text_x = sx + (sw - text_size[0]) // 2
        text_y = sy + (sh + text_size[1]) // 2
        cv2.putText(frame, card.label,
                    (text_x, text_y),
                    cv2.FONT_HERSHEY_SIMPLEX, font_scale, (0, 255, 255), 2)
    else:
        x, y, w, h = card.x, card.y, card.w, card.h
        fill_color = card.color

        _draw_rounded_rect(frame, x, y, w, h, fill_color, -1, 8)

        # 边框
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


def draw_cards(frame: np.ndarray, cards: list[Card], drag_mgr: DragManager):
    """绘制所有卡片（被拖拽的最后绘制，确保在最上层）"""
    # 先画非拖拽卡片
    for card in cards:
        if card is drag_mgr.dragging_card:
            continue
        is_hover = (card is drag_mgr.hover_card)
        draw_card(frame, card, is_hover, False)

    # 最后画拖拽中的卡片（在最上层）
    if drag_mgr.dragging_card is not None:
        draw_card(frame, drag_mgr.dragging_card, False, True)


def draw_debug_overlay(
    frame: np.ndarray,
    hand_detected: bool,
    phase: GesturePhase,
    pinch_ratio: float,
    is_grabbing: bool,
    smooth_center: Optional[np.ndarray],
    fps: float,
):
    """绘制调试信息叠加层"""
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

    # 操作提示
    h = frame.shape[0]
    cv2.putText(frame, "ESC: Quit | R: Reset Cards",
                (15, h - 15), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (150, 150, 150), 1)
