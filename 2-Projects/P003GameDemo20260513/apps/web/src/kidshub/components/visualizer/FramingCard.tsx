// FramingCard.tsx — 本轮 framing 表达角度小卡（紫色调）+ ⓘ tooltip
interface FramingCardProps {
  angle: { id: string; label: string; hint: string } | null;
}

const TOOLTIP_TEXT =
  '角度是 framing layer——同一事实换不同角度说，避免录制感。每次选卡随机抽一个与上次不同的';

export function FramingCard({ angle }: FramingCardProps) {
  if (!angle) {
    return (
      <div className="rounded-lg border border-white/10 bg-neutral-900/40 p-3 text-xs text-neutral-500">
        本卡无开场触发
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-purple-400/40 bg-purple-500/10 p-3 text-purple-100">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-xs uppercase tracking-[1px] text-purple-300/80">
            <span>🎭 本轮表达角度</span>
            <span
              className="inline-flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full border border-purple-300/40 text-[9px] text-purple-200"
              title={TOOLTIP_TEXT}
              aria-label={TOOLTIP_TEXT}
            >
              ⓘ
            </span>
          </div>
          <div className="mt-1 text-base font-medium text-purple-50">{angle.label}</div>
          <div className="mt-0.5 text-[11px] text-purple-200/80">{angle.hint}</div>
        </div>
        <span className="flex-shrink-0 rounded-full border border-purple-300/30 bg-purple-500/15 px-2 py-0.5 font-mono text-[10px] text-purple-200">
          {angle.id}
        </span>
      </div>
    </div>
  );
}
