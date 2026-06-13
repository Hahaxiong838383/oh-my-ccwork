/**
 * 新手引导状态机（zustand）· 纯状态层，unit 无关
 *
 * 定时器 / 语音 / 表情等副作用全部在 TutorialManager（React effect），store 只管状态迁移：
 *   start(unitId) → step[0] speaking → (语音播完/定时到) → waiting | auto-next → … → 末步 → complete
 * 配表规则：30s 无操作提醒 ×3 后跳步；中途打断不标记完成，下次从 Step 1 重来（A03 §2.4）。
 */
import { create } from 'zustand';
import type { TutorialStep, TutorialTarget } from './tutorial-types';
import { TUTORIAL_UNITS, getUnit, getUnitStep } from './tutorial-units';

export type TutorialPhase =
  | 'speaking' // 当前步语音/演出进行中
  | 'waiting' // 播完，等用户操作（仅 waitFor 步）
  | 'celebrating' // 末步播放中（播完 → 衔接确认）
  | 'handoff'; // 末步+衔接语播完，显示「继续下一步/再来一次」，等用户按键（需求4）

interface TutorialState {
  isActive: boolean;
  /** 当前单元 id（'boarding' | 'settings' | …） */
  unitId: string;
  stepIndex: number;
  phase: TutorialPhase;
  /** 当前步已提醒次数（0~REMIND_MAX） */
  remindCount: number;
  /** 模拟设备视觉状态（单元1 演出层；其他单元不用） */
  panelOpen: boolean;
  lightOn: boolean;
  /** 各单元本地完成标记（localStorage 镜像，key = unit.storageKey） */
  completedUnits: Record<string, boolean>;
  /** store 内部代际：异步回调（playback_end/timer）凭代际作废，防旧轮信号串台 */
  generation: number;

  start: (unitId: string) => void;
  /** 用户操作到达：目标匹配当前等待 → 推进；返回是否消费 */
  advanceOnAction: (target: TutorialTarget) => boolean;
  /** 当前步语音播完（playback_end）或无语音步定时到：纯播报步自动推进，等待步转 waiting */
  onSpeechEnd: () => void;
  /** 30s 超时：remindCount+1；返回是否已到第 3 次（到了调用方播过渡语后 forceNext） */
  onRemindTick: () => { exceeded: boolean };
  /** 提醒 3 次无反应 / 跳过指令：强制进下一步 */
  forceNext: () => void;
  /** 单元完成：写 localStorage + 退出 */
  complete: () => void;
  /** 打断退出（点其他场景卡等）：不标记完成（A03 §2.4） */
  interrupt: () => void;
  /** 一键跳过全部新手引导（需求4）：标记所有单元已完成 + 退出，不再触发 */
  skipAll: () => void;
  /** 末步庆祝+衔接语播完 → 进衔接确认态：标记单元完成 + phase='handoff'（isActive 保持，等按键） */
  enterHandoff: () => void;
  /** 衔接确认「继续下一步」：有 nextUnitId → start 下一单元；末站 → complete 结束全部引导 */
  proceedNext: () => void;
  /** 衔接确认「再来一次」：从 step 0 重播当前单元 */
  replayUnit: () => void;
  /** 调试：清全部单元完成标记 + 重置 */
  resetForDebug: () => void;
}

function readCompletedUnits(): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const unit of TUTORIAL_UNITS) {
    try {
      result[unit.id] = localStorage.getItem(unit.storageKey) === 'true';
    } catch {
      result[unit.id] = false;
    }
  }
  return result;
}

function writeCompleted(unitId: string, value: boolean): void {
  const unit = getUnit(unitId);
  if (!unit) return;
  try {
    if (value) localStorage.setItem(unit.storageKey, 'true');
    else localStorage.removeItem(unit.storageKey);
  } catch {
    /* 隐私模式等存储不可用：引导仍可跑，只是不持久 */
  }
}

export function currentStep(s: { unitId: string; stepIndex: number }): TutorialStep | null {
  return getUnitStep(s.unitId, s.stepIndex);
}

export const useTutorialStore = create<TutorialState>((set, get) => ({
  isActive: false,
  unitId: 'settings',
  stepIndex: 0,
  phase: 'speaking',
  remindCount: 0,
  panelOpen: false,
  lightOn: true,
  completedUnits: readCompletedUnits(),
  generation: 0,

  start: (unitId) => {
    if (!getUnit(unitId)) return;
    set((s) => ({
      isActive: true,
      unitId,
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
    advanceToNext(set, get, visualFor(target));
    return true;
  },

  onSpeechEnd: () => {
    const s = get();
    if (!s.isActive) return;
    const step = currentStep(s);
    if (!step) return;
    if (s.phase === 'celebrating' || step.isUnitEnd) {
      // 末步播完 → 进衔接确认态（需求4），而非直接结束。正常路径走 TutorialManager
      // onPlaybackEnd 的 celebrating 分支；这里是语音降级兜底路径，确保按钮照样出。
      get().enterHandoff();
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
    advanceToNext(set, get, step?.waitFor ? visualFor(step.waitFor) : {});
  },

  complete: () => {
    const s = get();
    writeCompleted(s.unitId, true);
    set((prev) => ({
      isActive: false,
      completedUnits: { ...prev.completedUnits, [s.unitId]: true },
      panelOpen: false,
      generation: prev.generation + 1,
    }));
  },

  interrupt: () => {
    set((s) => ({
      isActive: false,
      panelOpen: false,
      generation: s.generation + 1,
    }));
  },

  skipAll: () => {
    for (const unit of TUTORIAL_UNITS) writeCompleted(unit.id, true);
    set((s) => ({
      isActive: false,
      panelOpen: false,
      completedUnits: Object.fromEntries(TUTORIAL_UNITS.map((u) => [u.id, true])),
      generation: s.generation + 1,
    }));
  },

  enterHandoff: () => {
    const s = get();
    if (!s.isActive) return;
    // 标记本单元完成（写 storage，刷新不丢）。关键：不 +generation——否则会触发 TutorialManager
    // 步进副作用 useEffect([…,generation]) 重跑、重播末步庆祝语。只切 phase，停在末步等按键。
    writeCompleted(s.unitId, true);
    set((prev) => ({
      phase: 'handoff',
      completedUnits: { ...prev.completedUnits, [s.unitId]: true },
    }));
  },

  proceedNext: () => {
    const s = get();
    if (!s.isActive) return;
    const unit = getUnit(s.unitId);
    const nextId = unit?.nextUnitId;
    if (nextId && getUnit(nextId)) {
      get().start(nextId); // start 自带 generation+1 + 重置到 step0
    } else {
      get().complete(); // 末站（无 nextUnitId）：真正结束全部引导
    }
  },

  replayUnit: () => {
    get().start(get().unitId); // 从 step0 重播当前单元
  },

  resetForDebug: () => {
    for (const unit of TUTORIAL_UNITS) writeCompleted(unit.id, false);
    set((s) => ({
      isActive: false,
      stepIndex: 0,
      phase: 'speaking',
      remindCount: 0,
      panelOpen: false,
      lightOn: true,
      completedUnits: readCompletedUnits(),
      generation: s.generation + 1,
    }));
  },
}));

/** 操作目标对应的单元1 演出层状态变化（其他单元的 target 无视觉副作用） */
function visualFor(target: TutorialTarget): Partial<TutorialState> {
  switch (target) {
    case 'open-panel':
      return { panelOpen: true };
    case 'close-panel':
      return { panelOpen: false };
    case 'light-off':
      return { lightOn: false };
    case 'light-on':
      return { lightOn: true };
    default:
      return {};
  }
}

function advanceToNext(
  set: (partial: Partial<TutorialState> | ((s: TutorialState) => Partial<TutorialState>)) => void,
  get: () => TutorialState,
  visual: Partial<TutorialState>,
): void {
  const s = get();
  const nextIndex = s.stepIndex + 1;
  const nextStep = getUnitStep(s.unitId, nextIndex);
  if (!nextStep) {
    // 越界兜底（理论上末步 isUnitEnd 在 onSpeechEnd 走 complete）
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
