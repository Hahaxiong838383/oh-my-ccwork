import { memo } from 'react'
import { PoiCard } from './PoiCard'
import type { PoiItem } from '../phud/types'

interface ArPoiLayerProps {
  items: PoiItem[]
  // 当前被 PHUD 接管的 POI id。该 POI 路面卡 opacity 降 0.35，其他保持 1.0。
  activePoiId?: string | null
}

// memo：items 是模块级常量 + activePoiId 标量，shallow compare 通常稳定。
export const ArPoiLayer = memo(function ArPoiLayer({ items, activePoiId = null }: ArPoiLayerProps) {
  return (
    <div className="pointer-events-none absolute inset-0 z-10">
      {items.map((item) => (
        <PoiCard key={item.id} item={item} active={item.id === activePoiId} />
      ))}
    </div>
  )
})
