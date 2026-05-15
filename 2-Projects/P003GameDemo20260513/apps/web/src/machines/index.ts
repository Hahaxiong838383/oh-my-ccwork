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
import { getSharedVoiceClient } from '../services/voice-client';
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
      case 'tickFocusProgress':
        store.setFocusProgress(effect.progress);
        break;
      case 'setFocusStartedAt':
        store.setFocusStartedAt(effect.timestamp);
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
  if (import.meta.env.DEV) console.debug('[boot]', current, '→', state, 'event=', event.type);
  if (state !== current) useAppStore.getState().setBootState(state);
  applyEffects(effects, defaultTimerRouter);
}

function internalDispatchFocus(event: FocusEvent): void {
  const current = useAppStore.getState().focusMachine;
  const { state, effects } = focusTransition(current, event);
  if (import.meta.env.DEV) console.debug('[focus]', current, '→', state, 'event=', event.type);
  if (state !== current) useAppStore.getState().setFocusMachine(state);
  applyEffects(effects, defaultTimerRouter);
}

function internalDispatchReward(event: RewardEvent): void {
  const current = useAppStore.getState().rewardMachine;
  const { state, effects } = rewardTransition(current, event);
  if (import.meta.env.DEV) console.debug('[reward]', current, '→', state, 'event=', event.type);
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
    case 'rewardShown': {
      // showingReward → ECO_CHECK：legendary 必触发 ecoUnlock，其它级走 askMode
      // （demo 演示节奏可控，避免每次 OPEN_BOX 都进 ecoUnlock 节奏过密）
      const level = useAppStore.getState().currentBoxLevel;
      internalDispatchReward({ type: 'ECO_CHECK', hasUnlock: level === 'legendary' });
      break;
    }
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
  // 中断任何在途 ASR/LLM/TTS 会话，避免旧 turn 的回包污染新场景的 subtitle/voiceStatus
  try {
    const client = getSharedVoiceClient();
    client.bargeIn();
    client.stopRecording();
  } catch {
    // voice-client 还没初始化或环境不支持，跳关本身仍然可推进
  }

  // 清所有 timer
  for (const id of activeTimers.values()) clearTimeout(id);
  activeTimers.clear();

  const preset = getScenePreset(scene);
  const store = useAppStore.getState();

  // box* / farewell preset 走"先 hydrate 基线 → 再 dispatch 启动动画"模式
  // 让 reward/farewell timer 真正起来，避免 stuck 在 openingBox 静止状态
  const isBoxScene =
    scene === 'boxCommon' || scene === 'boxRare' ||
    scene === 'boxEpic' || scene === 'boxLegendary';
  const isFarewellScene = scene === 'farewell';
  const isFocusScene = scene === 'focusRunning' || scene === 'focusCompanion';

  store.setBootState(preset.bootState);
  store.setFocusMachine(preset.focusMachine);
  store.setFocusMode(preset.focusMode);
  // box scene 先 reward=idle + boxLevel=null，下面 dispatch OPEN_BOX 走完整 transition
  store.setRewardMachine(isBoxScene ? 'idle' : preset.rewardMachine);
  store.setCurrentBoxLevel(isBoxScene ? null : preset.currentBoxLevel);
  store.setVoiceStatus(preset.voiceStatus);
  store.setSubtitle(preset.subtitle);
  store.setXiaokeEmotion(preset.xiaokeEmotion);
  store.setSetupComplete(preset.setupComplete);
  store.setFarewellState('hidden');
  if (isFocusScene) {
    store.setFocusStartedAt(Date.now());
    store.setFocusProgress(0);
    store.setFocusStage('locked');
  }
  useAppStore.setState({
    stardust: preset.stardust,
    familyCoin: preset.familyCoin,
  });

  if (isBoxScene && preset.currentBoxLevel) {
    internalDispatchReward({ type: 'OPEN_BOX', level: preset.currentBoxLevel });
  }

  if (isFarewellScene) {
    // 1.5s wave → 0.5s shutdown 过渡 → 停在 shutdown 黑屏（演示退场）
    store.setFarewellState('waving');
    const wavingId = window.setTimeout(() => {
      activeTimers.delete('farewellWave');
      useAppStore.getState().setFarewellState('shutdown');
    }, 1_500);
    activeTimers.set('farewellWave', wavingId);
  }

  if (import.meta.env.DEV) console.debug('[jumpToScene]', scene);
}
