/**
 * 衔接确认浮层（需求4）—— 每个引导单元末步播完 → phase==='handoff' 时显示。
 *
 * 川哥 2026-06-13：每部分引导完，UI 和小可都提示「继续下一步 / 再来一次」。
 *  - 小可 = 语音（TutorialManager 在 enterHandoff 后播 outroCopy 问询）
 *  - UI = 这里的按键选择（继续 → proceedNext / 再来一次 → replayUnit）
 * 末站单元（无 nextUnitId，即 KidsHub）继续按钮变「完成体验」，点击结束全部引导。
 * 挂在画布层（CanvasHost 内），cqw/cqh 单位随画布尺寸自适应。
 */
import { useTutorialStore } from './tutorial-store';
import { getUnit } from './tutorial-units';

export function TutorialHandoffPrompt(): JSX.Element | null {
  const isActive = useTutorialStore((s) => s.isActive);
  const phase = useTutorialStore((s) => s.phase);
  const unitId = useTutorialStore((s) => s.unitId);
  const proceedNext = useTutorialStore((s) => s.proceedNext);
  const replayUnit = useTutorialStore((s) => s.replayUnit);

  if (!isActive || phase !== 'handoff') return null;

  const unit = getUnit(unitId);
  const nextUnit = unit?.nextUnitId ? getUnit(unit.nextUnitId) : null;
  const isLast = !nextUnit;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[60] flex justify-center pb-[5cqh]">
      <div className="pointer-events-auto flex flex-col items-center gap-[1.6cqh] rounded-[2.2cqw] border border-white/15 bg-black/65 px-[4cqw] py-[2.4cqh] shadow-[0_4px_24px_rgba(0,0,0,.4)] backdrop-blur-md">
        <div className="text-[2.5cqw] font-medium text-white/90">
          {isLast ? '🎉 新手体验全部完成啦！' : '这一段结束啦，接下来想怎么走？'}
        </div>
        <div className="flex items-center gap-[2cqw]">
          <button
            type="button"
            onClick={replayUnit}
            className="rounded-full border border-white/25 bg-white/10 px-[3.2cqw] py-[1.3cqh] text-[2.3cqw] text-white/85 transition hover:bg-white/20 active:scale-[0.97]"
          >
            ↺ 再来一次
          </button>
          <button
            type="button"
            onClick={proceedNext}
            className="rounded-full bg-gradient-to-b from-amber-300 to-amber-500 px-[3.6cqw] py-[1.3cqh] text-[2.4cqw] font-semibold text-neutral-900 shadow-[0_2px_10px_rgba(245,158,11,.5)] transition hover:brightness-105 active:scale-[0.97]"
          >
            {isLast ? '完成体验 ✓' : '继续下一步 →'}
          </button>
        </div>
        {!isLast && nextUnit && (
          <div className="text-[1.9cqw] text-white/55">
            下一站：{nextUnit.emoji} {nextUnit.title}
          </div>
        )}
      </div>
    </div>
  );
}
