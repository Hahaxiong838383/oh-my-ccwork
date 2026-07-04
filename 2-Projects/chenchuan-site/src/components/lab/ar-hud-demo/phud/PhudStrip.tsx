'use client'

import { memo, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { SpeedCard } from './SpeedCard'
import { EnergyCard } from './EnergyCard'
import { NavCard } from './NavCard'
import { EtaCard } from './EtaCard'
import { MediaCard } from './MediaCard'
import { VideoPreviewCard } from './VideoPreviewCard'
import type { PhudData, PoiItem } from './types'
import type { PhudCardId } from '@/lib/ar-hud/use-drag-controller'
import { interactionStore } from '@/lib/ar-hud/interaction-store'

interface PhudStripProps {
  data: PhudData
  order: PhudCardId[]
  activePoi: PoiItem | null
}

// memo：page 每帧 re-render 时 PhudStrip props 引用稳定（data 模块常量、order useState
// 标量、activePoi 派生引用稳定），跳过 reconciliation 节省主线程让 cursor RAF 更稳定。
export const PhudStrip = memo(function PhudStrip({ data, order, activePoi }: PhudStripProps) {
  return (
    <div
      data-phud-strip
      className="pointer-events-none absolute inset-x-0 bottom-[6vh] z-20 flex items-end justify-center px-6"
    >
      <div className="flex max-w-[1280px] flex-wrap items-stretch justify-center gap-3 md:flex-nowrap">
        {order.map((id) => (
          <DraggableCardWrapper key={id} cardId={id}>
            {renderCard(id, data, activePoi)}
          </DraggableCardWrapper>
        ))}
      </div>
    </div>
  )
})

function renderCard(id: PhudCardId, data: PhudData, activePoi: PoiItem | null): ReactNode {
  switch (id) {
    case 'speed':
      return <SpeedCard data={data.speed} />
    case 'energy':
      return <EnergyCard data={data.energy} />
    case 'nav':
      return <NavCard data={data.nav} poiOverride={activePoi} />
    case 'eta':
      return <EtaCard data={data.eta} poiOverride={activePoi} />
    case 'media':
      return <MediaCard data={data.media} />
    case 'preview':
      return <VideoPreviewCard data={data.preview} />
    default:
      return null
  }
}

interface DraggableCardWrapperProps {
  cardId: PhudCardId
  children: ReactNode
}

// 自订阅 InteractionStore + RAF：dragging 中只走 DOM transform，
// 不触发 React re-render（PHUD strip 只在 order 变化时整体重排）。
//
// FLIP 动画（First-Last-Invert-Play）：order 变化导致 flex 重排时，
// 每张卡测量 lastRect / newRect 差值，设 invert transform 让元素"留在"旧
// 位置，下一帧用 spring cubic-bezier 动画到新位置 → iOS Home Screen 挤压
// 吸附感（手机桌面 APP 挪位置那种）。
function DraggableCardWrapper({ cardId, children }: DraggableCardWrapperProps) {
  const elRef = useRef<HTMLDivElement>(null)
  const lastRectRef = useRef<{ centerX: number; centerY: number } | null>(null)

  // FLIP: 每次 PhudStrip render 后跑（order swap 或 activePoi 变都会触发）
  useLayoutEffect(() => {
    const el = elRef.current
    if (!el) return
    // dragging 中跳过 FLIP（RAF 在管 transform 跟手）
    const frame = interactionStore.read()
    const isThisDragging =
      frame.drag !== null && frame.drag.kind === 'phud' && frame.drag.cardId === cardId
    if (isThisDragging) {
      lastRectRef.current = null
      return
    }
    // 临时清 transform 拿真实 layout 位置（getBoundingClientRect 返回的是
    // visual position 含 transform，必须先清掉才能拿到 flex 算出的逻辑位置）
    const savedTransform = el.style.transform
    const savedTransition = el.style.transition
    el.style.transition = 'none'
    el.style.transform = ''
    const newRect = el.getBoundingClientRect()
    // === FLIP invert 用 center 而非 left/top（gemini 对抗审 #6 修复）===
    // dragging 卡 transform 含 scale(1.06)，bbox.left/top 偏离 layout left/top 3%，
    // 但 bbox 中心 = layout 中心 + translate（scale 围绕中心放大不影响中心位置）。
    // 用 center 算 invert 抵消 scale 偏移，FLIP 起点精确等于松手时手指视觉位置。
    const newCenterX = (newRect.left + newRect.right) / 2
    const newCenterY = (newRect.top + newRect.bottom) / 2

    // deferred swap 范式：松手时 A 的 layout 才会跳到目标位，这里优先用
    // releaseStartRect（松手瞬间视觉中心）作为 FLIP 起点，保证 release-spring 连续。
    const latestFrame = interactionStore.read()
    const releaseStart = latestFrame.releaseStartRect
    let flipStart: { centerX: number; centerY: number } | null = null
    if (releaseStart && releaseStart.cardId === cardId) {
      flipStart = { centerX: releaseStart.centerX, centerY: releaseStart.centerY }
      // 单次消费后立刻清空，避免后续无关 layout shift 复用旧起点误触发跳动。
      interactionStore.setReleaseStartRect(null)
    } else if (lastRectRef.current) {
      // 非 release 帧回退到原 lastRect 路径，保持现有 FLIP 行为不变。
      flipStart = lastRectRef.current
    }

    if (flipStart) {
      const dx = flipStart.centerX - newCenterX
      const dy = flipStart.centerY - newCenterY
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
        // FLIP: 设 invert transform 让卡片视觉上"留在"旧位置
        el.style.transform = `translate3d(${dx}px, ${dy}px, 0)`
        // 强制 reflow，让浏览器看到这个起点
        void el.offsetHeight
        // 下一帧用 spring bouncy 动画到 0（iOS Home Screen 弹性曲线）
        requestAnimationFrame(() => {
          if (!elRef.current) return
          elRef.current.style.transition =
            'transform 380ms cubic-bezier(0.34, 1.56, 0.64, 1)'
          elRef.current.style.transform = ''
        })
      } else {
        // 位置没变，恢复原 transform/transition
        el.style.transition = savedTransition
        el.style.transform = savedTransform
      }
    } else {
      // 首次 mount，恢复原值
      el.style.transition = savedTransition
      el.style.transform = savedTransform
    }
    lastRectRef.current = { centerX: newCenterX, centerY: newCenterY }
  })

  useEffect(() => {
    let raf = 0
    let stopped = false
    let isCurrentlyDragging = false
    let isCurrentlyHovering = false
    // POI 拖入 PHUD 区时，NAV / ETA 卡是接管目标 → 显示青色高亮预告。
    let isCurrentlyPoiTarget = false
    // 新增：非 drag 时光标 hover 到本卡 → 类似鼠标 hover 的"被选中"提示
    let isCurrentlyMouseHover = false

    const render = () => {
      if (stopped) return
      const frame = interactionStore.read()
      const drag = frame.drag
      const el = elRef.current
      if (!el) {
        raf = requestAnimationFrame(render)
        return
      }

      // === swap / layout shift 期间 dragging 卡不跳过 transform 更新 ===
      // 之前版本 swapPending 时跳过 transform → 旧 transform 残留 + DOM 已新位置
      // → 卡片飞到 (target_old_pos + 旧 dx) 错位（川哥实测 MEDIA 卡飞到屏幕中央）。
      // 正解：swap 触发同步把 startPoint 改成 predictedStart (target.center)，让
      // RAF 这一帧 transform = currentPoint - target.center。React commit 完成后
      // DOM 物理位置 = target old pos，visual = target_old + (currentPoint - target.center) = currentPoint ✓
      // commit 完成前的 1-2 帧 DOM 仍在旧位置，visual = old_self + (currentPoint - target.center)，
      // 偏 ~一卡宽度但持续 <33ms，用户感受不到。
      // useLayoutEffect 每次 page commit 后校正 startPoint，覆盖所有 layout shift 场景。
      const matches = drag !== null && drag.kind === 'phud' && drag.cardId === cardId
      const isHoverTarget = drag !== null && drag.kind === 'phud' && drag.hoverTarget === cardId && drag.cardId !== cardId
      // POI 拖入 PHUD 区域时，只有 nav + eta 是会被接管的卡，给它们做"释放后接管"视觉预告
      const isPoiTakeoverTarget =
        drag !== null &&
        drag.kind === 'poi' &&
        drag.hoverTarget === 'phud-area' &&
        (cardId === 'nav' || cardId === 'eta')
      // 新增：纯 hover（非 drag）光标停在本卡上方 → 视觉预告"可以捏住我"
      const isMouseHover = drag === null && frame.hover.phudCardId === cardId

      if (matches && drag) {
        const dx = drag.currentPoint.x - drag.startPoint.x
        const dy = drag.currentPoint.y - drag.startPoint.y
        el.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(1.06)`
        el.style.zIndex = '50'
        el.style.filter = 'drop-shadow(0 0 24px rgba(127,229,255,0.7)) drop-shadow(0 14px 28px rgba(0,0,0,0.55))'
        el.style.boxShadow =
          'inset 0 0 0 1px rgba(127,229,255,0.85), inset 0 1px 0 rgba(255,255,255,0.25), 0 0 32px rgba(127,229,255,0.18)'
        if (isCurrentlyHovering) isCurrentlyHovering = false
        if (isCurrentlyPoiTarget) isCurrentlyPoiTarget = false
        isCurrentlyDragging = true
      } else if (isHoverTarget && drag) {
        // hover target 让位：iOS Home Screen swap 范式 — hover 卡向远离 dragging
        // cursor 的一侧"挤"开 ≈ 自身宽度 40%（约 60-68px），区别于之前 80px 偏大。
        // 60-68px 更接近"挤压预告"感，配合 FLIP 380ms spring 让 swap 触发后
        // target 卡顺势 spring 到 dragging 卡旧位置，整体动画更顺滑 iOS-like。
        const rect = el.getBoundingClientRect()
        const pushDistance = Math.max(54, Math.min(72, rect.width * 0.42))
        const translateX = drag.currentPoint.x < rect.left + rect.width / 2 ? pushDistance : -pushDistance
        el.style.transform = `translate3d(${translateX}px, 0, 0)`
        el.style.zIndex = '35'
        el.style.boxShadow = 'inset 0 0 0 1.5px rgba(127,229,255,0.9)'
        if (isCurrentlyDragging) {
          el.style.filter = ''
          isCurrentlyDragging = false
        }
        if (isCurrentlyPoiTarget) isCurrentlyPoiTarget = false
        isCurrentlyHovering = true
      } else if (isPoiTakeoverTarget) {
        // POI 拖入预告：scale 1.04（比自己 dragging 1.06 略克制）+ 青色强发光描边
        el.style.transform = 'scale(1.04)'
        el.style.zIndex = '40'
        el.style.filter = 'drop-shadow(0 0 20px rgba(127,229,255,0.85))'
        el.style.boxShadow =
          'inset 0 0 0 1.5px rgba(127,229,255,1), 0 0 28px rgba(127,229,255,0.35)'
        if (isCurrentlyDragging) isCurrentlyDragging = false
        if (isCurrentlyHovering) isCurrentlyHovering = false
        if (isCurrentlyMouseHover) isCurrentlyMouseHover = false
        isCurrentlyPoiTarget = true
      } else if (isMouseHover) {
        // 鼠标 hover 视觉：比 POI takeover (1.04) / dragging (1.06) 更克制
        // 主要靠描边 + 轻发光告诉用户"光标找到这张卡了，捏一下就能拖"
        el.style.transform = 'scale(1.03)'
        el.style.zIndex = '32'
        el.style.filter = 'drop-shadow(0 0 12px rgba(127,229,255,0.5))'
        el.style.boxShadow =
          'inset 0 0 0 1px rgba(127,229,255,0.7), 0 0 16px rgba(127,229,255,0.2)'
        if (isCurrentlyDragging) isCurrentlyDragging = false
        if (isCurrentlyHovering) isCurrentlyHovering = false
        if (isCurrentlyPoiTarget) isCurrentlyPoiTarget = false
        isCurrentlyMouseHover = true
      } else if (isCurrentlyDragging) {
        el.style.transform = ''
        el.style.zIndex = ''
        el.style.filter = ''
        el.style.boxShadow = ''
        isCurrentlyDragging = false
      } else if (isCurrentlyHovering) {
        el.style.transform = ''
        el.style.zIndex = ''
        el.style.boxShadow = ''
        isCurrentlyHovering = false
      } else if (isCurrentlyPoiTarget) {
        el.style.transform = ''
        el.style.zIndex = ''
        el.style.filter = ''
        el.style.boxShadow = ''
        isCurrentlyPoiTarget = false
      } else if (isCurrentlyMouseHover) {
        el.style.transform = ''
        el.style.zIndex = ''
        el.style.filter = ''
        el.style.boxShadow = ''
        isCurrentlyMouseHover = false
      }

      raf = requestAnimationFrame(render)
    }

    raf = requestAnimationFrame(render)
    return () => {
      stopped = true
      cancelAnimationFrame(raf)
    }
  }, [cardId])

  return (
    <div
      ref={elRef}
      data-phud-card-id={cardId}
      style={{
        willChange: 'transform',
        transition:
          'transform 220ms cubic-bezier(0.25, 1, 0.5, 1), box-shadow 220ms ease-out, filter 220ms ease-out',
      }}
      className="pointer-events-auto"
    >
      {children}
    </div>
  )
}
