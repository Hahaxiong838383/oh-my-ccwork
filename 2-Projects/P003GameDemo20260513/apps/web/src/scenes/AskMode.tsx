import { useCallback } from 'react';
import { CountdownRing } from '../components/CountdownRing';
import { useTransitionRunner } from '../hooks/useTransitionRunner';
import { useAppStore } from '../store/app-store';

export function AskMode() {
  const bootState = useAppStore((s) => s.bootState);
  const rewardMachine = useAppStore((s) => s.rewardMachine);
  const isBootAsk = bootState === 'askMode';
  const isRewardAsk = rewardMachine === 'askMode';
  const { dispatchBoot, dispatchFocus, dispatchReward } = useTransitionRunner();

  // ⚠️ Rules of Hooks: 所有 useCallback 必须在 early return 之前，
  // 否则 hook 顺序变化导致 React 渲染崩溃（黑屏 bug 根因，2026-05-14）。
  // boot askMode 选完后同时启动 focusMachine（LAUNCH），让 focus 接管专注流程。
  const pickBootMode = useCallback((mode: 'explore' | 'companion') => {
    dispatchBoot({ type: 'ASK_MODE_PICK', mode });
    dispatchFocus({ type: 'LAUNCH', mode });
  }, [dispatchBoot, dispatchFocus]);

  const onTimeout = useCallback(() => {
    if (isBootAsk) {
      pickBootMode('companion');
      return;
    }
    dispatchReward({ type: 'ASK_PICK', choice: 'return' });
  }, [dispatchReward, isBootAsk, pickBootMode]);

  const onPickLeft = useCallback(() => {
    if (isBootAsk) {
      pickBootMode('explore');
      return;
    }
    dispatchReward({ type: 'ASK_PICK', choice: 'continue' });
  }, [dispatchReward, isBootAsk, pickBootMode]);

  const onPickRight = useCallback(() => {
    if (isBootAsk) {
      pickBootMode('companion');
      return;
    }
    dispatchReward({ type: 'ASK_PICK', choice: 'return' });
  }, [dispatchReward, isBootAsk, pickBootMode]);

  if (!isBootAsk && !isRewardAsk) return null;

  const title = isBootAsk ? '想要 探索 还是 陪伴？' : '继续出航 还是 返舱？';
  const leftLabel = isBootAsk ? '探索' : '继续出航';
  const rightLabel = isBootAsk ? '陪伴' : '返舱';
  const ringKey = isBootAsk ? 'boot-ask' : 'reward-ask';

  return (
    <div
      className="absolute inset-0 z-layer-mask flex flex-col items-center justify-center bg-gradient-to-b from-screen-bg via-eco-deep to-screen-bg text-white"
      style={{
        containerType: 'size',
        gap: 'clamp(2cqh, 3.1cqh, 4.1cqh)',
        paddingInline: 'clamp(4cqh, 6cqw, 8cqh)',
      }}
    >
      <div className="pointer-events-none absolute right-2 top-2 rounded-full bg-porthole-glow/30 px-2 py-0.5 text-[9px] font-bold text-porthole-glow ring-1 ring-porthole-glow/50">
        ASK MODE · 30s
      </div>
      <h2
        className="text-center font-semibold tracking-[0.07em]"
        style={{ fontSize: 'clamp(2.2cqh, 3.9cqw, 4.6cqh)' }}
      >
        {title}
      </h2>

      <div
        className="grid place-items-center rounded-full bg-white/5 ring-1 ring-white/20"
        style={{
          width: 'clamp(15cqh, 21cqw, 24cqh)',
          height: 'clamp(15cqh, 21cqw, 24cqh)',
          padding: 'clamp(1.2cqh, 1.8cqw, 2.2cqh)',
        }}
      >
        <CountdownRing
          key={ringKey}
          seconds={30}
          active
          onTimeout={onTimeout}
          label="倒计时"
          size={80}
        />
      </div>

      <div className="flex w-full items-center justify-center gap-[clamp(1.2cqh,2cqw,2.6cqh)]">
        <button
          type="button"
          onClick={onPickLeft}
          className="rounded-full bg-porthole-glow/90 font-semibold text-shell-bg shadow-[0_0_1.8cqh_rgba(79,209,255,0.35)] transition hover:brightness-110"
          style={{
            minWidth: 'clamp(10cqh, 16cqw, 18cqh)',
            paddingBlock: 'clamp(1.3cqh, 1.9cqw, 2.3cqh)',
            paddingInline: 'clamp(2.2cqh, 3.1cqw, 3.8cqh)',
            fontSize: 'clamp(1.6cqh, 2.6cqw, 3cqh)',
          }}
        >
          {leftLabel}
        </button>
        <button
          type="button"
          onClick={onPickRight}
          className="rounded-full bg-white/12 font-semibold text-white ring-1 ring-white/24 transition hover:bg-white/18"
          style={{
            minWidth: 'clamp(10cqh, 16cqw, 18cqh)',
            paddingBlock: 'clamp(1.3cqh, 1.9cqw, 2.3cqh)',
            paddingInline: 'clamp(2.2cqh, 3.1cqw, 3.8cqh)',
            fontSize: 'clamp(1.6cqh, 2.6cqw, 3cqh)',
          }}
        >
          {rightLabel}
        </button>
      </div>
    </div>
  );
}
