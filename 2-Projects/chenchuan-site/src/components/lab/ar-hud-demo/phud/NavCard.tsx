import { Building2, CornerUpRight, Waves } from 'lucide-react'
import { CardFrame } from './CardFrame'
import { MONO_FONT, type NavData, type PoiItem } from './types'

const ICON_MAP = {
  Building2,
  Waves,
}

interface NavCardProps {
  data: NavData
  poiOverride?: PoiItem | null
}

export function NavCard({ data, poiOverride = null }: NavCardProps) {
  const navDistance = poiOverride?.nextDistance ?? data.distance
  const navInstruction = poiOverride?.nextManeuver ?? data.instruction
  const navRoad = poiOverride?.roadName ?? data.road
  const Icon = poiOverride ? (ICON_MAP[poiOverride.icon] ?? Building2) : null

  return (
    <CardFrame>
      <div className="flex h-full flex-col justify-between" style={{ fontFamily: MONO_FONT }}>
        <div className="text-[10px] uppercase tracking-[0.18em] text-[#7FE5FF]/75">
          {poiOverride ? 'NAV · POI' : 'NAV'}
        </div>
        <div className="flex items-baseline gap-1.5">
          <CornerUpRight size={18} className="shrink-0 text-[#93C5FD]" />
          <div className="tabular-nums text-[20px] font-light leading-none text-[#F0F4FF]">{navDistance}</div>
        </div>
        <div className="space-y-1">
          <div className="text-[10px] uppercase tracking-[0.18em] text-white/70">{navInstruction}</div>
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-white/70">
            <span>{navRoad}</span>
            {poiOverride && Icon && (
              <>
                <span className="text-[#7FE5FF]/75">▸</span>
                <Icon size={14} className="text-[#7FE5FF]" />
                <span className="text-[#F0F4FF]">{poiOverride.label}</span>
              </>
            )}
          </div>
        </div>
      </div>
    </CardFrame>
  )
}
