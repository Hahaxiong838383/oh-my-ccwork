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
import { getExpressionRef, getExpressionSnapshot } from '../services/expression-snapshot';
import { EXPR_INTRO } from '../config/expression-intros';
import { pickNextBoxLevel } from '../config/boxes';
import type { SceneId, Effect, BootEvent, FocusEvent, RewardEvent } from './types';

const activeTimers = new Map<string, number>();

// D5 P7：短期去重，防 jumpToScene preset.subtitle 与 effect setSubtitle 同句重复 TTS
let lastTtsText = '';
let lastTtsAt = 0;
const TTS_DEDUP_MS = 800;

function getVoiceWsUrlInternal(): string {
  const envUrl = import.meta.env.VITE_VOICE_WS_URL as string | undefined;
  if (envUrl && envUrl.trim()) return envUrl;
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${window.location.host}/ws/voice`;
}

export function ttsSpeak(text: string, onAudioStart?: () => void): void {
  const trimmed = text.trim();
  if (trimmed.length === 0) return;
  const expr = getExpressionRef().expr;
  const spokenText = `${EXPR_INTRO[expr]}${trimmed}`;
  const now = Date.now();
  if (spokenText === lastTtsText && now - lastTtsAt < TTS_DEDUP_MS) return;
  lastTtsText = spokenText;
  lastTtsAt = now;
  // D5 P20 兜底：若 3s 内 TTS 未到达，仍然显示字幕（防 server 出错字幕永远不显示）
  let fired = false;
  const fireOnce = () => {
    if (fired) return;
    fired = true;
    try { onAudioStart?.(); } catch (err) { console.warn('[ttsSpeak] cb fail', err); }
  };
  const fallback = onAudioStart ? window.setTimeout(fireOnce, 3_000) : 0;
  try {
    const client = getSharedVoiceClient();
    void (async () => {
      try {
        await client.connect(getVoiceWsUrlInternal());
        client.sayDirect(spokenText, () => {
          if (fallback) window.clearTimeout(fallback);
          fireOnce();
        });
      } catch (err) {
        console.warn('[ttsSpeak] failed', err);
        if (fallback) window.clearTimeout(fallback);
        fireOnce();
      }
    })();
  } catch (err) {
    console.warn('[ttsSpeak] voice client unavailable', err);
    if (fallback) window.clearTimeout(fallback);
    fireOnce();
  }
}

export function prewarmVoiceClient(): void {
  try {
    const client = getSharedVoiceClient();
    void client.connect(getVoiceWsUrlInternal()).catch((err) => {
      console.warn('[prewarmVoiceClient] connect failed', err);
    });
  } catch (err) {
    console.warn('[prewarmVoiceClient] unavailable', err);
  }
}

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
      case 'setSubtitle': {
        const text = effect.text;
        const spokenText = text.trim().length > 0 ? `${EXPR_INTRO[getExpressionRef().expr]}${text}` : text;
        if (effect.silent || text.trim().length === 0) {
          // 静默或空文本：立即 set（清字幕场景）
          store.setSubtitle(spokenText);
        } else {
          // D5 P20：字幕等到 TTS 第一段音频到达再显示，修字幕提前 TTS
          // 先清掉旧字幕（避免错位旧文本停留），等 callback 再 set 新字幕
          store.setSubtitle('');
          ttsSpeak(text, () => {
            useAppStore.getState().setSubtitle(spokenText);
          });
        }
        break;
      }
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
      case 'setFocusProgress':
        store.setFocusProgress(effect.progress);
        break;
      case 'setFocusStage':
        store.setFocusStage(effect.stage);
        break;
      case 'setFocusMode':
        store.setFocusMode(effect.mode);
        break;
      case 'setFocusStartedAt':
        store.setFocusStartedAt(effect.timestamp);
        break;
      case 'dispatchRewardEvent':
        internalDispatchReward(effect.event);
        break;
      case 'dispatchRandomBox': {
        // D5 P16：每次出航奖励的宝箱品质都随机（加权 + 首次保证 4 级队列）
        const level = pickNextBoxLevel(useAppStore.getState().openedBoxLevels);
        internalDispatchReward({ type: 'OPEN_BOX', level });
        break;
      }
      case 'askReturnSubtitle': {
        // D5 P23：按 focusMode 选字幕（静思/出航）
        const mode = useAppStore.getState().focusMode;
        const text = mode === 'companion' ? '继续静思 还是 返舱？' : '继续出航 还是 返舱？';
        store.setSubtitle('');
        ttsSpeak(text, () => {
          useAppStore.getState().setSubtitle(text);
        });
        break;
      }
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

    // D6 P2：FOCUS_REWARD_READY 点击后等 1.5s 才开宝箱（让 stage='full' 黄色美术
    // 有展示时间）。timer 到了立即 dispatchRandomBox，跟原 D5 P16 逻辑一致。
    case 'rewardOpenDelay': {
      const level = pickNextBoxLevel(useAppStore.getState().openedBoxLevels);
      internalDispatchReward({ type: 'OPEN_BOX', level });
      break;
    }

    // reward machine
    case 'openAnim': {
      // D5 P7：携带 store.currentBoxLevel，让 reward-machine 拿到正确文案触发 TTS
      const level = useAppStore.getState().currentBoxLevel ?? 'common';
      internalDispatchReward({ type: 'OPEN_ANIM_END', level });
      break;
    }
    case 'rewardShown': {
      // showingReward → ECO_CHECK：legendary 必触发 ecoUnlock，其它级走 askMode
      // （demo 演示节奏可控，避免每次 OPEN_BOX 都进 ecoUnlock 节奏过密）
      // D6 P9：夜航报告路径（bootState='nightReport'）走完 reward 后直接进 boot askMode
      // （"今天想出航还是静思呢"），不进 reward 自己的 askMode（"继续/返舱"）。
      const state = useAppStore.getState();
      if (state.bootState === 'nightReport') {
        state.setRewardMachine('idle');
        state.setCurrentBoxLevel(null);
        state.setSubtitle('');
        internalDispatchBoot({ type: 'NIGHT_REPORT_DONE' });
        break;
      }
      const level = state.currentBoxLevel;
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
  // D6 P1 hotfix v2：跳关时强制 snap()（不复用 3s 缓存），保证每场字幕用最新表情。
  // 牺牲带宽（每跳关一次 Gemini 调用）换实时表情，对 demo 体验更重要。
  void getExpressionSnapshot().snap();
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

  // D5 P7：跳关字幕也要 TTS（含关盖告别的"指挥官，明天见～"等）
  // 短期去重保护 vs effect 重复触发同一文本
  if (preset.subtitle && preset.subtitle.trim().length > 0) {
    ttsSpeak(preset.subtitle);
  }

  if (import.meta.env.DEV) console.debug('[jumpToScene]', scene);
}
