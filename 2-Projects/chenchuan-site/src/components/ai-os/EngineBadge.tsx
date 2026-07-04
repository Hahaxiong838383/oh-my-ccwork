import type { DemoRoutingStep } from '@/data/classic-demos'

// 引擎徽章 + 决策链路标签翻译（gemini P1-2 钦定）：
// 内部 cc/codex/gemini → 访客可读的"决策链路"语言
// 颜色编码让访客视觉区分 3 引擎协同节奏。

interface EngineBadgeProps {
  engine: DemoRoutingStep['engine']
  stage: string
  compact?: boolean
}

const ENGINE_STYLES: Record<DemoRoutingStep['engine'], { label: string; bg: string; border: string; text: string; dot: string }> = {
  cc: {
    label: 'CC',
    bg: 'bg-[#7FE5FF]/10',
    border: 'border-[#7FE5FF]/40',
    text: 'text-[#7FE5FF]',
    dot: 'bg-[#7FE5FF]',
  },
  codex: {
    label: 'CODEX',
    bg: 'bg-[#F59E0B]/10',
    border: 'border-[#F59E0B]/40',
    text: 'text-[#F59E0B]',
    dot: 'bg-[#F59E0B]',
  },
  gemini: {
    label: 'GEMINI',
    bg: 'bg-[#A78BFA]/10',
    border: 'border-[#A78BFA]/40',
    text: 'text-[#A78BFA]',
    dot: 'bg-[#A78BFA]',
  },
}

export function EngineBadge({ engine, stage, compact = false }: EngineBadgeProps) {
  const style = ENGINE_STYLES[engine]
  return (
    <div
      className={`inline-flex items-center gap-2 rounded-md border ${style.border} ${style.bg} px-2 py-1 ${compact ? 'text-[10px]' : 'text-[11px]'} font-mono uppercase tracking-[0.16em] ${style.text}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} aria-hidden />
      <span className="font-bold">{style.label}</span>
      <span className="text-white/55">·</span>
      <span className="text-white/85 normal-case tracking-normal">{stage}</span>
    </div>
  )
}

export function EngineDot({ engine, size = 'md' }: { engine: DemoRoutingStep['engine']; size?: 'sm' | 'md' | 'lg' }) {
  const sizeClass = size === 'sm' ? 'h-1.5 w-1.5' : size === 'lg' ? 'h-3 w-3' : 'h-2 w-2'
  return <span className={`inline-block rounded-full ${ENGINE_STYLES[engine].dot} ${sizeClass}`} aria-hidden />
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const min = Math.round(ms / 60_000)
  if (min < 60) return `${min}min`
  const h = Math.floor(min / 60)
  const rest = min % 60
  return rest > 0 ? `${h}h${rest}m` : `${h}h`
}
