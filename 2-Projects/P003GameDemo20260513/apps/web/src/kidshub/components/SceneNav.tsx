import { SCENE_CARDS, SPEC_SECTIONS, SPEC_META } from '../prompts';
import { useKidsHubStore } from '../store/kidshub-store';

export function SceneNav() {
  const activeCardId = useKidsHubStore((s) => s.activeCardId);
  const activeSectionId = useKidsHubStore((s) => s.activeSectionId);
  const selectCard = useKidsHubStore((s) => s.selectCard);
  const selectSection = useKidsHubStore((s) => s.selectSection);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-neutral-950 text-sm text-neutral-200">
      {/* 场景卡标题区 */}
      <div className="border-b border-white/10 px-3 py-2 text-xs uppercase tracking-[1px] text-neutral-400">
        场景卡 · 《小可 AI 产品定义》B.3
      </div>

      <div className="flex-1 overflow-auto p-2">
        {SCENE_CARDS.map((card) => {
          const active = activeCardId === card.id;
          return (
            <button
              key={card.id}
              onClick={() => selectCard(card.id)}
              className={`mb-1 w-full rounded-lg border px-3 py-2 text-left transition ${
                active
                  ? 'border-sky-400/60 bg-sky-500/10 ring-1 ring-sky-400/30'
                  : 'border-white/10 bg-neutral-900 hover:bg-neutral-800 active:bg-neutral-950'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded bg-neutral-800 text-[10px] font-mono text-neutral-400 ring-1 ring-white/10">
                  {card.cardNo}
                </span>
                <span className="font-medium">{card.title}</span>
                {card.funcRef && <span className="ml-auto text-[10px] text-neutral-500">{card.funcRef}</span>}
              </div>
              <div className="mt-0.5 pl-7 text-[11px] text-neutral-400 line-clamp-1">{card.goal}</div>
            </button>
          );
        })}

        {/* B 版块阅读区 */}
        <div className="mt-3 border-t border-white/10 pt-3">
          <div className="mb-1 px-1 text-[10px] uppercase tracking-[1px] text-neutral-400">产品定义阅读</div>
          {SPEC_SECTIONS.map((sec) => {
            const active = activeSectionId === sec.id;
            return (
              <button
                key={sec.id}
                onClick={() => selectSection(sec.id)}
                className={`mb-1 block w-full rounded border px-3 py-1.5 text-left text-xs transition ${
                  active
                    ? 'border-emerald-400/60 bg-emerald-500/10 text-emerald-200'
                    : 'border-white/10 bg-neutral-900 text-neutral-300 hover:bg-neutral-800'
                }`}
              >
                {sec.title}
              </button>
            );
          })}
        </div>
      </div>

      {/* 出处徽标 */}
      <a
        href={SPEC_META.docUrl}
        target="_blank"
        rel="noreferrer"
        className="m-2 block rounded-lg border border-white/10 bg-neutral-900 px-3 py-1.5 text-[10px] text-neutral-400 hover:border-sky-500/40 hover:text-sky-300"
      >
        {SPEC_META.docName} · {SPEC_META.docVersion}
        <span className="ml-1 text-[9px] text-neutral-500">↗</span>
      </a>
    </div>
  );
}
