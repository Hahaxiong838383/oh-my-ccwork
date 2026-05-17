import { useAppStore } from '../store/app-store';

/**
 * FocusProgressBar —— 专注进度条（D5 P8 新增）
 *
 * 跟随 focusProgress（0-100）平滑增长，到 100% 触发 reward。
 * 4 阶段切图同步由 deriveFocusStage(progress) 在 setFocusProgress 内做。
 * 位置：底部贴 status 字幕条上方，宽 90cqw + 高 0.8cqh，左右居中。
 */
export function FocusProgressBar() {
  const focusMachine = useAppStore((s) => s.focusMachine);
  const focusProgress = useAppStore((s) => s.focusProgress);

  if (focusMachine !== 'running' && focusMachine !== 'rewarding') return null;

  const pct = Math.max(0, Math.min(100, focusProgress));

  return (
    <div
      className="pointer-events-none absolute left-1/2 z-layer-feedback"
      style={{
        bottom: '5.5cqh',
        transform: 'translateX(-50%)',
        width: '90cqw',
      }}
    >
      <div
        className="overflow-hidden rounded-full bg-white/12 backdrop-blur-sm ring-1 ring-white/15"
        style={{ height: '0.9cqh' }}
      >
        <div
          className="h-full rounded-full bg-gradient-to-r from-porthole-glow via-cyan-300 to-emerald-300 transition-[width] duration-200 ease-out"
          style={{
            width: `${pct}%`,
            boxShadow: '0 0 0.8cqh rgba(110,255,170,0.55)',
          }}
        />
      </div>
    </div>
  );
}
