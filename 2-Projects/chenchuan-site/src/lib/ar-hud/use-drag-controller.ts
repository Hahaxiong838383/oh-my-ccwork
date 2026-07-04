'use client'

import { useEffect, useRef, useState } from 'react'
import { interactionStore, type ScreenPoint } from './interaction-store'
import { playPinchClick, playSwap } from './audio-feedback'

export type PhudCardId = 'speed' | 'energy' | 'nav' | 'eta' | 'media' | 'preview'
export type PoiId = string
const PHUD_CARD_IDS: PhudCardId[] = ['speed', 'energy', 'nav', 'eta', 'media', 'preview']

export interface PhudDragState {
  kind: 'phud'
  cardId: PhudCardId
  hand: 'left' | 'right'
  startPoint: ScreenPoint
  currentPoint: ScreenPoint
  hoverTarget: PhudCardId | null
}

export interface PoiDragState {
  kind: 'poi'
  poiId: PoiId
  hand: 'left' | 'right'
  startPoint: ScreenPoint
  currentPoint: ScreenPoint
  hoverTarget: 'phud-area' | null
}

export type DragState = PhudDragState | PoiDragState | null

interface UseDragControllerInput {
  onPhudMove: (a: PhudCardId, b: PhudCardId) => void
  onPoiInject: (poiId: PoiId) => void
  onPoiClear: () => void
}

type HitResult =
  | { kind: 'phud'; cardId: PhudCardId }
  | { kind: 'poi'; poiId: PoiId }
  | { kind: 'poi-clear' }

interface PhudCardRect {
  cardId: PhudCardId
  left: number
  right: number
  top: number
  bottom: number
}

function isPhudCardId(value: string): value is PhudCardId {
  return PHUD_CARD_IDS.includes(value as PhudCardId)
}

// 用浏览器 elementsFromPoint 做边沿 hit-test：只在 pinch start 跑。
// 拖动过程复用 start 时缓存 bbox，不再重复查 DOM（避免每帧 layout / paint 探针）。
function hitTestAt(point: ScreenPoint): HitResult | null {
  if (typeof document === 'undefined') return null
  const elements = document.elementsFromPoint(point.x, point.y)
  for (const el of elements) {
    const e = el as HTMLElement
    // 优先 poi-clear（× 按钮），pinch 命中即调 onPoiClear 不进 dragging
    if (e.dataset?.poiClear === 'true') return { kind: 'poi-clear' }
    const cardId = e.dataset?.phudCardId
    if (cardId && isPhudCardId(cardId)) return { kind: 'phud', cardId }
    const poiId = e.dataset?.poiId
    if (poiId) return { kind: 'poi', poiId }
  }
  return null
}

function isOverPhudArea(point: ScreenPoint): boolean {
  if (typeof window === 'undefined') return false
  return point.y >= window.innerHeight * 0.7
}

// 测**真实 layout rect**（不含 transform）：先临时清所有 PHUD 卡 transform/transition,
// 强制 reflow 后测 bbox，最后恢复 transform。所有动作在同一 task 内同步完成，
// 浏览器不会 paint 中间状态，视觉无闪烁。
// 用 layout rect 后 hit-test 始终基于 React 渲染后的真实位置，不受 dragging 卡的
// translate+scale / hover 卡的 translateX 让位 / FLIP invert 等 transform 污染。
function collectPhudCardRects(): PhudCardRect[] {
  if (typeof document === 'undefined') return []
  const nodes = document.querySelectorAll<HTMLElement>('[data-phud-card-id]')

  const saved: Array<{ el: HTMLElement; transform: string; transition: string }> = []
  for (const node of nodes) {
    saved.push({
      el: node,
      transform: node.style.transform,
      transition: node.style.transition,
    })
    node.style.transition = 'none'
    node.style.transform = ''
  }
  if (saved.length > 0) {
    void saved[0].el.offsetHeight
  }

  const rects: PhudCardRect[] = []
  for (const node of nodes) {
    const cardId = node.dataset.phudCardId
    if (!cardId || !isPhudCardId(cardId)) continue
    const rect = node.getBoundingClientRect()
    rects.push({
      cardId,
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
    })
  }

  for (const { el, transform, transition } of saved) {
    el.style.transform = transform
    el.style.transition = transition
  }

  return rects
}

function hitPhudCardByRect(
  point: ScreenPoint,
  selfCardId: PhudCardId,
  rects: PhudCardRect[],
  innerMargin = 0,
): PhudCardId | null {
  for (const rect of rects) {
    if (rect.cardId === selfCardId) continue
    const w = rect.right - rect.left
    const h = rect.bottom - rect.top
    const mx = w * innerMargin
    const my = h * innerMargin
    if (
      point.x >= rect.left + mx &&
      point.x <= rect.right - mx &&
      point.y >= rect.top + my &&
      point.y <= rect.bottom - my
    ) {
      return rect.cardId
    }
  }
  return null
}

// === Deferred Swap 范式（iOS Home Screen 同款）===
// dragging 中 phudOrder **完全不变**（A 的 layout 永远不动），松手才触发 onPhudMove。
// 优点：消除所有 dragging-中-swap 引起的 React commit + DOM 重排 + 时序错位 bug。
// 代价：用户拖动期间看不到"实时换位"，靠 B 卡视觉让位预告（translateX）给反馈。
//
// 删除的复杂机制（v1 -> v2 简化 ~120 行）：
//   - dragging 中 6 帧 debounce 实时 swap
//   - swapPending 标记 + useLayoutEffect 校正 startPoint
//   - lastSwapPoint + SWAP_POINT_RESET_MIN_PX 反弹防护
//   - swapCooldownRef 12 帧冷却
const HOVER_INNER_MARGIN = 0.18 // 卡片内缩 18% 才算 hover target (防边界抖动)

// release 380ms iOS spring 曲线（与 FLIP 一致）
const RELEASE_SPRING_DURATION_MS = 380
const RELEASE_SPRING_EASING = 'cubic-bezier(0.34, 1.56, 0.64, 1)'

// 把 dragging 卡 spring 回 layout（无 swap 触发的 release / 手离场被动 release）。
// imperative DOM 操作：直接设 transition 让浏览器 spring，下一帧 RAF 设 transform=''
// 时浏览器走 transition spring → 完美 380ms 从手指位置回 layout。
function springDraggingCardToLayout(cardId: PhudCardId): void {
  if (typeof document === 'undefined') return
  const el = document.querySelector<HTMLElement>(`[data-phud-card-id="${cardId}"]`)
  if (!el) return
  el.style.transition = `transform ${RELEASE_SPRING_DURATION_MS}ms ${RELEASE_SPRING_EASING}`
  el.style.transform = ''
}

// React state 只在 drag 状态边沿变化（start / swap-trigger-via-release / inject）时更新，
// 不再每帧 setState。拖动过程通过 store 流向 DOM。
export function useDragController({
  onPhudMove,
  onPoiInject,
  onPoiClear,
}: UseDragControllerInput): { dragState: DragState } {
  const [dragState, setDragState] = useState<DragState>(null)
  const prevPinchRef = useRef<Record<'left' | 'right', boolean>>({ left: false, right: false })
  const dragRef = useRef<DragState>(null)
  const phudRectsRef = useRef<PhudCardRect[]>([])

  useEffect(() => {
    dragRef.current = dragState
    interactionStore.updateDrag(dragState)
  }, [dragState])

  useEffect(() => {
    const handleFrame = () => {
      const frame = interactionStore.read()
      const presentHands = new Set<'left' | 'right'>()

      for (const pointer of frame.pinch) {
        presentHands.add(pointer.hand)
        const wasPinching = prevPinchRef.current[pointer.hand]
        const nowPinching = pointer.isPinching

        if (!wasPinching && nowPinching) {
          // === grab start: 一次 hit-test 锁定 target ===
          const hit = hitTestAt(pointer.point)
          if (hit?.kind === 'poi-clear') {
            onPoiClear()
            playSwap()
            prevPinchRef.current[pointer.hand] = nowPinching
            continue
          }
          phudRectsRef.current = collectPhudCardRects()
          if (hit?.kind === 'phud') {
            // ★ gemini 对抗审 #7 修：清掉上次 release 残留的 transition + releaseStartRect,
            //   防上次 spring 380ms 还没结束就立刻重 pinch 导致 RAF transform 与
            //   transition 冲突抖动。
            if (typeof document !== 'undefined') {
              const grabEl = document.querySelector<HTMLElement>(
                `[data-phud-card-id="${hit.cardId}"]`,
              )
              if (grabEl) {
                grabEl.style.transition = 'none'
              }
            }
            interactionStore.setReleaseStartRect(null)

            // 中心锁定：startPoint = 卡片中心。dragging 中 dx = currentPoint - cardCenter,
            // 视觉中心 = oldLayout.center + dx = currentPoint，光标始终穿过卡心。
            const selfRect = phudRectsRef.current.find((r) => r.cardId === hit.cardId)
            const cardCenter = selfRect
              ? {
                  x: (selfRect.left + selfRect.right) / 2,
                  y: (selfRect.top + selfRect.bottom) / 2,
                }
              : pointer.point
            const next: PhudDragState = {
              kind: 'phud',
              cardId: hit.cardId,
              hand: pointer.hand,
              startPoint: cardCenter,
              currentPoint: pointer.point,
              hoverTarget: null,
            }
            dragRef.current = next
            interactionStore.updateDrag(next)
            setDragState(next)
            playPinchClick()
          } else if (hit?.kind === 'poi') {
            const next: PoiDragState = {
              kind: 'poi',
              poiId: hit.poiId,
              hand: pointer.hand,
              startPoint: pointer.point,
              currentPoint: pointer.point,
              hoverTarget: null,
            }
            dragRef.current = next
            interactionStore.updateDrag(next)
            setDragState(next)
            playPinchClick()
          }
        } else if (wasPinching && nowPinching && dragRef.current?.hand === pointer.hand) {
          // === dragging: deferred swap，只更新 hoverTarget 给卡片层视觉让位 ===
          if (dragRef.current.kind === 'phud') {
            const phudDrag = dragRef.current
            // 卡片内缩 18% 才算 hover target（防边界抖动）
            const hoverTarget = hitPhudCardByRect(
              pointer.point,
              phudDrag.cardId,
              phudRectsRef.current,
              HOVER_INNER_MARGIN,
            )
            const next: PhudDragState = {
              ...phudDrag,
              currentPoint: pointer.point,
              hoverTarget,
            }
            dragRef.current = next
            interactionStore.updateDrag(next)
          } else {
            const hoverTarget = isOverPhudArea(pointer.point) ? 'phud-area' : null
            const next: PoiDragState = { ...dragRef.current, currentPoint: pointer.point, hoverTarget }
            dragRef.current = next
            interactionStore.updateDrag(next)
          }
        } else if (wasPinching && !nowPinching && dragRef.current?.hand === pointer.hand) {
          // === release: 这里才触发 onPhudMove（deferred swap 核心）===
          const current = dragRef.current

          if (current.kind === 'phud' && current.hoverTarget) {
            // 有 swap target：记录 dragging 卡视觉中心 (bbox 中心 = 视觉中心，scale 围绕
            // 中心放大不影响中心位置；gemini 对抗审 #6 修：用 center 抵消 scale 偏移)。
            // DraggableCardWrapper.useLayoutEffect 用它作 FLIP 起点，A spring from
            // 手指位置 to B 旧位置（A 的新 layout）。
            if (typeof document !== 'undefined') {
              const draggingEl = document.querySelector<HTMLElement>(
                `[data-phud-card-id="${current.cardId}"]`,
              )
              if (draggingEl) {
                const rect = draggingEl.getBoundingClientRect()
                interactionStore.setReleaseStartRect({
                  cardId: current.cardId,
                  centerX: (rect.left + rect.right) / 2,
                  centerY: (rect.top + rect.bottom) / 2,
                })
              }
            }
            onPhudMove(current.cardId, current.hoverTarget)
            playSwap()
          } else if (current.kind === 'phud') {
            // 无 swap target（用户拖 A 回 A 旧位置 / 拖到空白处松手）：
            // phudOrder 不变 → DraggableCardWrapper 不重渲 → 没人消费 releaseStartRect。
            // 直接 imperative 触发 spring transition 让 A 从手指位置 spring 回 A layout。
            // (gemini 对抗审 #2 修：不写 releaseStartRect 防脏数据)
            springDraggingCardToLayout(current.cardId)
          } else if (current.kind === 'poi' && current.hoverTarget === 'phud-area') {
            onPoiInject(current.poiId)
            playSwap()
          }

          phudRectsRef.current = []
          dragRef.current = null
          setDragState(null)
        }

        prevPinchRef.current[pointer.hand] = nowPinching
      }

      // hand 离场时清理（被动 release 当无 target 处理：A spring 回 A layout）
      if (!presentHands.has('left')) {
        prevPinchRef.current.left = false
        if (dragRef.current?.hand === 'left') {
          if (dragRef.current.kind === 'phud') {
            springDraggingCardToLayout(dragRef.current.cardId)
          }
          phudRectsRef.current = []
          dragRef.current = null
          setDragState(null)
        }
      }
      if (!presentHands.has('right')) {
        prevPinchRef.current.right = false
        if (dragRef.current?.hand === 'right') {
          if (dragRef.current.kind === 'phud') {
            springDraggingCardToLayout(dragRef.current.cardId)
          }
          phudRectsRef.current = []
          dragRef.current = null
          setDragState(null)
        }
      }
    }

    const unsub = interactionStore.subscribe(handleFrame)
    return unsub
  }, [onPhudMove, onPoiInject, onPoiClear])

  return { dragState }
}
