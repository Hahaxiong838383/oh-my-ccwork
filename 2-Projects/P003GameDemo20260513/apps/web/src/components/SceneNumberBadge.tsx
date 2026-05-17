import { useAppStore } from '../store/app-store';
import { deriveCurrentScene, SCENE_LABELS } from '../machines/jump-to-scene';

/**
 * SceneNumberBadge —— D5 P9 debug 工具：每个 scene 左下角数字标注
 *
 * SCENE_LABELS 如 "1. 开机欢迎" / "F. 关盖告别"，取 split('.')[0] 显示。
 * 最上层 z-index (z-[100])，便于 demo 验收时川哥指着数字反馈问题。
 * 交付前可在 Screen.tsx 删除此组件。
 */
export function SceneNumberBadge() {
  const bootState = useAppStore((s) => s.bootState);
  const focusMachine = useAppStore((s) => s.focusMachine);
  const focusMode = useAppStore((s) => s.focusMode);
  const rewardMachine = useAppStore((s) => s.rewardMachine);
  const currentBoxLevel = useAppStore((s) => s.currentBoxLevel);
  const farewellState = useAppStore((s) => s.farewellState);

  const current = deriveCurrentScene({
    bootState,
    focusMachine,
    focusMode,
    rewardMachine,
    currentBoxLevel,
    farewellState,
  });
  if (!current) return null;

  const num = SCENE_LABELS[current].split('.')[0];

  return (
    <div
      className="pointer-events-none absolute z-[100] flex items-center justify-center rounded bg-fuchsia-600/85 font-bold text-white shadow-lg"
      style={{
        left: '1.2cqw',
        bottom: '1.2cqh',
        minWidth: '2.6cqh',
        height: '2.6cqh',
        padding: '0 0.8cqh',
        fontSize: 'clamp(1.4cqh, 2.2cqw, 1.9cqh)',
        letterSpacing: '0.05em',
      }}
      aria-label={`DEBUG 场景编号 ${num}`}
    >
      {num}
    </div>
  );
}
