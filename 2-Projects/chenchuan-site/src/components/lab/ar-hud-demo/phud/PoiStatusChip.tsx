'use client'

import { memo } from 'react'
import { Building2, Waves, X } from 'lucide-react'
import type { PoiItem } from './types'
import { MONO_FONT } from './types'
import { playSwap } from '@/lib/ar-hud/audio-feedback'

const ICON_MAP = { Building2, Waves }

interface PoiStatusChipProps {
  poi: PoiItem | null
  onClear: () => void
}

function PoiStatusChipImpl({ poi, onClear }: PoiStatusChipProps) {
  const visible = poi !== null
  const Icon = poi ? (ICON_MAP[poi.icon] ?? Building2) : Building2

  const handleClear = (): void => {
    playSwap()
    onClear()
  }

  return (
    <div
      className="pointer-events-none absolute inset-x-0 z-30 flex justify-center px-6"
      style={{
        bottom: 'calc(6vh + 110px)',
        transform: visible ? 'translateY(0)' : 'translateY(16px)',
        opacity: visible ? 1 : 0,
        transition: 'transform 250ms cubic-bezier(0.25,1,0.5,1), opacity 200ms ease-out',
      }}
    >
      {poi && (
        <div
          className="pointer-events-auto flex items-center gap-2.5 rounded-full border border-[#7FE5FF]/55 bg-black/55 px-3 py-1.5 backdrop-blur-md shadow-[0_0_24px_rgba(127,229,255,0.25)]"
          style={{ fontFamily: MONO_FONT }}
        >
          <div className="flex h-6 w-6 items-center justify-center rounded-full border border-[#7FE5FF]/40 bg-[#0a1a30]/70">
            <Icon size={14} className="text-[#7FE5FF]" />
          </div>
          <span className="text-[12px] text-[#F0F4FF]">{poi.label}</span>
          <span className="text-[10px] text-[#7FE5FF]/85">· {poi.minutesAway}</span>
          {/*
           * × 按钮：data-poi-clear="true" 让 useDragController.hitTestAt 命中后
           * 直接调 onPoiClear（pinch 触发）。同时保留 onClick 给真鼠标点击。
           * 按钮区域 h-10 w-10 (40×40px) 满足 iOS HIG 触摸目标 + 留 hit padding。
           */}
          <button
            type="button"
            onClick={handleClear}
            aria-label="退出 POI 接管"
            data-poi-clear="true"
            className="ml-1 flex h-10 w-10 items-center justify-center rounded-full bg-white/8 text-white/75 hover:bg-[#F87171]/15 hover:text-[#F87171]"
            style={{ transition: 'background-color 150ms ease, color 150ms ease' }}
          >
            <X size={18} strokeWidth={2.5} />
          </button>
        </div>
      )}
    </div>
  )
}

// memo：poi 引用稳定（来自 page 的 hudData.poi.find 模块级数据），
// onClear 是 useCallback。shallow compare 通常跳过 re-render。
export const PoiStatusChip = memo(PoiStatusChipImpl)
