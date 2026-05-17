import { useCallback } from 'react';
import { CountdownRing } from '../components/CountdownRing';
import { useTransitionRunner } from '../hooks/useTransitionRunner';
import { useAppStore } from '../store/app-store';

const ASKMODE_BG = '/assets/askmode-bg.png';

// D5 P7：sayDirect 已收归 applyEffects 默认 TTS，scene 不再重复触发

interface StarSpec {
  id: string;
  left: string;
  top: string;
  size: string;
  delay: string;
  duration: string;
  drift: string;
}

// 仅左侧舷窗（图里右侧是金属舱壁，无星空）
const STARS: readonly StarSpec[] = [
  { id: 'a1', left: '4cqw', top: '12cqh', size: '0.9cqw', delay: '-0.4s', duration: '3.4s', drift: '2.5cqw' },
  { id: 'a2', left: '12cqw', top: '24cqh', size: '0.6cqw', delay: '-1.8s', duration: '3.0s', drift: '-2.0cqw' },
  { id: 'a3', left: '20cqw', top: '8cqh', size: '0.8cqw', delay: '-2.6s', duration: '3.6s', drift: '1.8cqw' },
  { id: 'a4', left: '6cqw', top: '38cqh', size: '0.7cqw', delay: '-1.0s', duration: '3.2s', drift: '2.2cqw' },
  { id: 'a5', left: '24cqw', top: '20cqh', size: '0.6cqw', delay: '-3.0s', duration: '3.8s', drift: '-1.6cqw' },
];

export function AskMode() {
  const bootState = useAppStore((s) => s.bootState);
  const rewardMachine = useAppStore((s) => s.rewardMachine);
  const isBootAsk = bootState === 'askMode';
  const isRewardAsk = rewardMachine === 'askMode';
  const { dispatchBoot, dispatchFocus, dispatchReward } = useTransitionRunner();

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

  // 开机询问：美术化（与 Welcome 同风格：图 + 星点 + 表情屏绿光 + TTS）
  if (isBootAsk) {
    return (
      <div
        className="absolute inset-0 z-layer-mask overflow-hidden"
        style={{ containerType: 'size', isolation: 'isolate' }}
      >
        <img
          src={ASKMODE_BG}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
          draggable={false}
        />

        <div
          className="pointer-events-none absolute inset-0"
          style={{
            clipPath: 'ellipse(28% 42% at 16% 28%)',
            WebkitClipPath: 'ellipse(28% 42% at 16% 28%)',
          }}
          aria-hidden
        >
          {STARS.map((star) => {
            const styleVars = { '--star-drift': star.drift } as React.CSSProperties;
            return (
              <span
                key={star.id}
                className="absolute rounded-full bg-white"
                style={{
                  left: star.left,
                  top: star.top,
                  width: star.size,
                  height: star.size,
                  ...styleVars,
                  animation: `askmode-star-drift ${star.duration} ease-in-out ${star.delay} infinite both`,
                  boxShadow: '0 0 5px rgba(255,255,255,0.85)',
                }}
              />
            );
          })}
        </div>

        <div
          className="askmode-eye-glow pointer-events-none absolute rounded-full"
          style={{
            left: '47cqw',
            top: '28cqh',
            width: '14cqw',
            height: '11cqh',
            background:
              'radial-gradient(ellipse at center, rgba(110,255,170,0.85) 0%, rgba(110,255,170,0.3) 40%, transparent 70%)',
            filter: 'blur(2.2cqh)',
            animation: 'askmode-eye-glow 1.8s ease-in-out infinite',
          }}
          aria-hidden
        />

        <button
          type="button"
          onClick={onPickLeft}
          aria-label="出航"
          className="absolute cursor-pointer rounded-2xl border-0 bg-transparent transition-transform active:scale-95"
          style={{
            left: '4cqw',
            top: '75cqh',
            width: '40cqw',
            height: '18cqh',
          }}
        />

        <button
          type="button"
          onClick={onPickRight}
          aria-label="静思"
          className="absolute cursor-pointer rounded-2xl border-0 bg-transparent transition-transform active:scale-95"
          style={{
            left: '46cqw',
            top: '75cqh',
            width: '41cqw',
            height: '18cqh',
          }}
        />

        <div
          className="pointer-events-none absolute"
          style={{ right: '3cqw', bottom: '4cqh', opacity: 0.6 }}
        >
          <CountdownRing
            key="boot-ask"
            seconds={30}
            active
            onTimeout={onTimeout}
            label=""
            size={36}
          />
        </div>

        <style>{`
          @keyframes askmode-star-drift {
            0%, 100% { transform: translateX(0) scale(0.65); opacity: 0.25; }
            50% { transform: translateX(var(--star-drift)) scale(1.25); opacity: 1; }
          }
          .askmode-eye-glow {
            mix-blend-mode: screen;
          }
          @supports not (mix-blend-mode: screen) {
            .askmode-eye-glow {
              mix-blend-mode: normal;
              opacity: 0.5;
            }
          }
          @keyframes askmode-eye-glow {
            0%, 100% { opacity: 0.25; transform: scale(0.9); }
            50% { opacity: 0.85; transform: scale(1.12); }
          }
        `}</style>
      </div>
    );
  }

  // 奖励后询问：保留原 UI（继续出航 / 返舱）
  const title = '继续出航 还是 返舱？';
  const leftLabel = '继续出航';
  const rightLabel = '返舱';

  return (
    <div
      className="absolute inset-0 z-layer-mask flex flex-col items-center justify-center bg-gradient-to-b from-screen-bg via-eco-deep to-screen-bg text-white"
      style={{
        containerType: 'size',
        gap: 'clamp(2cqh, 3.1cqh, 4.1cqh)',
        paddingInline: 'clamp(4cqh, 6cqw, 8cqh)',
      }}
    >
      <h2
        className="text-center font-semibold tracking-[0.07em]"
        style={{ fontSize: 'clamp(2.2cqh, 3.9cqw, 4.6cqh)' }}
      >
        {title}
      </h2>

      {/* D5 P8：倒计时位置/尺寸与 isBootAsk 一致——右下小 ring 36px */}
      <div
        className="pointer-events-none absolute"
        style={{ right: '3cqw', bottom: '4cqh', opacity: 0.6 }}
      >
        <CountdownRing
          key="reward-ask"
          seconds={30}
          active
          onTimeout={onTimeout}
          label=""
          size={36}
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
