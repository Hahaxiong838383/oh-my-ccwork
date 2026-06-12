/**
 * 设置引导状态机（zustand）· 纯状态层
 *
 * 定时器 / 语音 / 表情等副作用全部在 TutorialManager（React effect），store 只管状态迁移：
 *   start → step[0] speaking → (playback_end) → waiting | auto-next → … → step '6' → complete
 * 配表规则：30s 无操作提醒 ×3 后跳步；中途打断不标记完成，下次从 Step 1 重来（A03 §2.4）。
 */
import { create } from 'zustand';
import {
  TUTORIAL_SETTINGS_STORAGE_KEY,
  getStepByIndex,
  type TutorialStep,
  type TutorialTarget,
} from './tutorial-settings';

export type TutorialPhase =
  | 'speaking' // 当前步语音播放中
  | 'waiting' // 语音播完，等用户操作（仅 waitFor 步）
  | 'celebrating'; // 末步播放中（播完 = complete）

interface TutorialState {
  isActive: boolean;
  stepIndex: number;
  phase: TutorialPhase;
  /** 当前步已提醒次数（0~REMIND_MAX） */
  remindCount: number;
  /** 模拟设备视觉状态（步骤推进的演出层） */
  panelOpen: boolean;
  lightOn: boolean;
  /** 本地 tutorial_settings 标记（localStorage 镜像） */
  completed: boolean;
  /** store 内部代际：异步回调（playback_end/timer）凭代际作废，防旧轮信号串台 */
  generation: number;

  start: () => void;
  /** 用户操作到达：目标匹配当前等待 → 推进；返回是否消费 */
  advanceOnAction: (target: TutorialTarget) => boolean;
  /** 当前步语音播完（playback_end）：纯播报步自动推进，等待步转 waiting */
  onSpeechEnd: () => void;
  /** 30s 超时：remindCount+1；返回是否已到第 3 次（到了调用方播过渡语后 forceNext） */
  onRemindTick: () => { exceeded: boolean };
  /** 提醒 3 次无反应 / 跳过指令：强制进下一步 */
  forceNext: () => void;
  /** 单元完成：写 localStorage + 退出 */
  complete: () => void;
  /** 打断退出（点其他场景卡等）：不标记完成（A03 §2.4） */
  interrupt: () => void;
  /** 调试：清完成标记 + 重置 */
  resetForDebug: () => void;
}

function readCompleted(): boolean {
  try {
    return localStorage.getItem(TUTORIAL_SETTINGS_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeCompleted(value: boolean): void {
  try {
    if (value) localStorage.setItem(TUTORIAL_SETTINGS_STORAGE_KEY, 'true');
    else localStorage.removeItem(TUTORIAL_SETTINGS_STORAGE_KEY);
  } catch {
    /* 隐私模式等存储不可用：引导仍可跑，只是不持久 */
  }
}

export function currentStep(s: { stepIndex: number }): TutorialStep | null {
  return getStepByIndex(s.stepIndex);
}

export const useTutorialStore = create<TutorialState>((set, get) => ({
  isActive: false,
  stepIndex: 0,
  phase: 'speaking',
  remindCount: 0,
  panelOpen: false,
  lightOn: true,
  completed: readCompleted(),
  generation: 0,

  start: () => {
    set((s) => ({
      isActive: true,
      stepIndex: 0,
      phase: 'speaking',
      remindCount: 0,
      panelOpen: false,
      lightOn: true,
      generation: s.generation + 1,
    }));
  },

  advanceOnAction: (target) => {
    const s = get();
    if (!s.isActive) return false;
    const step = currentStep(s);
    if (!step) return false;
    // speaking 期也接受操作（孩子手快：话没说完就点了，配表未禁止，照推进）
    if (step.waitFor !== target) return false;

    // 演出层状态
    const visual: Partial<TutorialState> = {};
    if (target === 'open-panel') visual.panelOpen = true;
    if (target === 'close-panel') visual.panelOpen = false;
    if (target === 'light-off') visual.lightOn = false;
    if (target === 'light-on') visual.lightOn = true;

    advanceToNext(set, get, visual);
    return true;
  },

  onSpeechEnd: () => {
    const s = get();
    if (!s.isActive) return;
    const step = currentStep(s);
    if (!step) return;
    if (s.phase === 'celebrating' || step.isUnitEnd) {
      get().complete();
      return;
    }
    if (step.waitFor) {
      set({ phase: 'waiting' });
      return;
    }
    advanceToNext(set, get, {});
  },

  onRemindTick: () => {
    const s = get();
    if (!s.isActive || s.phase !== 'waiting') return { exceeded: false };
    const next = s.remindCount + 1;
    set({ remindCount: next });
    return { exceeded: next >= 3 };
  },

  forceNext: () => {
    const s = get();
    if (!s.isActive) return;
    // 跳步也要把演出层带到位（没点开面板就跳 = 替孩子打开，后续步骤才有面板可指）
    const step = currentStep(s);
    const visual: Partial<TutorialState> = {};
    if (step?.waitFor === 'open-panel') visual.panelOpen = true;
    if (step?.waitFor === 'close-panel') visual.panelOpen = false;
    if (step?.waitFor === 'light-off') visual.lightOn = false;
    if (step?.waitFor === 'light-on') visual.lightOn = true;
    advanceToNext(set, get, visual);
  },

  complete: () => {
    writeCompleted(true);
    set((s) => ({
      isActive: false,
      completed: true,
      panelOpen: false,
      generation: s.generation + 1,
    }));
  },

  interrupt: () => {
    set((s) => ({
      isActive: false,
      panelOpen: false,
      generation: s.generation + 1,
    }));
  },

  resetForDebug: () => {
    writeCompleted(false);
    set((s) => ({
      isActive: false,
      stepIndex: 0,
      phase: 'speaking',
      remindCount: 0,
      panelOpen: false,
      lightOn: true,
      completed: false,
      generation: s.generation + 1,
    }));
  },
}));

function advanceToNext(
  set: (partial: Partial<TutorialState> | ((s: TutorialState) => Partial<TutorialState>)) => void,
  get: () => TutorialState,
  visual: Partial<TutorialState>,
): void {
  const s = get();
  const nextIndex = s.stepIndex + 1;
  const nextStep = getStepByIndex(nextIndex);
  if (!nextStep) {
    // 越界兜底（理论上 '6' 是 isUnitEnd，在 onSpeechEnd 走 complete）
    get().complete();
    return;
  }
  set((prev) => ({
    ...visual,
    stepIndex: nextIndex,
    phase: nextStep.isUnitEnd ? 'celebrating' : 'speaking',
    remindCount: 0,
    generation: prev.generation + 1,
  }));
}
