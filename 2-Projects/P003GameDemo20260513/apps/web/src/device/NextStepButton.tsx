import { useAppStore } from '../store/app-store';
import { jumpToScene } from '../machines';
import { deriveCurrentScene, SCENE_ORDER } from '../machines/jump-to-scene';

/**
 * NextStepButton —— D5 P9 debug 工具：K1 开关右侧"下一步"按钮
 *
 * 推断当前 scene → 取 SCENE_ORDER[idx + 1] → jumpToScene。
 * 当前 scene 为 null（unconfigured / 中间态）→ 从 'welcome' 开始。
 * SCENE_ORDER 末尾循环回 'welcome'。
 * 交付前可在 DeviceFrame 删除此按钮。
 */
export function NextStepButton() {
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
  const idx = current ? SCENE_ORDER.indexOf(current) : -1;
  const next = SCENE_ORDER[(idx + 1) % SCENE_ORDER.length];

  return (
    <div className="flex flex-col items-center gap-1">
      <button
        type="button"
        onClick={() => jumpToScene(next)}
        className="h-10 w-10 rounded-full border border-white/35 bg-white/10 text-[10px] font-bold text-white/90 transition hover:bg-white/20 active:scale-95"
        aria-label={`下一步：${next}`}
        title={`下一步 → ${next}`}
      >
        下一步
      </button>
      <span className="text-[9px] tracking-[0.25em] text-white/35">DEBUG</span>
    </div>
  );
}
