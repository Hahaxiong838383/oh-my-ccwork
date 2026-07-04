import { CardFrame } from './CardFrame'
import { MONO_FONT, type SpeedData } from './types'

interface SpeedCardProps {
  data: SpeedData
}

export function SpeedCard({ data }: SpeedCardProps) {
  return (
    <CardFrame>
      <div className="flex h-full flex-col justify-between" style={{ fontFamily: MONO_FONT }}>
        <div className="text-[10px] uppercase tracking-[0.18em] text-[#7FE5FF]/75">NAV · SPEED</div>
        <div className="flex items-baseline gap-1.5">
          <div className="tabular-nums text-[36px] font-light leading-none tracking-tight text-[#F0F4FF]">
            {data.value}
          </div>
          <div className="text-[11px] uppercase tracking-[0.18em] text-[#7FE5FF]/75">
            {data.unit}
          </div>
        </div>
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.08em] text-white/70">
          <span className="rounded border border-white/20 px-1.5 py-[1px] text-[#F0F4FF] tabular-nums">
            {data.gear}
          </span>
          <span className="text-[#4ADE80]">{data.status}</span>
        </div>
      </div>
    </CardFrame>
  )
}
