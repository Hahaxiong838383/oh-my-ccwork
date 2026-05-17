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
        // D5 P14：用 % 相对 screen-canvas 父级（800×480），避免依赖 containerType
        // 撤回 D5 P13 的 containerType 副作用——字幕/padding 都跟着缩了
        bottom: '6%',
        transform: 'translateX(-50%)',
        width: '88%',
      }}
    >
      <div
        className="overflow-hidden rounded-full"
        style={{ height: '6px' }}
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
