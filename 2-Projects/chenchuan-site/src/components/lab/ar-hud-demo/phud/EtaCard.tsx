import { Building2, Waves } from 'lucide-react'
import { CardFrame } from './CardFrame'
import { MONO_FONT, type EtaData, type PoiItem } from './types'

const ICON_MAP = {
  Building2,
  Waves,
}

interface EtaCardProps {
  data: EtaData
  poiOverride?: PoiItem | null
}

export function EtaCard({ data, poiOverride = null }: EtaCardProps) {
  const etaDistance = poiOverride?.distance ?? data.distance
  const etaArrival = poiOverride?.arrival ?? data.arrival
  const Icon = poiOverride ? (ICON_MAP[poiOverride.icon] ?? Building2) : null

  return (
    <CardFrame emphasized className="px-5">
      <div className="flex h-full flex-col justify-between" style={{ fontFamily: MONO_FONT }}>
        <div className="text-[10px] uppercase tracking-[0.18em] text-[#7FE5FF]/75">{poiOverride ? 'ETA · POI' : 'ETA'}</div>
        <div className="flex items-center gap-3">
          <ArrowChevron />
          <div className="flex min-w-0 flex-col">
            <div className="tabular-nums text-[24px] font-light leading-none text-[#F0F4FF]">{etaDistance}</div>
            <div className="mt-1 text-[11px] uppercase tracking-[0.18em] text-[#93C5FD]">{etaArrival} ETA</div>
            {poiOverride && (
              <div className="mt-1 flex items-center gap-1.5 text-[11px] text-white/70">
                {Icon && <Icon size={14} className="text-[#7FE5FF]" />}
                <span className="text-[#F0F4FF]">{poiOverride.label}</span>
                <span className="text-[#7FE5FF]/80 tabular-nums">{poiOverride.minutesAway}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </CardFrame>
  )
}

function ArrowChevron() {
  return (
    <svg width="22" height="34" viewBox="0 0 22 34" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="etaGradient" x1="11" y1="0" x2="11" y2="34" gradientUnits="userSpaceOnUse">
          <stop stopColor="#BFDBFE" stopOpacity="0.95" />
          <stop offset="1" stopColor="#3B82F6" stopOpacity="0.55" />
        </linearGradient>
      </defs>
      <path d="M11 2 L20 18 L11 14 L2 18 Z" fill="url(#etaGradient)" stroke="#93C5FD" strokeWidth="0.8" />
      <path
        d="M11 16 L20 32 L11 28 L2 32 Z"
        fill="url(#etaGradient)"
        fillOpacity="0.45"
        stroke="#93C5FD"
        strokeOpacity="0.6"
        strokeWidth="0.6"
      />
    </svg>
  )
}
