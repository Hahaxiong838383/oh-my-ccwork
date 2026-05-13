import { useUserStore } from '../store/user-store';

/**
 * 底部专注操作（z=40）
 *
 * V0.2 改造：M4 接入 askMode + focusMachine 后，
 *   - idle / asking 时显示"启航"主按钮
 *   - asking 展示双选项（探索 / 陪着我）
 *   - running 显示"返舱（开箱）"
 *   - confirmExit 触发模态二次确认
 *
 * demo 当前版本：单按钮占位，等 XState 接入后重写
 */
export function FocusControl() {
  const status = useUserStore((s) => s.focusStatus);
  const setFocus = useUserStore((s) => s.setFocus);
  const isRunning = status === 'running';

  return (
    <div className="flex items-center justify-center">
      <button
        onClick={() => setFocus(isRunning ? 'idle' : 'running', 'companion')}
        className={`w-44 rounded-full py-3 text-sm font-medium transition-transform active:scale-95 ${
          isRunning
            ? 'border border-porthole-glow/40 bg-white/10 text-white/80'
            : 'bg-porthole-glow text-screen-bg shadow-[0_0_24px_rgba(79,209,255,0.4)]'
        }`}
      >
        {isRunning ? '返舱（开箱）' : '启航'}
      </button>
    </div>
  );
}
