export { bootTransition } from './boot-machine';
export { focusTransition } from './focus-machine';
export { rewardTransition, REWARD_TABLE, OPEN_ANIM_MS } from './reward-machine';
export {
  getScenePreset,
  SCENE_PRESETS,
  SCENE_LABELS,
  SCENE_ORDER,
  SCENE_KEYBOARD_MAP,
} from './jump-to-scene';
export type {
  BootEvent,
  FocusEvent,
  RewardEvent,
  Effect,
  TransitionResult,
  BootState,
  FocusMachineState,
  RewardMachineState,
  SceneId,
} from './types';

import { useAppStore } from '../store/app-store';
import { getScenePreset } from './jump-to-scene';
import type { SceneId, Effect } from './types';

const activeTimers = new Map<string, number>();

/**
 * applyEffects —— 执行 transition 返回的 effects 列表
 * timer 在 module-scope Map 里集中管理，避免多 useEffect 各自持有 setTimeout。
 */
export function applyEffects(effects: readonly Effect[], onTimer: (key: string) => void): void {
  const store = useAppStore.getState();
  for (const effect of effects) {
    switch (effect.type) {
      case 'startTimer': {
        const existing = activeTimers.get(effect.key);
        if (existing !== undefined) clearTimeout(existing);
        const id = window.setTimeout(() => {
          activeTimers.delete(effect.key);
          onTimer(effect.key);
        }, effect.ms);
        activeTimers.set(effect.key, id);
        break;
      }
      case 'clearTimer': {
        const existing = activeTimers.get(effect.key);
        if (existing !== undefined) {
          clearTimeout(existing);
          activeTimers.delete(effect.key);
        }
        break;
      }
      case 'clearAllTimers': {
        for (const id of activeTimers.values()) clearTimeout(id);
        activeTimers.clear();
        break;
      }
      case 'playSfx':
        // TODO D2 下午接 AudioContext
        if (import.meta.env.DEV) console.debug('[sfx]', effect.id);
        break;
      case 'setVoiceStatus':
        store.setVoiceStatus(effect.status);
        break;
      case 'setSubtitle':
        store.setSubtitle(effect.text);
        break;
      case 'addStardust':
        store.addStardust(effect.amount);
        break;
      case 'addFamilyCoin':
        store.addFamilyCoin(effect.amount);
        break;
      case 'setXiaokeEmotion':
        store.setXiaokeEmotion(effect.emotion);
        break;
      case 'setCurrentBoxLevel':
        store.setCurrentBoxLevel(effect.level);
        break;
      case 'pushOpenedBoxLevel':
        store.pushOpenedBoxLevel(effect.level);
        break;
    }
  }
}

/**
 * jumpToScene —— 跳关原子动作
 * clearAllTimers + hydrate 所有相关字段 + 切机器状态
 */
export function jumpToScene(scene: SceneId): void {
  // 清所有 timer
  for (const id of activeTimers.values()) clearTimeout(id);
  activeTimers.clear();

  const preset = getScenePreset(scene);
  const store = useAppStore.getState();
  store.setBootState(preset.bootState);
  store.setFocusMachine(preset.focusMachine);
  store.setRewardMachine(preset.rewardMachine);
  store.setCurrentBoxLevel(preset.currentBoxLevel);
  store.setVoiceStatus(preset.voiceStatus);
  store.setSubtitle(preset.subtitle);
  store.setXiaokeEmotion(preset.xiaokeEmotion);
  store.setSetupComplete(preset.setupComplete);
  // stardust/familyCoin 用 set 直接覆盖（add* 是增量）
  useAppStore.setState({
    stardust: preset.stardust,
    familyCoin: preset.familyCoin,
  });

  if (import.meta.env.DEV) console.debug('[jumpToScene]', scene);
}
