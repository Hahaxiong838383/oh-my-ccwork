import { MONO_FONT } from './phud/types'

interface ResetCountdownProps {
  currentTime: number
  duration: number
}

const COUNTDOWN_WINDOW_S = 6

export function ResetCountdown({ currentTime, duration }: ResetCountdownProps) {
  if (!duration || !Number.isFinite(duration)) {
    return null
  }

  const remainingTime = Math.max(duration - currentTime, 0)
  const shouldShow = remainingTime > 0 && remainingTime < COUNTDOWN_WINDOW_S

  if (!shouldShow) {
    return null
  }

  const progressPercent = Math.min(100, Math.max(0, (remainingTime / COUNTDOWN_WINDOW_S) * 100))

  return (
    <div className="pointer-events-none absolute bottom-[calc(6vh+120px)] left-1/2 z-[25] w-[280px] -translate-x-1/2">
      <div
        className="rounded-md border border-[#7FE5FF]/25 bg-black/45 px-3 py-1.5 backdrop-blur-md"
        style={{ fontFamily: MONO_FONT }}
      >
        <div className="mb-1 text-[10px] uppercase tracking-[0.18em] text-[#7FE5FF]/85">
          LOOP RESET · {remainingTime.toFixed(1)}s
        </div>
        <div className="h-[3px] w-full overflow-hidden rounded-full bg-white/12">
          <div className="h-full rounded-full bg-[#7FE5FF]" style={{ width: `${progressPercent}%` }} />
        </div>
      </div>
    </div>
  )
}
