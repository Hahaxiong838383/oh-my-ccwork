'use client'

import { useLayoutEffect, useRef } from 'react'
import type { FaceData, GazeData, HandData } from '@/components/lab/ar-hud-demo/MediaPipeStage'
import { interactionStore, type PinchPointer, type ScreenPoint } from './interaction-store'
import { OneEuroFilter2D } from './one-euro-filter'

export type { PinchPointer, ScreenPoint } from './interaction-store'

interface UseInteractionStateProps {
  hands: HandData[]
  gaze: GazeData
  face: FaceData
}

// 摄像头舒适伸手区映射：把摄像头视野中央 70% × 65% 区域映射到屏幕。
// 用户实际舒适伸手范围 ≠ 摄像头全视野（视野边缘需要伸手到极限位置才能触达）。
// 把舒适区拉伸到目标屏幕区域，让小幅度自然手部动作也能覆盖目标区，**操作精度大幅
// 提升**（边缘可达性 + 中心区域更敏锐）。
// 镜像 X：CAM FEED 用 scale-x-[-1] 翻转 video，MediaPipe 用原始帧，
// 这里翻转 landmark x 让光点位置和视觉一致。
const COMFORT_X_MIN = 0.15 // 舒适区左边界（摄像头归一化坐标）
const COMFORT_X_MAX = 0.85 // 舒适区右边界
const COMFORT_Y_MIN = 0.2 // 舒适区上边界（不用站姿伸到头顶）
const COMFORT_Y_MAX = 0.85 // 舒适区下边界（不用伸到腰下）

// 屏幕 Y 映射区间：摄像头视野映射到屏幕的下方区域（不是全屏）。
// 川哥实测反馈：PHUD 卡片在屏幕底部 ~85-94% 对应摄像头底部识别区域，
// 摄像头底部识别质量差（手部 landmark 检测不稳，丢帧），PHUD 操作体验差。
// 解法：屏幕端映射区间整体下移到 [0.32, 1.0]，让摄像头中部（识别质量极稳区）
// 即可触达 PHUD。屏幕 0~32% 是天空 / 远景，cursor 不可达不影响交互。
// 参数依据（gemini 钦定）：
//   - 0.32 = POI 卡片最高点（y≈46%）上方约 4 个 POI 卡片身位
//   - 1.0 留底：用户手 landmark 在 0.75 极稳区即可触达 PHUD，0.85 才贴底
//   - COMFORT_Y 不调（摄像头 0.65 行程映射屏幕 0.68 ≈ 1:1，手感最线性）
const SCREEN_MAP_Y_TOP = 0.32
const SCREEN_MAP_Y_BOTTOM = 1.0

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}

function landmarkToScreen(landmark: { x: number; y: number }): ScreenPoint {
  if (typeof window === 'undefined') return { x: 0, y: 0 }
  const nx = (landmark.x - COMFORT_X_MIN) / (COMFORT_X_MAX - COMFORT_X_MIN)
  const ny = (landmark.y - COMFORT_Y_MIN) / (COMFORT_Y_MAX - COMFORT_Y_MIN)
  const screenNy = SCREEN_MAP_Y_TOP + clamp01(ny) * (SCREEN_MAP_Y_BOTTOM - SCREEN_MAP_Y_TOP)
  return {
    x: clamp01(1 - nx) * window.innerWidth, // 镜像 X
    y: screenNy * window.innerHeight,
  }
}

// gaze: [-1, 1] → 屏幕坐标，加 1.2x 灵敏度
// 镜像 X：CAM FEED 用 scale-x-[-1] 翻转 video，但 MediaPipe 推理用原始帧，
// iris 坐标是非镜像的。这里翻转 gaze.x 让"头向右移 → 光点向右移"符合直觉。
// 之前是反向的（头右移 cursor 左移）。
function gazeToScreen(gaze: GazeData): ScreenPoint | null {
  if (typeof window === 'undefined' || !gaze) return null
  const sensitivity = 1.2
  const nx = 0.5 - gaze.x * 0.5 * sensitivity
  const ny = 0.5 + gaze.y * 0.5 * sensitivity
  return {
    x: Math.max(0, Math.min(1, nx)) * window.innerWidth,
    y: Math.max(0, Math.min(1, ny)) * window.innerHeight,
  }
}

// 写入 store，不再返回 state。下游通过 interactionStore.subscribe 监听。
// gemini + codex 共同建议：剥离 React state，每帧 setState 是延迟首恶。
// pinch 静止 deadzone：三段式（Vision Pro 行为对齐）
// - dist < HARD_LOCK：完全锁定 cursor = lastCursor（吃掉 landmark 1-3px 噪声）
// - HARD_LOCK ≤ dist < SOFT_ZONE：渐进 alpha 从 0 到 1（细腻拖动感）
// - dist ≥ SOFT_ZONE：直接用 smoothed（全速跟手，不粘滞）
// 川哥反馈：舒适区映射放大 1.43x 后噪声同等放大，HARD_LOCK 6→10 抵消。
const PINCH_HARD_LOCK_PX = 10
const PINCH_SOFT_ZONE_PX = 24

// pinch 触发后的"稳定窗口"：cursor 完全锁定 anchor 的帧数。
// 解决"pinch=true 触发不等于捏合完成"问题 — 触发后两指继续闭合 ~100-150ms，
// 中点仍在移动 10-20px。前 4 帧 (~130ms @ 30fps) cursor 锁定 + 每帧重置
// startCenter，让稳定窗口结束时 cursor 不跳（起点对齐当前 center）。
// 代价：用户立即拖卡片有 130ms 响应延迟；对"捏合不动"零影响。
const PINCH_STABILIZE_FRAMES = 4

export function useInteractionState({ hands, gaze, face }: UseInteractionStateProps): void {
  // OneEuroFilter 实例需要跨帧持有，用 useRef
  // 参数调优：minCutoff 提高让快动作跟手更紧，beta 提高让速度补偿更强。
  // 之前 (0.8, 0.012) 偏稳但延迟感重；现在 pinch (3.0, 0.08) 高速跟手不滞后。
  const filtersRef = useRef({
    gaze: new OneEuroFilter2D(1.5, 0.02, 1.0),
    pinchLeft: new OneEuroFilter2D(3.0, 0.08, 1.0),
    pinchRight: new OneEuroFilter2D(3.0, 0.08, 1.0),
  })
  // pinch 状态机 + 跨帧 anchor 缓存。
  // 川哥洞察 v3：光标应该始终以"食指拇指捏合位置"为基准 — 即两指中点（midpoint）。
  // hover 时中点 = 两指之间空中点（视觉指引）；捏合时中点 ≈ 接触点 P（用户感知稳定）。
  // 中点的好处：用户单独调整食指/拇指相对位置时两个 landmark 对向运动相互抵消，
  // 中点几乎不动；而单食指尖驱动会让 cursor 跟食指走偏。
  // - wasPinching/lastCursor: deadzone-soft 锁定用
  // - cursorAnchor: pinch 触发瞬间锁定 cursor 在 hover 最后位置（不跳）
  // - centerAtPinchStart: 触发瞬间记录的"上一帧稳定中点"（不是当前帧飞行中点）
  // - prevCenter: hover 时每帧记录稳定中点，作为下次 pinch 触发的 anchor 参考
  const pinchAnchorRef = useRef<
    Record<
      'left' | 'right',
      {
        wasPinching: boolean
        lastCursor: ScreenPoint | null
        cursorAnchor: ScreenPoint | null
        centerAtPinchStart: { x: number; y: number } | null
        prevCenter: { x: number; y: number } | null
        framesSincePinch: number
      }
    >
  >({
    left: {
      wasPinching: false,
      lastCursor: null,
      cursorAnchor: null,
      centerAtPinchStart: null,
      prevCenter: null,
      framesSincePinch: 0,
    },
    right: {
      wasPinching: false,
      lastCursor: null,
      cursorAnchor: null,
      centerAtPinchStart: null,
      prevCenter: null,
      framesSincePinch: 0,
    },
  })

  // 用 useLayoutEffect 而非 useEffect：layoutEffect 在 commit phase 同步执行，
  // 比 useEffect 早一帧写入 store。useEffect 在重 React 树下会被推后导致 cursor 滞后。
  // Batch 3 加 PoiStatusChip 后 reconciliation 变重，useEffect 滞后明显（川哥实测）。
  useLayoutEffect(() => {
    const now = performance.now()

    // 1) gaze 滤波
    const rawGaze = gazeToScreen(gaze)
    let smoothedGaze: ScreenPoint | null = null
    if (rawGaze) {
      smoothedGaze = filtersRef.current.gaze.filter(rawGaze.x, rawGaze.y, now)
    } else {
      filtersRef.current.gaze.reset()
    }

    // 2) pinch 点：分 pinch=false（hover）vs pinch=true（已捏合）两种基准策略
    //
    // hover：thumb+index 中点 → 视觉指引"光点会停在两指之间"，符合用户预期
    // 捏合触发瞬间：cursor 留在上一帧位置（cursorAnchor = lastCursor），不跳
    // 捏合 dragging：基于食指尖单 landmark 位移驱动 → 噪声只有 1-3px，
    //   比 thumb+index 中点的 √2 倍加权噪声小得多，彻底消除"捏合后抖动"。
    // 接触点 P 在 2D 投影 ≈ 食指尖位置，cursor 视觉位置准确。
    const pinchPointers: PinchPointer[] = []
    const presentHands = new Set<'left' | 'right'>()
    for (const hand of hands) {
      // === cursor 锚点：landmark 9（Middle MCP，中指根/掌心质心）===
      // gemini 方案 A 钦定：landmark 9 是第三掌骨末端，捏合动作（涉及第一二掌骨
      // 内收）对它 0 物理影响。原 (thumb_tip + index_tip)/2 中点会让 cursor 在
      // 捏合后随两指继续闭合细节平移 5-15px（川哥实测反馈"捏合后还是会平移"）。
      // landmark 9 是手掌 X-Y 平面质心，cursor 完全跟随手掌整体移动。
      // hover (未捏合) 与 pinch (已捏合) 用同一基准 → 切换不跳。
      const palm = hand.landmarks[9]
      if (!palm) continue

      const anchor = pinchAnchorRef.current[hand.hand]
      const wasPinching = anchor.wasPinching

      const center = {
        x: palm.x,
        y: palm.y,
      }

      let rawScreen: ScreenPoint
      if (hand.pinch) {
        if (!wasPinching) {
          // 捏合刚触发：cursor 锚点 = 上一帧 cursor（保持连续不跳）
          anchor.cursorAnchor = anchor.lastCursor ?? landmarkToScreen(center)
          anchor.centerAtPinchStart = anchor.prevCenter ?? center
          anchor.framesSincePinch = 0
        }
        anchor.framesSincePinch += 1

        if (anchor.framesSincePinch <= PINCH_STABILIZE_FRAMES) {
          // === 稳定窗口（前 4 帧 ~130ms）===
          // pinch=true 不等于"捏合动作完成"—— 两指继续闭合中点仍在移动。
          // cursor 完全锁定 anchor + 每帧重置 centerAtPinchStart 为当前 center，
          // 让稳定窗口结束时 cursor = anchor + (center - center) = anchor 不跳。
          rawScreen = anchor.cursorAnchor ?? landmarkToScreen(center)
          anchor.centerAtPinchStart = { x: center.x, y: center.y }
        } else if (anchor.cursorAnchor && anchor.centerAtPinchStart) {
          // === 稳定窗口结束 → cursor 跟随中点位移 ===
          // 中点位移 = 手部整体位移（两指对向调整时相互抵消，cursor 稳定）
          const centerNowScreen = landmarkToScreen(center)
          const centerStartScreen = landmarkToScreen(anchor.centerAtPinchStart)
          rawScreen = {
            x: anchor.cursorAnchor.x + (centerNowScreen.x - centerStartScreen.x),
            y: anchor.cursorAnchor.y + (centerNowScreen.y - centerStartScreen.y),
          }
        } else {
          rawScreen = landmarkToScreen(center)
        }
      } else {
        // hover：直接中点（与 pinch 基准一致）+ 清掉 pinch session
        rawScreen = landmarkToScreen(center)
        anchor.cursorAnchor = null
        anchor.centerAtPinchStart = null
        anchor.framesSincePinch = 0
      }
      // 每帧更新 prevCenter（下次 pinch 触发时取捏合前稳定中点作 anchor）
      anchor.prevCenter = { x: center.x, y: center.y }

      const filter =
        hand.hand === 'left' ? filtersRef.current.pinchLeft : filtersRef.current.pinchRight
      const smoothed = filter.filter(rawScreen.x, rawScreen.y, now)

      // === Deadzone 三段式锁定（pinch=true 时启用）===
      // 即使切了基准点到食指尖单 landmark，还有 1-3px 检测噪声 + OneEuroFilter
      // 残余。三段式吃掉所有静止抖动 + 保留慢速细腻 + 快拖不粘滞。
      let finalPoint = smoothed
      if (hand.pinch && wasPinching && anchor.lastCursor) {
        const dx = smoothed.x - anchor.lastCursor.x
        const dy = smoothed.y - anchor.lastCursor.y
        const dist = Math.sqrt(dx * dx + dy * dy)
        if (dist < PINCH_HARD_LOCK_PX) {
          // hard zone: cursor 完全不动（即使 dist=5px 也锁住）
          finalPoint = anchor.lastCursor
        } else if (dist < PINCH_SOFT_ZONE_PX) {
          // soft zone: alpha 从 0（刚出 hard）线性升到 1（触 soft 边界）
          const alpha = (dist - PINCH_HARD_LOCK_PX) / (PINCH_SOFT_ZONE_PX - PINCH_HARD_LOCK_PX)
          finalPoint = {
            x: anchor.lastCursor.x + dx * alpha,
            y: anchor.lastCursor.y + dy * alpha,
          }
        }
        // dist >= SOFT_ZONE 走 smoothed 全速
      }

      // 更新 anchor 状态
      anchor.wasPinching = hand.pinch
      anchor.lastCursor = finalPoint

      pinchPointers.push({
        hand: hand.hand,
        point: finalPoint,
        isPinching: hand.pinch,
      })
      presentHands.add(hand.hand)
    }
    if (!presentHands.has('left')) {
      filtersRef.current.pinchLeft.reset()
      pinchAnchorRef.current.left = {
        wasPinching: false,
        lastCursor: null,
        cursorAnchor: null,
        centerAtPinchStart: null,
        prevCenter: null,
        framesSincePinch: 0,
      }
    }
    if (!presentHands.has('right')) {
      filtersRef.current.pinchRight.reset()
      pinchAnchorRef.current.right = {
        wasPinching: false,
        lastCursor: null,
        cursorAnchor: null,
        centerAtPinchStart: null,
        prevCenter: null,
        framesSincePinch: 0,
      }
    }

    // 3) 写 store（drag / hover / releaseStartRect 字段保持现有值，
    //    分别由 useDragController / InteractionCursor hover 检测 RAF / release handler 管理）
    const current = interactionStore.read()
    interactionStore.write({
      gaze: smoothedGaze,
      pinch: pinchPointers,
      face: { browFurrow: face.browFurrow, smile: face.smile, mouthOpen: face.mouthOpen },
      drag: current.drag,
      hover: current.hover,
      timestamp: now,
      releaseStartRect: current.releaseStartRect,
    })
  }, [hands, gaze, face])
}
