import { Music, SkipBack, SkipForward, Pause } from 'lucide-react'
import { CardFrame } from './CardFrame'
import { MONO_FONT, type MediaData } from './types'

interface MediaCardProps {
  data: MediaData
}

export function MediaCard({ data }: MediaCardProps) {
  return (
    <CardFrame className="min-w-[220px]">
      <div className="flex h-full flex-col justify-between" style={{ fontFamily: MONO_FONT }}>
        <div className="text-[10px] uppercase tracking-[0.18em] text-[#7FE5FF]/75">NOW PLAYING</div>
        <div className="flex min-w-0 items-start gap-2">
          <Music size={14} className="mt-0.5 shrink-0 text-[#7FE5FF]" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] leading-tight text-[#F0F4FF]">{data.title}</div>
            <div className="truncate text-[10px] text-white/55">{data.artist}</div>
          </div>
        </div>
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-[10px] text-white/55 tabular-nums">
            <span>{data.progress}</span>
            <div className="h-[2px] flex-1 rounded-full bg-white/12">
              <div className="h-full w-[28%] rounded-full bg-[#7FE5FF]/80" />
            </div>
            <span>{data.duration}</span>
          </div>
          <div className="flex items-center justify-center gap-3 text-white/70">
            <SkipBack size={12} />
            <Pause size={13} className="text-[#7FE5FF]" />
            <SkipForward size={12} />
          </div>
        </div>
      </div>
    </CardFrame>
  )
}
