'use client'

import { memo, useEffect, useRef } from 'react'
import { interactionStore, type InteractionFrame } from '@/lib/ar-hud/interaction-store'

// 自订阅 InteractionStore + RAF 驱动 + ref 直接操 DOM transform，
// 完全绕开 React Fiber 调和。这是 gemini + codex 共识的最大杠杆点。

function InteractionCursorImpl() {
  const gazeRef = useRef<HTMLDivElement>(null)
  const leftPinchRef = useRef<HTMLDivElement>(null)
  const rightPinchRef = useRef<HTMLDivElement>(null)
  const leftLabelRef = useRef<HTMLDivElement>(null)
  const rightLabelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let raf = 0
    let stopped = false

    const render = () => {
      if (stopped) return
      const frame = interactionStore.read()

      // gaze 光圈
      const gazeEl = gazeRef.current
      if (gazeEl) {
        if (frame.gaze) {
          gazeEl.style.transform = `translate3d(${frame.gaze.x}px, ${frame.gaze.y}px, 0) translate(-50%, -50%)`
          gazeEl.style.opacity = '1'
        } else {
          gazeEl.style.opacity = '0'
        }
      }

      // pinch 光点（左右手分开）
      const leftPinch = frame.pinch.find((p) => p.hand === 'left')
      const rightPinch = frame.pinch.find((p) => p.hand === 'right')

      applyPinch(leftPinchRef.current, leftLabelRef.current, leftPinch ?? null)
      applyPinch(rightPinchRef.current, rightLabelRef.current, rightPinch ?? null)

      // === Hover 检测：每帧用 pinch.point 做 elementsFromPoint hit-test ===
      // 让用户在"还没捏合"时就能看到光标指向哪张卡（类似鼠标 hover 选中提示）。
      // 仅 non-drag 时检测：drag 中视觉走 dragRef 路径（dragging 卡 + hoverTarget
      // 让位 + POI 拖入预告），避免双重高亮。
      // 性能：elementsFromPoint 浏览器原生 hit-test 60fps 跑无压力；
      // updateHover 内部 early-return 状态不变不重建 frame。
      detectHover(frame)

      raf = requestAnimationFrame(render)
    }

    raf = requestAnimationFrame(render)
    return () => {
      stopped = true
      cancelAnimationFrame(raf)
    }
  }, [])

  return (
    <div className="pointer-events-none fixed inset-0 z-[45]" style={{ willChange: 'transform' }}>
      <CursorNode innerRef={gazeRef} kind="gaze" />
      <CursorNode innerRef={leftPinchRef} innerLabelRef={leftLabelRef} kind="pinch" hand="left" />
      <CursorNode innerRef={rightPinchRef} innerLabelRef={rightLabelRef} kind="pinch" hand="right" />
    </div>
  )
}

// memo（无 props）：page 每帧 re-render 时 InteractionCursor 不会被重渲，
// 内部 RAF + ref.style 是 cursor 跟手的关键路径，必须最大化保护主线程预算。
export const InteractionCursor = memo(InteractionCursorImpl)

interface CursorNodeProps {
  innerRef: React.RefObject<HTMLDivElement | null>
  innerLabelRef?: React.RefObject<HTMLDivElement | null>
  kind: 'gaze' | 'pinch'
  hand?: 'left' | 'right'
}

function CursorNode({ innerRef, innerLabelRef, kind, hand }: CursorNodeProps) {
  if (kind === 'gaze') {
    return (
      <div
        ref={innerRef}
        className="absolute opacity-0"
        style={{ willChange: 'transform, opacity', transition: 'opacity 150ms ease' }}
      >
        <div className="relative">
          <div className="h-14 w-14 rounded-full bg-[#7FE5FF]/10 shadow-[0_0_18px_rgba(127,229,255,0.4)]" />
          <div className="absolute inset-[16px] rounded-full border border-[#7FE5FF]/55" />
          <div className="absolute inset-[24px] rounded-full bg-[#7FE5FF]/85" />
        </div>
      </div>
    )
  }

  return (
    <div
      ref={innerRef}
      className="absolute opacity-0"
      style={{ willChange: 'transform, opacity', transition: 'opacity 100ms ease' }}
    >
      <div className="relative">
        <div
          className="h-9 w-9 rounded-full bg-[#F0F4FF]/15 shadow-[0_0_8px_rgba(240,244,255,0.3)]"
          data-pinch-bg
        />
        <div
          className="absolute inset-[10px] rounded-full border-2 border-[#F0F4FF]/70"
          data-pinch-ring
        />
        <div
          ref={innerLabelRef}
          data-hand={hand}
          className="absolute -bottom-5 left-1/2 -translate-x-1/2 rounded border border-white/20 bg-black/55 px-1.5 py-[2px] text-[9px] uppercase tracking-[0.18em] text-white/85"
          style={{ fontFamily: 'JetBrains Mono, Geist Mono, ui-monospace, SFMono-Regular, monospace' }}
        >
          {hand}
        </div>
      </div>
    </div>
  )
}

// === Hover 检测：每帧 elementsFromPoint 查 data-phud-card-id / data-poi-id ===
// 写入 interactionStore.hover，让卡片层 RAF 自取应用"被选中"视觉。
// 选第一个 pinch pointer 作 hover 主光标（用户通常单手操作，多手时取列表头一个）。
// drag 中跳过：dragRef 路径已经覆盖了 hover/swap 视觉，不能双重叠加。
function detectHover(frame: InteractionFrame): void {
  if (typeof document === 'undefined') return
  if (frame.drag !== null) {
    // drag 中：清掉 hover，让 dragRef 视觉路径独占
    if (frame.hover.phudCardId !== null || frame.hover.poiId !== null) {
      interactionStore.updateHover({ phudCardId: null, poiId: null })
    }
    return
  }
  if (frame.pinch.length === 0) {
    if (frame.hover.phudCardId !== null || frame.hover.poiId !== null) {
      interactionStore.updateHover({ phudCardId: null, poiId: null })
    }
    return
  }
  const pointer = frame.pinch[0]
  const els = document.elementsFromPoint(pointer.point.x, pointer.point.y)
  let phudId: string | null = null
  let poiId: string | null = null
  for (const el of els) {
    const e = el as HTMLElement
    if (!phudId && e.dataset?.phudCardId) {
      phudId = e.dataset.phudCardId
    }
    if (!poiId && e.dataset?.poiId) {
      poiId = e.dataset.poiId
    }
    if (phudId && poiId) break
  }
  interactionStore.updateHover({ phudCardId: phudId, poiId })
}

// 把 store 数据应用到 pinch 节点：transform 跟手、bg/ring 颜色随 pinch 状态变。
function applyPinch(
  el: HTMLDivElement | null,
  labelEl: HTMLDivElement | null,
  pointer: { point: { x: number; y: number }; isPinching: boolean } | null,
): void {
  if (!el) return
  if (!pointer) {
    el.style.opacity = '0'
    return
  }
  el.style.transform = `translate3d(${pointer.point.x}px, ${pointer.point.y}px, 0) translate(-50%, -50%)`
  el.style.opacity = '1'

  const bg = el.querySelector<HTMLDivElement>('[data-pinch-bg]')
  const ring = el.querySelector<HTMLDivElement>('[data-pinch-ring]')
  if (bg) {
    bg.style.background = pointer.isPinching ? 'rgba(147,197,253,0.4)' : 'rgba(240,244,255,0.15)'
    bg.style.boxShadow = pointer.isPinching
      ? '0 0 16px rgba(147,197,253,0.7)'
      : '0 0 8px rgba(240,244,255,0.3)'
  }
  if (ring) {
    ring.style.borderColor = pointer.isPinching ? 'rgba(147,197,253,1)' : 'rgba(240,244,255,0.7)'
  }
  if (labelEl) {
    const baseHand = labelEl.dataset.hand ?? ''
    labelEl.textContent = pointer.isPinching ? `${baseHand} · pinch` : baseHand
  }
}
