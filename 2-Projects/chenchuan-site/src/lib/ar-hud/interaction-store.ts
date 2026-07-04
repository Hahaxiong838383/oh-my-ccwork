// Mutable 单例 store，绕开 React state 的每帧 re-render。
// gemini + codex 双方推荐：30fps 物理交互闭环不应该走 React Fiber。
// 用法：
//   - 写入：interactionStore.write(frame)
//   - 订阅：const unsub = interactionStore.subscribe(() => render(store.read()))
//   - 在订阅回调里直接操作 DOM transform，不走 setState

import type { DragState } from './use-drag-controller'

export interface ScreenPoint {
  x: number
  y: number
}

export interface PinchPointer {
  hand: 'left' | 'right'
  point: ScreenPoint
  isPinching: boolean
}

export interface FaceFrame {
  browFurrow: number
  smile: number
  mouthOpen: number
}

// 鼠标 hover 提示语义：哪张卡（PHUD / POI）被光标"指向"。
// 写入路径：InteractionCursor RAF 每帧 elementsFromPoint 检测 → updateHover。
// 仅 non-drag 时更新（drag 中视觉走 dragRef 路径，避免双高亮干扰）。
// 卡片层（PhudStrip / PoiCard）在自己 RAF 里读 frame.hover.* 决定是否亮描边。
export interface HoverState {
  // 不绑死 PhudCardId 字面量联合：避免与 use-drag-controller 循环依赖
  phudCardId: string | null
  poiId: string | null
}

// Deferred move 范式（iOS Home Screen splice insert）：dragging 期间 phudOrder 不变
// （A 的 layout 不变），松手时才触发 onPhudMove。release 同步阶段写入 releaseStartRect = A 当前
// 视觉 bbox 中心点（含 dragging transform 的视觉位置）。
// DraggableCardWrapper.useLayoutEffect 拿它作 FLIP 起点：A 从用户手指位置 spring 到
// B 旧位置（A 的新 layout）。
//
// ★ 用 center 而非 left/top（gemini 对抗审 #6 修复）：dragging 卡 transform 含
// scale(1.06)，getBoundingClientRect 返回的 bbox 比 layout 大 6%，bbox.left 偏左
// layoutWidth*3%。用 center 抵消 scale 引起的偏移，FLIP 起点精确等于 A 视觉中心。
//
// 单次消费后清空，避免下次 layout shift 误触发 spring。
export interface ReleaseStartRect {
  cardId: string
  centerX: number
  centerY: number
}

export interface InteractionFrame {
  gaze: ScreenPoint | null
  pinch: PinchPointer[]
  face: FaceFrame
  drag: DragState
  hover: HoverState
  // 单调递增帧时间戳，用于 OneEuroFilter
  timestamp: number
  // Deferred swap release-spring FLIP 起点（单次消费）
  releaseStartRect: ReleaseStartRect | null
}

const INITIAL_FRAME: InteractionFrame = {
  gaze: null,
  pinch: [],
  face: { browFurrow: 0, smile: 0, mouthOpen: 0 },
  drag: null,
  hover: { phudCardId: null, poiId: null },
  timestamp: 0,
  releaseStartRect: null,
}

class InteractionStore {
  private frame: InteractionFrame = INITIAL_FRAME
  private listeners = new Set<() => void>()

  read = (): InteractionFrame => this.frame

  write(next: InteractionFrame): void {
    this.frame = next
    // 同步通知所有订阅者：不通过 React，零 reconcile 成本
    for (const listener of this.listeners) listener()
  }

  // 局部更新 drag：**静默写**，不触发 listeners。
  // 原因：useDragController 自己订阅 store + 又写 drag，
  // 如果这里广播会触发自身订阅 → 死循环（Maximum call stack exceeded）。
  // 让 useInteractionState 的每帧 write 自动带上最新 drag 广播下游（卡片层）。
  updateDrag(next: DragState): void {
    this.frame = { ...this.frame, drag: next }
  }

  // 局部更新 hover：同 updateDrag 语义（静默写，不广播）。
  // 卡片层走 RAF 主动 read，不依赖 listener 通知。
  // early-return：状态未变跳过 frame 重建，省 GC。
  updateHover(next: HoverState): void {
    const prev = this.frame.hover
    if (prev.phudCardId === next.phudCardId && prev.poiId === next.poiId) {
      return
    }
    this.frame = { ...this.frame, hover: next }
  }

  // Deferred swap release-spring 单次消费 setter。
  // release handler 同步设 → DraggableCardWrapper.useLayoutEffect 消费 → 清空。
  setReleaseStartRect(rect: ReleaseStartRect | null): void {
    this.frame = { ...this.frame, releaseStartRect: rect }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}

export const interactionStore = new InteractionStore()
