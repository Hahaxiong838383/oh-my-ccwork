import { Battery } from 'lucide-react'
import { CardFrame } from './CardFrame'
import { MONO_FONT, type EnergyData } from './types'

interface EnergyCardProps {
  data: EnergyData
}

export function EnergyCard({ data }: EnergyCardProps) {
  return (
    <CardFrame>
      <div className="flex h-full flex-col justify-between" style={{ fontFamily: MONO_FONT }}>
        <div className="text-[10px] uppercase tracking-[0.18em] text-[#7FE5FF]/75">ENERGY</div>
        <div className="flex items-baseline gap-1.5">
          <Battery size={16} className="mb-1 text-[#4ADE80]" />
          <span className="tabular-nums text-[34px] font-light leading-none text-[#F0F4FF]">{data.percent}</span>
          <span className="text-[11px] uppercase tracking-[0.18em] text-[#7FE5FF]/75">%</span>
        </div>
        <div className="space-y-1">
          <div className="h-[3px] w-full rounded-full bg-white/10">
            <div className="h-full rounded-full bg-[#4ADE80]" style={{ width: `${data.percent}%` }} />
          </div>
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-[2px] text-[11px] leading-tight text-white/70 tabular-nums">
            <span className="text-[#7FE5FF]/75">RANGE</span>
            <span className="text-right text-[#F0F4FF]">{data.range} km</span>
            <span>{data.tempC}°C</span>
            <span className="text-right">{data.time}</span>
          </div>
        </div>
      </div>
    </CardFrame>
  )
}
