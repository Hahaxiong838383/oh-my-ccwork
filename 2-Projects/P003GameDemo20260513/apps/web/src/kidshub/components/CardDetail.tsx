import type { SceneCard } from '../prompts';

interface CardDetailProps {
  card: SceneCard;
}

export function CardDetail({ card }: CardDetailProps) {
  return (
    <div className="space-y-3 p-3 text-sm text-neutral-200">
      {/* hint */}
      <div className="rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-[12px] text-amber-200">
        💡 建议体验：{card.hint}
      </div>

      {/* 目标 */}
      <div>
        <div className="mb-1 text-[10px] uppercase tracking-[1px] text-sky-400">本轮目标</div>
        <div className="rounded-md bg-neutral-900 px-3 py-2 text-[13px] leading-snug ring-1 ring-white/10">
          {card.goal}
        </div>
      </div>

      {/* 必须做 */}
      <div>
        <div className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-[1px] text-emerald-400">
          <span>必须做</span>
          <span className="text-[9px] text-emerald-500/60">({card.must.length})</span>
        </div>
        <ul className="space-y-1">
          {card.must.map((m, i) => (
            <li key={i} className="flex gap-2 rounded-md bg-neutral-900 px-3 py-1.5 text-[12px] ring-1 ring-emerald-500/20">
              <span className="mt-0.5 text-emerald-400">✓</span>
              <span>{m}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* 禁止做 */}
      <div>
        <div className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-[1px] text-red-400">
          <span>禁止做</span>
          <span className="text-[9px] text-red-500/60">({card.forbidden.length})</span>
        </div>
        <ul className="space-y-1">
          {card.forbidden.map((f, i) => (
            <li key={i} className="flex gap-2 rounded-md bg-neutral-900 px-3 py-1.5 text-[12px] ring-1 ring-red-500/20">
              <span className="mt-0.5 text-red-400">✕</span>
              <span>{f}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* 为什么 */}
      <div>
        <div className="mb-1 text-[10px] uppercase tracking-[1px] text-neutral-400">为什么</div>
        <div className="rounded-md border-l-2 border-neutral-500 bg-neutral-900/70 px-3 py-2 text-[12px] italic text-neutral-300">
          {card.why}
        </div>
      </div>

      <div className="text-[10px] text-neutral-500">
        {card.triggerInstruction
          ? '开场白：进卡时由 LLM 基于场景 Prompt 实时生成（参考示例风格，每次不同）'
          : '开场白：无（本场景孩子先开口）'}
      </div>
    </div>
  );
}
