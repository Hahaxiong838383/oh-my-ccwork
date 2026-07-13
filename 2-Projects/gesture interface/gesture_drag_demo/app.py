"""
app.py - 手势拖拽 Demo 主循环 (v3.1)

使用 OpenCV 窗口 + MediaPipe Hands + FaceMesh 实现：
- 摄像头实时画面
- 手部关键点检测 + 面部注视方向估计
- 面部特征识别：眨眼检测、EAR、面部朝向、表情线索
- Pinch（捏住）/ Release（松开）状态判定
- 注视候选卡片预选（看哪里 → 高亮哪张）
- 4 个底部桌面 + 12 张卡片
- 拖拽卡片交互（注视预选 + pinch 融合）
"""

import cv2
import time
import numpy as np

from hand_tracker import HandTracker
from gesture_state import GestureStateMachine, GesturePhase
from gaze_estimator import GazeEstimator
from attention_selector import AttentionSelector
from face_tracker import FaceTracker
from calibration import run_calibration
from ui import (
    create_desktops, create_desktop_cards, draw_desktops,
    draw_cards, draw_debug_overlay, handle_card_swap,
    find_desktop_at, DragManager, BubbleManager,
    draw_bubbles, drop_bubble_on_desktop,
    draw_face_features,
)
from config import (
    CAMERA_INDEX, CAMERA_WIDTH, CAMERA_HEIGHT,
    MAX_NUM_HANDS, PINCH_ON_THRESHOLD, PINCH_OFF_THRESHOLD,
    CONFIRM_FRAMES, LOST_FRAMES_RELEASE, SMOOTHING_ALPHA,
    WINDOW_NAME,
)


def main():
    print("=" * 50)
    print("  Gesture Drag Demo v3.1")
    print("  4 Desktops x 3 Cards = 12 Cards")
    print("  ESC: 退出 | R: 重置 | G: 注视调试")
    print("  F: 面部特征 | C: 重新校准")
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

    # 初始化注视估计器 & 候选选择器 & 面部特征追踪器
    gaze_est = GazeEstimator()
    attn_sel = AttentionSelector(tracker.frame_w)
    face_trk = FaceTracker()
    show_gaze_debug = True   # 'G' 键切换注视调试可视化
    show_face_debug = True   # 'F' 键切换面部特征可视化
    print("注视估计器 + 面部特征追踪器已初始化")

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

    # 启动校准（可按 ESC/S 跳过）
    run_calibration(tracker, gaze_est, WINDOW_NAME)

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

            # --- 注视估计 ---
            gaze_result = gaze_est.update(frame)

            # --- 面部特征追踪（复用 gaze_est 的 FaceMesh 结果）---
            face_features = face_trk.update(
                gaze_result.face_landmarks,
                tracker.frame_w, tracker.frame_h,
            )

            # --- 注视候选更新 ---
            attn_sel.set_dragging(drag_mgr.is_dragging)
            attn_state = attn_sel.update(
                gaze_x=gaze_result.gaze_x,
                confidence=gaze_result.confidence,
                cards=cards,
                direction_label=gaze_result.direction_label,
            )

            # --- 气泡更新 ---
            bubble_mgr.update()

            # --- 气泡注视候选更新 ---
            attn_sel.update_bubbles(
                gaze_x=gaze_result.gaze_x,
                confidence=gaze_result.confidence,
                bubbles=bubble_mgr.bubbles,
            )
            # 同步气泡候选到 attn_state（update_bubbles 直接修改内部状态，
            # 但 attn_state 快照在 update() 时已生成，需要补刷）
            attn_state.candidate_bubble = attn_sel._bubble_candidate
            attn_state.candidate_bubble_locked = attn_sel._bubble_locked
            attn_state.bubble_lock_progress = min(
                1.0, attn_sel._bubble_lock_count / max(1, 5))

            # --- 拖拽逻辑 ---
            smooth = gesture.smooth_center

            if gesture.phase == GesturePhase.PINCHING and smooth is not None:
                px, py = float(smooth[0]), float(smooth[1])
                if not drag_mgr.is_dragging:
                    grabbed = False
                    # 优先级 1：注视锁定的气泡
                    if (attn_state.candidate_bubble_locked
                            and attn_state.candidate_bubble is not None):
                        bubble = attn_state.candidate_bubble
                        drag_mgr.dragging_bubble = bubble
                        bubble.being_dragged = True
                        drag_mgr.offset_x = bubble.cx - px
                        drag_mgr.offset_y = bubble.cy - py
                        grabbed = True
                    # 优先级 2：位置命中气泡
                    if not grabbed:
                        grabbed = drag_mgr.try_grab_bubble(
                            bubble_mgr.bubbles, px, py)
                    # 优先级 3：注视锁定的卡片
                    if not grabbed:
                        if (attn_state.candidate_locked
                                and attn_state.candidate_card is not None):
                            card = attn_state.candidate_card
                            drag_mgr.dragging_card = card
                            drag_mgr.offset_x = card.x - px
                            drag_mgr.offset_y = card.y - py
                            grabbed = True
                    # 优先级 4：位置命中卡片
                    if not grabbed:
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

            # 2. 绘制卡片（含注视候选高亮）
            draw_cards(frame, cards, drag_mgr, attn_state)

            # 3. 绘制气泡（在卡片之上，含注视候选高亮）
            draw_bubbles(frame, bubble_mgr, drag_mgr.dragging_bubble,
                         attn_state)

            # 4. 绘制面部特征（眼部轮廓、面部网格、虹膜追踪）
            if show_face_debug:
                draw_face_features(frame, face_features)

            # 5. 绘制手部关键点
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

            # 7. 绘制调试信息（含注视 & 注意力 & 面部特征状态）
            draw_debug_overlay(
                frame,
                hand_detected=hand_detected,
                phase=gesture.phase,
                pinch_ratio=gesture.pinch_ratio,
                is_grabbing=drag_mgr.is_dragging,
                smooth_center=smooth,
                fps=fps,
                attn_state=attn_state,
                gaze_result=gaze_result,
                show_gaze=show_gaze_debug,
                face_features=face_features if show_face_debug else None,
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
                attn_sel.reset()
                gaze_est.reset()
                face_trk.reset()
                bubble_mgr.bubbles.clear()
                print("卡片位置已重置")
            elif key == ord('g') or key == ord('G'):
                show_gaze_debug = not show_gaze_debug
                print(f"注视调试: {'ON' if show_gaze_debug else 'OFF'}")
            elif key == ord('f') or key == ord('F'):
                show_face_debug = not show_face_debug
                print(f"面部特征: {'ON' if show_face_debug else 'OFF'}")
            elif key == ord('c') or key == ord('C'):
                # 重新校准
                run_calibration(tracker, gaze_est, WINDOW_NAME)

    finally:
        tracker.release()
        gaze_est.close()
        cv2.destroyAllWindows()
        print("资源已释放，程序退出")


if __name__ == "__main__":
    main()
