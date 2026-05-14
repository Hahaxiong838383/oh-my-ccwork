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
import { bootTransition } from './boot-machine';
import { focusTransition } from './focus-machine';
import { rewardTransition } from './reward-machine';
import type { SceneId, Effect, BootEvent, FocusEvent, RewardEvent } from './types';

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
 * 内部 dispatch 函数（不依赖 React hook，直接读写 store）
 * 用于 timer router 自动 fire next event。
 */
function internalDispatchBoot(event: BootEvent): void {
  const current = useAppStore.getState().bootState;
  const { state, effects } = bootTransition(current, event);
  if (state !== current) useAppStore.getState().setBootState(state);
  applyEffects(effects, defaultTimerRouter);
}

function internalDispatchFocus(event: FocusEvent): void {
  const current = useAppStore.getState().focusMachine;
  const { state, effects } = focusTransition(current, event);
  if (state !== current) useAppStore.getState().setFocusMachine(state);
  applyEffects(effects, defaultTimerRouter);
}

function internalDispatchReward(event: RewardEvent): void {
  const current = useAppStore.getState().rewardMachine;
  const { state, effects } = rewardTransition(current, event);
  if (state !== current) useAppStore.getState().setRewardMachine(state);
  applyEffects(effects, defaultTimerRouter);
}

/**
 * defaultTimerRouter —— 全局 timer key → 对应机器 dispatch 路由
 *
 * boot-machine / focus-machine / reward-machine 里 startTimer 的 key
 * 必须在这里有对应 case，否则 timer 归零无人接管。
 *
 * 注意：暂离 'pauseDetect' 触发到达后真实硬件会强制下线，demo 模式
 * 我们不强制（让川哥按"完成配网"再演一遍），所以这里不 dispatch。
 */
export function defaultTimerRouter(key: string): void {
  switch (key) {
    // boot machine
    case 'welcome':
      internalDispatchBoot({ type: 'WELCOME_END' });
      break;
    case 'nightReport':
      internalDispatchBoot({ type: 'NIGHT_REPORT_DONE' });
      break;
    case 'askMode':
      internalDispatchBoot({ type: 'ASK_MODE_TIMEOUT' });
      break;

    // focus machine
    case 'launch':
      internalDispatchFocus({ type: 'LAUNCH_ANIM_END' });
      break;
    case 'pauseDetect':
      // demo 模式不强制离线，由川哥手动切场景演
      if (import.meta.env.DEV) console.debug('[timer] pauseDetect fired (demo: ignored)');
      break;
    case 'exitConfirm':
      internalDispatchFocus({ type: 'EXIT_TIMEOUT' });
      break;

    // reward machine
    case 'openAnim':
      internalDispatchReward({ type: 'OPEN_ANIM_END' });
      break;
    case 'ecoAnim':
      internalDispatchReward({ type: 'ECO_DONE' });
      break;
    case 'rewardAsk':
      internalDispatchReward({ type: 'ASK_TIMEOUT' });
      break;

    default:
      if (import.meta.env.DEV) console.warn('[timer] unrouted key:', key);
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
