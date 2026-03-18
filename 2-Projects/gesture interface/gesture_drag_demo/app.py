"""
app.py - 手势拖拽 Demo 主循环

使用 OpenCV 窗口 + MediaPipe Hands 实现：
- 摄像头实时画面
- 手部关键点检测
- Pinch（捏住）/ Release（松开）状态判定
- 4 个底部桌面 + 12 张卡片
- 拖拽卡片交互（支持跨桌面）
"""

import cv2
import time
import numpy as np

from hand_tracker import HandTracker
from gesture_state import GestureStateMachine, GesturePhase
from ui import (
    create_desktops, create_desktop_cards, draw_desktops,
    draw_cards, draw_debug_overlay, handle_card_swap,
    find_desktop_at, DragManager, BubbleManager,
    draw_bubbles, drop_bubble_on_desktop,
)


# ============================================================
# 可调参数集中配置区（修改这里即可调节行为）
# ============================================================

CAMERA_INDEX = 0            # 摄像头索引
CAMERA_WIDTH = 1280          # 摄像头宽度
CAMERA_HEIGHT = 720          # 摄像头高度
MAX_NUM_HANDS = 1            # 最大检测手数

PINCH_ON_THRESHOLD = 0.33   # pinch_ratio 低于此值视为"捏住"
PINCH_OFF_THRESHOLD = 0.45  # pinch_ratio 高于此值视为"松开"
CONFIRM_FRAMES = 3           # 连续多少帧确认后才切换状态
LOST_FRAMES_RELEASE = 5     # 丢手多少帧后自动释放
SMOOTHING_ALPHA = 0.6        # EMA 平滑系数（越大越跟手，越小越平滑）

WINDOW_NAME = "Gesture Drag Demo"

# ============================================================


def main():
    print("=" * 50)
    print("  Gesture Drag Demo")
    print("  4 Desktops x 3 Cards = 12 Cards")
    print("  ESC: 退出 | R: 重置卡片位置")
    print("=" * 50)

    # 初始化手部追踪器
    tracker = HandTracker(
        camera_index=CAMERA_INDEX,
        width=CAMERA_WIDTH,
        height=CAMERA_HEIGHT,
        max_num_hands=MAX_NUM_HANDS,
    )
    print(f"摄像头已打开: {tracker.frame_w}x{tracker.frame_h}")

    # 初始化状态机
    gesture = GestureStateMachine(
        pinch_on_threshold=PINCH_ON_THRESHOLD,
        pinch_off_threshold=PINCH_OFF_THRESHOLD,
        confirm_frames=CONFIRM_FRAMES,
        lost_frames_release=LOST_FRAMES_RELEASE,
        smoothing_alpha=SMOOTHING_ALPHA,
    )

    # 初始化桌面和卡片
    desktops = create_desktops(tracker.frame_w, tracker.frame_h)
    cards = create_desktop_cards(desktops)
    drag_mgr = DragManager()

    # 初始化气泡管理器
    desktop_top_y = desktops[0].y  # 桌面顶部 y 坐标
    bubble_mgr = BubbleManager(tracker.frame_w, tracker.frame_h, desktop_top_y)

    print(f"已创建 {len(desktops)} 个桌面, {len(cards)} 张卡片")
    print(f"气泡区域: y=[80, {desktop_top_y - 30}]")
    for d in desktops:
        print(f"  桌面 {d.index + 1}: ({d.x}, {d.y}) {d.w}x{d.h}")

    # FPS 计算
    prev_time = time.time()
    fps = 0.0

    # 创建窗口
    cv2.namedWindow(WINDOW_NAME, cv2.WINDOW_NORMAL)
    cv2.resizeWindow(WINDOW_NAME, tracker.frame_w, tracker.frame_h)

    try:
        while True:
            # 读取一帧
            frame = tracker.read_frame()
            if frame is None:
                print("摄像头读取失败")
                break

            # 手部检测
            hand_data = tracker.detect(frame)
            hand_detected = hand_data is not None

            # 更新状态机
            if hand_detected:
                gesture.update(
                    hand_detected=True,
                    pinch_ratio=hand_data.pinch_ratio,
                    raw_center=hand_data.pinch_center,
                )
            else:
                gesture.update(hand_detected=False)

            # --- 气泡更新 ---
            bubble_mgr.update()

            # --- 拖拽逻辑 ---
            smooth = gesture.smooth_center

            if gesture.phase == GesturePhase.PINCHING and smooth is not None:
                px, py = float(smooth[0]), float(smooth[1])
                if not drag_mgr.is_dragging:
                    # 先尝试抓气泡（气泡在最上层），再尝试抓卡片
                    if not drag_mgr.try_grab_bubble(bubble_mgr.bubbles, px, py):
                        drag_mgr.try_grab(cards, px, py)
                else:
                    # 更新拖拽位置
                    drag_mgr.update_drag(px, py)

            elif gesture.phase == GesturePhase.RELEASED:
                released_bubble = drag_mgr.release()
                # 如果释放了气泡，检查是否落在桌面上
                if released_bubble is not None:
                    if drop_bubble_on_desktop(released_bubble, cards, desktops):
                        bubble_mgr.remove(released_bubble)
                    # else: 气泡没落在桌面上，自然消失

            elif gesture.phase == GesturePhase.IDLE:
                released_bubble = drag_mgr.release()
                if released_bubble is not None:
                    if drop_bubble_on_desktop(released_bubble, cards, desktops):
                        bubble_mgr.remove(released_bubble)

            # 更新 hover 状态
            if smooth is not None and not drag_mgr.is_dragging:
                drag_mgr.update_hover(cards, float(smooth[0]), float(smooth[1]))
            elif not drag_mgr.is_dragging:
                drag_mgr.hover_card = None

            # --- 卡片物理：交叠挤压 ---
            handle_card_swap(cards, desktops, drag_mgr.dragging_card)

            # --- 气泡放置目标检测 ---
            drag_mgr.update_drop_target(cards, desktops)

            # --- 绘制 ---

            # 1. 绘制桌面背景（黑色区域）
            #    拖拽卡片或气泡时，高亮目标桌面
            highlight_idx = -1
            if drag_mgr.dragging_card is not None:
                dc = drag_mgr.dragging_card
                card_cx = dc.x + dc.w // 2
                card_cy = dc.y + dc.h // 2
                highlight_idx = find_desktop_at(desktops, card_cx, card_cy)
            elif drag_mgr.dragging_bubble is not None:
                highlight_idx = find_desktop_at(
                    desktops, drag_mgr.dragging_bubble.cx,
                    drag_mgr.dragging_bubble.cy)

            draw_desktops(frame, desktops, highlight_idx)

            # 2. 绘制卡片
            draw_cards(frame, cards, drag_mgr)

            # 3. 绘制气泡（在卡片之上）
            draw_bubbles(frame, bubble_mgr, drag_mgr.dragging_bubble)

            # 4. 绘制手部关键点
            if hand_detected:
                tracker.draw_landmarks(frame, hand_data)

            # 5. 绘制平滑后的 pinch 中点
            if smooth is not None:
                cv2.circle(frame, (int(smooth[0]), int(smooth[1])), 12, (255, 0, 255), 2)

            # 计算 FPS
            now = time.time()
            dt = now - prev_time
            if dt > 0:
                fps = 0.9 * fps + 0.1 * (1.0 / dt)
            prev_time = now

            # 6. 绘制调试信息
            draw_debug_overlay(
                frame,
                hand_detected=hand_detected,
                phase=gesture.phase,
                pinch_ratio=gesture.pinch_ratio,
                is_grabbing=drag_mgr.is_dragging,
                smooth_center=smooth,
                fps=fps,
            )

            # 显示画面
            cv2.imshow(WINDOW_NAME, frame)

            # 按键处理
            key = cv2.waitKey(1) & 0xFF
            if key == 27:  # ESC
                print("用户按下 ESC，退出")
                break
            elif key == ord('r') or key == ord('R'):
                # 重置卡片位置和气泡
                for card in cards:
                    card.reset()
                drag_mgr.release()
                gesture.reset()
                bubble_mgr.bubbles.clear()
                print("卡片位置已重置")

    finally:
        tracker.release()
        cv2.destroyAllWindows()
        print("资源已释放，程序退出")


if __name__ == "__main__":
    main()
