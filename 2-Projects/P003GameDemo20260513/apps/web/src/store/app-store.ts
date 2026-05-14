import { create } from 'zustand';

/**
 * V0.6 单一 store（B+C 方案 · 4 天 demo + 0.5 天 buffer）
 *
 * 三个机器的 state 落在这里，effect 走专门的 hooks。
 * 跳关用 jumpToScene 原子函数一次性 hydrate 所有相关字段。
 */

export type VoiceStatus = 'idle' | 'listening' | 'thinking' | 'speaking';
export type FocusStatus = 'idle' | 'running';
export type XiaokeEmotion = 'happy' | 'curious' | 'warm' | 'calm' | 'excited';

export type WifiSignal = 'strong' | 'medium' | 'weak' | 'disconnected';

export type BoxLevel = 'common' | 'rare' | 'epic' | 'legendary';

export type BootState =
  | 'unconfigured'
  | 'welcome'
  | 'nightReport'
  | 'askMode'
  | 'running';

export type FocusMachineState =
  | 'idle'
  | 'launching'
  | 'running'
  | 'paused'
  | 'confirmExit';

export type RewardMachineState =
  | 'idle'
  | 'openingBox'
  | 'showingReward'
  | 'ecoUnlock'
  | 'askMode'
  | 'done';

export type SceneId =
  | 'welcome'
  | 'nightReport'
  | 'askMode'
  | 'focusRunning'
  | 'boxCommon'
  | 'boxRare'
  | 'boxEpic'
  | 'boxLegendary'
  | 'ecoUnlock'
  | 'farewell';

export interface LEDState {
  on: boolean;
  brightness: 1 | 2 | 3;
  colorTemp: 1 | 2 | 3;
}

interface AppState {
  // —— 资产 ——
  stardust: number;
  familyCoin: number;
  addStardust: (n: number) => void;
  addFamilyCoin: (n: number) => void;

  // —— 语音对话 ——
  voiceStatus: VoiceStatus;
  subtitle: string;
  xiaokeEmotion: XiaokeEmotion;
  setVoiceStatus: (s: VoiceStatus) => void;
  setSubtitle: (s: string) => void;
  setXiaokeEmotion: (e: XiaokeEmotion) => void;

  // —— 专注循环（旧字段，过渡保留，新代码用 focusMachine）——
  focusStatus: FocusStatus;
  setFocusStatus: (s: FocusStatus) => void;

  // —— 三机器状态（V0.6 新增）——
  bootState: BootState;
  focusMachine: FocusMachineState;
  rewardMachine: RewardMachineState;
  setBootState: (s: BootState) => void;
  setFocusMachine: (s: FocusMachineState) => void;
  setRewardMachine: (s: RewardMachineState) => void;

  // —— 当前正在演的宝箱等级（V0.6 新增）——
  currentBoxLevel: BoxLevel | null;
  setCurrentBoxLevel: (level: BoxLevel | null) => void;

  // —— 首次保证 4 级宝箱队列（V0.6 新增）——
  openedBoxLevels: BoxLevel[];
  pushOpenedBoxLevel: (level: BoxLevel) => void;
  resetOpenedBoxLevels: () => void;

  // —— 设备模拟 ——
  lidOpen: boolean;
  toggleLid: () => void;

  // —— WiFi 信号 4 档（V0.6 新增，画外调试条切换）——
  wifiSignal: WifiSignal;
  setWifiSignal: (s: WifiSignal) => void;

  // —— 配网完成标记（V0.6 新增，画外两按钮控制）——
  setupComplete: boolean;
  setSetupComplete: (b: boolean) => void;

  // —— 设置面板（V0.6 新增，D4 实现 UI）——
  settingsOpen: boolean;
  setSettingsOpen: (b: boolean) => void;

  // —— 设置（外壳 LED 联动）——
  led: LEDState;
  toggleLED: () => void;
  cycleBrightness: () => void;
  cycleColorTemp: () => void;
  volume: number;
  setVolume: (v: number) => void;
}

const SESSION_KEY_OPENED_BOX_LEVELS = 'p003_opened_box_levels';

function loadOpenedBoxLevels(): BoxLevel[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY_OPENED_BOX_LEVELS);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is BoxLevel =>
      x === 'common' || x === 'rare' || x === 'epic' || x === 'legendary',
    );
  } catch {
    return [];
  }
}

function saveOpenedBoxLevels(levels: BoxLevel[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(SESSION_KEY_OPENED_BOX_LEVELS, JSON.stringify(levels));
  } catch {
    /* 配额满静默 */
  }
}

export const useAppStore = create<AppState>((set) => ({
  stardust: 1280,
  familyCoin: 50,
  addStardust: (n) => set((s) => ({ stardust: Math.max(0, s.stardust + n) })),
  addFamilyCoin: (n) => set((s) => ({ familyCoin: Math.max(0, s.familyCoin + n) })),

  voiceStatus: 'idle',
  subtitle: '',
  xiaokeEmotion: 'happy',
  setVoiceStatus: (voiceStatus) => set({ voiceStatus }),
  setSubtitle: (subtitle) => set({ subtitle }),
  setXiaokeEmotion: (xiaokeEmotion) => set({ xiaokeEmotion }),

  focusStatus: 'idle',
  setFocusStatus: (focusStatus) => set({ focusStatus }),

  bootState: 'unconfigured',
  focusMachine: 'idle',
  rewardMachine: 'idle',
  setBootState: (bootState) => set({ bootState }),
  setFocusMachine: (focusMachine) => set({ focusMachine }),
  setRewardMachine: (rewardMachine) => set({ rewardMachine }),

  currentBoxLevel: null,
  setCurrentBoxLevel: (currentBoxLevel) => set({ currentBoxLevel }),

  openedBoxLevels: loadOpenedBoxLevels(),
  pushOpenedBoxLevel: (level) =>
    set((s) => {
      if (s.openedBoxLevels.includes(level)) return {};
      const next = [...s.openedBoxLevels, level];
      saveOpenedBoxLevels(next);
      return { openedBoxLevels: next };
    }),
  resetOpenedBoxLevels: () => {
    saveOpenedBoxLevels([]);
    set({ openedBoxLevels: [] });
  },

  lidOpen: true,
  toggleLid: () => set((s) => ({ lidOpen: !s.lidOpen })),

  wifiSignal: 'disconnected',
  setWifiSignal: (wifiSignal) => set({ wifiSignal }),

  setupComplete: false,
  setSetupComplete: (setupComplete) =>
    set({
      setupComplete,
      wifiSignal: setupComplete ? 'strong' : 'disconnected',
      bootState: setupComplete ? 'welcome' : 'unconfigured',
    }),

  settingsOpen: false,
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),

  led: { on: true, brightness: 2, colorTemp: 1 },
  toggleLED: () => set((s) => ({ led: { ...s.led, on: !s.led.on } })),
  cycleBrightness: () =>
    set((s) => ({
      led: { ...s.led, brightness: (((s.led.brightness % 3) + 1) as 1 | 2 | 3) },
    })),
  cycleColorTemp: () =>
    set((s) => ({
      led: { ...s.led, colorTemp: (((s.led.colorTemp % 3) + 1) as 1 | 2 | 3) },
    })),
  volume: 70,
  setVolume: (v) => set({ volume: Math.round(Math.max(0, Math.min(100, v)) / 5) * 5 }),
}));
