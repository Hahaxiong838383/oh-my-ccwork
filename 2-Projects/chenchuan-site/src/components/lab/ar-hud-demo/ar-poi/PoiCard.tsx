'use client'

import { useEffect, useRef } from 'react'
import { Building2, Waves } from 'lucide-react'
import type { PoiItem } from '../phud/types'
import { MONO_FONT } from '../phud/types'
import { interactionStore } from '@/lib/ar-hud/interaction-store'

const ICON_MAP = {
  Building2,
  Waves,
}

interface PoiCardProps {
  item: PoiItem
  // 当前是否被 PHUD 接管：true 时路面卡 opacity 0.35（视觉降级让出焦点）。
  active?: boolean
}

// 自订阅 InteractionStore + RAF：拖动中 transform 跟手直接走 DOM，
// 不再触发 React re-render。React 仅在 active 状态变化时重渲。
export function PoiCard({ item, active = false }: PoiCardProps) {
  const elRef = useRef<HTMLDivElement>(null)
  const Icon = ICON_MAP[item.icon] ?? Building2
  const isLarge = item.size === 'md'
  const activeFilter = active ? 'opacity(0)' : ''

  const labelClass = isLarge ? 'text-[13px]' : 'text-[11px]'
  const distClass = isLarge ? 'text-[10px]' : 'text-[9px]'
  const iconSize = isLarge ? 22 : 18
  const boxClass = isLarge ? 'h-9 w-9' : 'h-7 w-7'
  const baseScale = isLarge ? 1 : 0.9

  useEffect(() => {
    // 防御性 reset：useEffect 重订阅（active 变化等）时，强制清掉 RAF 残留的
    // inline style 到 React render 的初始值。
    // 根因：RAF 修改 DOM inline style 后，React re-render 时 diff 发现 JSX
    // style 字符串没变（因为 baseScale 不变），跳过 DOM update → RAF 残留值
    // 不会被自动清掉。视频 loop wrap reset activePoiId 时 active 变化触发
    // 重订阅，必须在这里 reset。
    const el = elRef.current
    if (el) {
      el.style.transform = `translate(-50%, -50%) scale(${baseScale})`
      el.style.zIndex = ''
      el.style.boxShadow = ''
      el.style.filter = activeFilter || ''
    }

    let raf = 0
    let stopped = false
    let isCurrentlyDragging = false
    // 新增：非 drag 时光标 hover 到本卡 → 类似鼠标"被选中"提示
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

      const matches = drag !== null && drag.kind === 'poi' && drag.poiId === item.id
      // 鼠标 hover：仅 non-active（未被接管）+ non-drag + hover.poiId 匹配
      const isMouseHover = !active && drag === null && frame.hover.poiId === item.id

      if (matches && drag) {
        const dx = (drag.currentPoint.x - drag.startPoint.x) / baseScale
        const dy = (drag.currentPoint.y - drag.startPoint.y) / baseScale
        el.style.transform = `translate(-50%, -50%) scale(${baseScale * 1.06}) translate3d(${dx}px, ${dy}px, 0)`
        el.style.zIndex = '48'
        el.style.filter = 'drop-shadow(0 0 24px rgba(127,229,255,0.7)) drop-shadow(0 14px 28px rgba(0,0,0,0.55))'
        el.style.boxShadow =
          'inset 0 0 0 1px rgba(127,229,255,0.85), inset 0 1px 0 rgba(255,255,255,0.25), 0 0 32px rgba(127,229,255,0.18)'
        if (isCurrentlyMouseHover) isCurrentlyMouseHover = false
        isCurrentlyDragging = true
      } else if (isMouseHover) {
        // 比 dragging (1.06) 略克制的 hover 反馈：scale 1.04 + 描边发光
        el.style.transform = `translate(-50%, -50%) scale(${baseScale * 1.04})`
        el.style.zIndex = '46'
        el.style.filter = 'drop-shadow(0 0 14px rgba(127,229,255,0.55))'
        el.style.boxShadow =
          'inset 0 0 0 1px rgba(127,229,255,0.8), 0 0 18px rgba(127,229,255,0.2)'
        if (isCurrentlyDragging) isCurrentlyDragging = false
        isCurrentlyMouseHover = true
      } else if (isCurrentlyDragging) {
        el.style.transform = `translate(-50%, -50%) scale(${baseScale})`
        el.style.zIndex = ''
        el.style.filter = activeFilter
        el.style.boxShadow = ''
        isCurrentlyDragging = false
      } else if (isCurrentlyMouseHover) {
        el.style.transform = `translate(-50%, -50%) scale(${baseScale})`
        el.style.zIndex = ''
        el.style.filter = activeFilter
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
  }, [item.id, baseScale, activeFilter])

  return (
    <div
      ref={elRef}
      data-poi-id={active ? undefined : item.id}
      className={`${active ? 'pointer-events-none' : 'pointer-events-auto'} absolute flex items-center gap-2 rounded-full border border-[#7FE5FF]/35 bg-black/35 px-2.5 py-1.5 backdrop-blur-md shadow-[0_0_24px_rgba(127,229,255,0.18)]`}
      style={{
        left: `${item.x}%`,
        top: `${item.y}%`,
        transform: `translate(-50%, -50%) scale(${baseScale})`,
        fontFamily: MONO_FONT,
        willChange: 'transform',
        filter: activeFilter || undefined,
        transition:
          'transform 220ms cubic-bezier(0.25, 1, 0.5, 1), box-shadow 220ms ease-out, filter 220ms ease-out, opacity 220ms ease-out',
      }}
    >
      <div
        className={`flex shrink-0 items-center justify-center rounded-full border border-[#7FE5FF]/40 bg-[#0a1a30]/70 ${boxClass}`}
      >
        <Icon size={iconSize} className="text-[#7FE5FF]" />
      </div>
      <div className="leading-tight">
        <div className={`${labelClass} text-[#F0F4FF]`}>{item.label}</div>
        <div className={`${distClass} text-[#7FE5FF]/80`}>{item.distance}</div>
      </div>
    </div>
  )
}
