import { useAppStore } from '../store/app-store';

/**
 * FocusProgressBar —— 专注进度条（D5 P8 新增，D5 P12 对齐美术槽）
 *
 * 跟随 focusProgress（0-100）平滑增长，到 100% 触发 reward。
 * 位置：与背景图美术里画好的进度槽垂直重合（bottom ~7cqh + width 90cqw）。
 * z-index：z-layer-fx-weak（30），位于返舱按钮 z-layer-ui-normal（40）之下。
 */
export function FocusProgressBar() {
  const focusMachine = useAppStore((s) => s.focusMachine);
  const focusProgress = useAppStore((s) => s.focusProgress);

  if (focusMachine !== 'running' && focusMachine !== 'rewarding') return null;

  const pct = Math.max(0, Math.min(100, focusProgress));

  return (
    <div
      className="pointer-events-none absolute left-1/2 z-layer-fx-weak"
      style={{
        bottom: '7cqh',
        transform: 'translateX(-50%)',
        width: '90cqw',
      }}
    >
      <div
        className="overflow-hidden rounded-full"
        style={{ height: '1.2cqh' }}
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
