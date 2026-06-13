import { SCENE_CARDS, SPEC_SECTIONS, SPEC_META } from '../prompts';
import { useKidsHubStore } from '../store/kidshub-store';
import { useTutorialStore } from '../tutorial/tutorial-store';
import { TUTORIAL_UNITS } from '../tutorial/tutorial-units';
import { getSharedVoiceClient } from '../../services/voice-client';
import { sharedTypewriter } from '../subtitle/shared';
import { useAppStore } from '../../store/app-store';
import { useExperienceStore, EXPERIENCE_QUOTA_ENABLED } from '../store/experience-store';

export function SceneNav() {
  const activeCardId = useKidsHubStore((s) => s.activeCardId);
  const activeSectionId = useKidsHubStore((s) => s.activeSectionId);
  const selectCard = useKidsHubStore((s) => s.selectCard);
  const selectSection = useKidsHubStore((s) => s.selectSection);
  const tutorialActive = useTutorialStore((s) => s.isActive);
  const tutorialUnitId = useTutorialStore((s) => s.unitId);
  const completedUnits = useTutorialStore((s) => s.completedUnits);

  // 进引导：unlockAudio 必须在点击手势栈内（iOS Safari），其余交给 TutorialManager
  const startTutorial = (unitId: string) => {
    const client = getSharedVoiceClient();
    void client.unlockAudio().catch(() => {
      /* 解锁失败不拦启动，Manager 调试流里能看到后续语音错误 */
    });
    sharedTypewriter().reset();
    client.bargeIn();
    useAppStore.getState().setSubtitle('');
    useTutorialStore.getState().start(unitId);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-neutral-950 text-sm text-neutral-200">
      {/* 新手引导入口（A03 六单元：登舰→设置→专注→夜航→生态缸→KidsHub，登录后自动从首个未完成单元触发） */}
      <div className="border-b border-white/10 px-3 py-2 text-xs uppercase tracking-[1px] text-neutral-400">
        新手引导 · A03
      </div>
      <div className="p-2 pb-0">
        {TUTORIAL_UNITS.map((unit) => {
          const active = tutorialActive && tutorialUnitId === unit.id;
          // 上一单元已完成且衔接指向本单元、本单元未完成 → "下一步"脉冲提示（接小可衔接语）
          const isNextStep =
            !active &&
            !completedUnits[unit.id] &&
            TUTORIAL_UNITS.some((u) => u.nextUnitId === unit.id && completedUnits[u.id]);
          return (
            <button
              key={unit.id}
              onClick={() => startTutorial(unit.id)}
              className={`mb-1 w-full rounded-lg border px-3 py-2 text-left transition ${
                active
                  ? 'border-yellow-400/60 bg-yellow-500/10 ring-1 ring-yellow-400/30'
                  : isNextStep
                    ? 'animate-pulse border-sky-400/60 bg-sky-500/10 ring-1 ring-sky-400/40'
                    : 'border-white/10 bg-neutral-900 hover:bg-neutral-800 active:bg-neutral-950'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded bg-yellow-500/20 text-[11px] ring-1 ring-yellow-400/30">
                  {unit.emoji}
                </span>
                <span className="font-medium">{unit.title}</span>
                {completedUnits[unit.id] ? (
                  <span className="ml-auto rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[9px] text-emerald-300">
                    已完成
                  </span>
                ) : isNextStep ? (
                  <span className="ml-auto rounded-full bg-sky-500/20 px-1.5 py-0.5 text-[9px] text-sky-300">
                    👉 下一步
                  </span>
                ) : null}
              </div>
              <div className="mt-0.5 pl-7 text-[11px] text-neutral-400 line-clamp-1">
                {unit.subtitle}
              </div>
            </button>
          );
        })}
      </div>

      {/* 场景卡标题区 */}
      <div className="border-b border-t border-white/10 px-3 py-2 text-xs uppercase tracking-[1px] text-neutral-400">
        场景卡 · 《小可 AI 产品定义》B.3
      </div>

      <div className="flex-1 overflow-auto p-2">
        {SCENE_CARDS.map((card) => {
          const active = activeCardId === card.id;
          return (
            <button
              key={card.id}
              onClick={() => {
                // 公开模式场景卡额度用尽：直接弹窗引导加微信，不切画面、不再放行
                // （每次点都弹，关掉弹窗后继续点仍弹——堵住"关弹窗后无限白嫖"）
                if (EXPERIENCE_QUOTA_ENABLED && !useExperienceStore.getState().canScene()) {
                  useExperienceStore.getState().openModal();
                  return;
                }
                // 引导中点卡 = 打断（同卡 id 不会触发 StudioPage 的换卡 effect，这里兜住）
                const t = useTutorialStore.getState();
                if (t.isActive) {
                  t.interrupt();
                  sharedTypewriter().reset();
                  getSharedVoiceClient().bargeIn();
                  useAppStore.getState().setSubtitle('');
                }
                selectCard(card.id);
              }}
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

      {/* 出处徽标（产品定义文档链接仅公司内部模式展示，个人站公开版不暴露） */}
      {import.meta.env.VITE_KIDSHUB_PUBLIC !== '1' && (
        <a
          href={SPEC_META.docUrl}
          target="_blank"
          rel="noreferrer"
          className="m-2 block rounded-lg border border-white/10 bg-neutral-900 px-3 py-1.5 text-[10px] text-neutral-400 hover:border-sky-500/40 hover:text-sky-300"
        >
          {SPEC_META.docName} · {SPEC_META.docVersion}
          <span className="ml-1 text-[9px] text-neutral-500">↗</span>
        </a>
      )}
    </div>
  );
}
