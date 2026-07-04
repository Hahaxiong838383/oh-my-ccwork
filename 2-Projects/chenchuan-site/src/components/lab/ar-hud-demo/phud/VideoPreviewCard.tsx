import { Play, Thermometer } from 'lucide-react'
import { CardFrame } from './CardFrame'
import { MONO_FONT, type PreviewData } from './types'

interface VideoPreviewCardProps {
  data: PreviewData
}

export function VideoPreviewCard({ data }: VideoPreviewCardProps) {
  return (
    <CardFrame className="min-w-[160px]">
      <div className="flex h-full flex-col justify-between" style={{ fontFamily: MONO_FONT }}>
        <div className="text-[10px] uppercase tracking-[0.18em] text-[#7FE5FF]/75">PREVIEW</div>
        <div className="relative h-12 w-full overflow-hidden rounded-md bg-gradient-to-br from-amber-700/45 via-orange-600/35 to-rose-500/25">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_60%,rgba(255,200,140,0.35),transparent_60%)]" />
          <div className="absolute left-1/2 top-1/2 flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white/60 bg-black/40 backdrop-blur-sm">
            <Play size={10} className="text-white" />
          </div>
        </div>
        <div className="flex items-center justify-between text-[11px] text-white/70 tabular-nums">
          <span>
            {data.current} / {data.total}
          </span>
          <span className="flex items-center gap-1 text-[#7FE5FF]/85">
            <Thermometer size={11} />
            {data.tempC}°
          </span>
        </div>
      </div>
    </CardFrame>
  )
}
