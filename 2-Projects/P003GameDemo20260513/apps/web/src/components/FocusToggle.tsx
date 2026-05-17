import { useAppStore } from '../store/app-store';
import { useTransitionRunner } from '../hooks/useTransitionRunner';
import { jumpToScene } from '../machines';

/**
 * FocusToggle —— focusMachine 驱动的返舱/确认按钮
 *
 * idle      → 不显示（启航走 AskMode）
 * launching → 显示"出航中..."（disabled）
 * running   → 显示"返舱"按钮（点击 EXIT_REQUEST → confirmExit）
 * confirmExit → 显示"确定/取消"两个按钮
 * paused    → 显示"等待归来..."（disabled）
 *
 * 家族币 +10 由 focus-machine confirmExit→idle 的 effect 自动发放。
 */
export function FocusToggle() {
  const focusMachine = useAppStore((s) => s.focusMachine);
  const { dispatchFocus } = useTransitionRunner();

  if (focusMachine === 'idle') return null;

  if (focusMachine === 'launching') {
    return (
      <button
        type="button"
        disabled
        className="h-10 min-w-[120px] rounded-2xl border border-white/30 bg-white/5 px-4 text-sm font-semibold text-white/70"
      >
        出航中...
      </button>
    );
  }

  if (focusMachine === 'paused') {
    return (
      <button
        type="button"
        disabled
        className="h-10 min-w-[120px] rounded-2xl border border-amber-300/40 bg-amber-500/10 px-4 text-sm font-semibold text-amber-200"
      >
        等待归来...
      </button>
    );
  }

  if (focusMachine === 'confirmExit') {
    return (
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => {
            dispatchFocus({ type: 'EXIT_CONFIRM' });
            // D5 P15：确认返舱 → 让"太棒了 +10"字幕和 TTS 播 1.8s → 回开机欢迎
            window.setTimeout(() => jumpToScene('welcome'), 1_800);
          }}
          className="h-10 min-w-[80px] rounded-2xl bg-porthole-glow/90 px-3 text-sm font-semibold text-shell-bg shadow-[0_0_18px_rgba(79,209,255,0.4)] hover:brightness-110 active:scale-[0.98]"
        >
          确定
        </button>
        <button
          type="button"
          onClick={() => dispatchFocus({ type: 'EXIT_CANCEL' })}
          className="h-10 min-w-[80px] rounded-2xl border border-white/30 bg-white/10 px-3 text-sm font-semibold text-white hover:bg-white/20 active:scale-[0.98]"
        >
          取消
        </button>
      </div>
    );
  }

  // running
  return (
    <button
      type="button"
      onClick={() => dispatchFocus({ type: 'EXIT_REQUEST' })}
      className="h-10 min-w-[120px] rounded-2xl border border-white/50 bg-white/10 px-4 text-sm font-semibold text-white shadow-[0_0_18px_rgba(255,255,255,0.15)] transition hover:bg-white/15 active:scale-[0.98]"
    >
      返舱
    </button>
  );
}
