import { memo } from 'react'
import { PhudStrip } from './phud/PhudStrip'
import { ArPoiLayer } from './ar-poi/ArPoiLayer'
import type { HudData, PoiItem } from './phud/types'
import type { PhudCardId } from '@/lib/ar-hud/use-drag-controller'

export type { HudData } from './phud/types'

interface HudOverlayProps {
  data: HudData
  order: PhudCardId[]
  activePoi: PoiItem | null
  activePoiId: string | null
}

// memo 阻断 page re-render 传染：props 引用全部稳定（data 模块常量 /
// handlers useCallback / activePoi 派生引用稳定），shallow compare 跳过。
// 川哥需求：POI 拖入后不显示 chip 浮层，POI 卡片信息直接进入 PHUD 卡片，
// 退出依赖视频循环自动 reset（不再需要 × 按钮）。PoiStatusChip 组件保留
// 在代码库但不再挂载。
export const HudOverlay = memo(function HudOverlay({
  data,
  order,
  activePoi,
  activePoiId,
}: HudOverlayProps) {
  return (
    <>
      <ArPoiLayer items={data.poi} activePoiId={activePoiId} />
      <PhudStrip data={data.phud} order={order} activePoi={activePoi} />
    </>
  )
})
