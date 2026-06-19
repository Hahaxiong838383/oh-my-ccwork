import { create } from 'zustand';

/**
 * V0.6 单一 store（B+C 方案 · 4 天 demo + 0.5 天 buffer）
 *
 * 三个机器的 state 落在这里，effect 走专门的 hooks。
 * 跳关用 jumpToScene 原子函数一次性 hydrate 所有相关字段。
 */

export type VoiceStatus = 'idle' | 'listening' | 'thinking' | 'speaking';
/** 字幕富文本：committed=本轮已说完分句累积(置灰)，active=当前分句已显示部分(高亮)。null=无富文本字幕 */
export type SubtitleRich = { committed: string; active: string } | null;
export type XiaokeEmotion = 'happy' | 'curious' | 'warm' | 'calm' | 'excited';
export type FarewellState = 'hidden' | 'waving' | 'shutdown';

export type WifiSignal = 'strong' | 'medium' | 'weak' | 'disconnected';

export type BoxLevel = 'common' | 'rare' | 'epic' | 'legendary';
export type EcoLevel = 1 | 2 | 3 | 4;

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
  | 'rewarding'
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
  | 'focusCompanion'
  | 'boxCommon'
  | 'boxRare'
  | 'boxEpic'
  | 'boxLegendary'
  | 'ecoUnlock'
  | 'farewell';

// focus 模式：出航（explore）/ 静思（companion）/ 未进入（null）
// 由 jumpToScene 或 dispatchFocus(LAUNCH) 设置
export type FocusMode = 'explore' | 'companion' | null;
export type FocusStage = 'locked' | 'active' | 'openable' | 'full';

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
  // 字幕富文本（打字机专用）：committed=本轮已说完的分句累积（置灰），active=当前正在说的分句已显示部分（高亮）。
  // 治"逐分句整句替换"的视觉跳动——已说内容保留累积，当前句逐字接续，而非整行瞬替。
  // 与 subtitle 字符串互斥：走字符串路径(ASR/错误/状态机)时清 rich，走打字机时清 subtitle 字符串。
  subtitleRich: SubtitleRich;
  xiaokeEmotion: XiaokeEmotion;
  setVoiceStatus: (s: VoiceStatus) => void;
  setSubtitle: (s: string) => void;
  setSubtitleRich: (r: SubtitleRich) => void;
  setXiaokeEmotion: (e: XiaokeEmotion) => void;

  // —— 三机器状态（V0.6）——
  bootState: BootState;
  focusMachine: FocusMachineState;
  rewardMachine: RewardMachineState;
  setBootState: (s: BootState) => void;
  setFocusMachine: (s: FocusMachineState) => void;
  setRewardMachine: (s: RewardMachineState) => void;

  // —— focus 当前模式（V0.7 新增，跳关 + LAUNCH 都会设置）——
  focusMode: FocusMode;
  setFocusMode: (m: FocusMode) => void;
  focusProgress: number;
  focusStage: FocusStage;
  focusStartedAt: number | null;
  focusSpeed: number;
  // D5 P8：每个 focus stage 切图间隔（ms），默认 2000；4 阶段共 4×N 秒满
  focusStageDurationMs: number;
  setFocusProgress: (p: number) => void;
  setFocusStage: (s: FocusStage) => void;
  setFocusStartedAt: (t: number | null) => void;
  setFocusSpeed: (s: number) => void;
  setFocusStageDurationMs: (ms: number) => void;

  // —— 当前正在演的宝箱等级（V0.6 新增）——
  currentBoxLevel: BoxLevel | null;
  setCurrentBoxLevel: (level: BoxLevel | null) => void;

  // —— 生态缸等级（D4 P9 新增）——
  ecoLevel: EcoLevel;
  setEcoLevel: (n: EcoLevel) => void;

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

  // —— 配网过渡视频请求（DebugBar 触发，SetupGuide 消费）——
  setupVideoRequested: boolean;
  setSetupVideoRequested: (b: boolean) => void;
  cameraUnavailable: boolean;
  setCameraUnavailable: (b: boolean) => void;
  cameraPreview: boolean;
  setCameraPreview: (b: boolean) => void;

  // —— 设置面板（V0.6 新增，D4 实现 UI）——
  settingsOpen: boolean;
  setSettingsOpen: (b: boolean) => void;

  // —— Farewell 关盖告别状态（D3 新增）——
  farewellState: FarewellState;
  setFarewellState: (s: FarewellState) => void;

  // —— 设置（外壳 LED 联动）——
  led: LEDState;
  toggleLED: () => void;
  cycleBrightness: () => void;
  cycleColorTemp: () => void;
  volume: number;
  setVolume: (v: number) => void;
}

const SESSION_KEY_OPENED_BOX_LEVELS = 'p003_opened_box_levels';
const SESSION_KEY_CAMERA_UNAVAILABLE = 'p003_camera_unavailable';

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

function loadCameraUnavailable(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.sessionStorage.getItem(SESSION_KEY_CAMERA_UNAVAILABLE) === '1';
  } catch {
    return false;
  }
}

function saveCameraUnavailable(flag: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    if (flag) {
      window.sessionStorage.setItem(SESSION_KEY_CAMERA_UNAVAILABLE, '1');
    } else {
      window.sessionStorage.removeItem(SESSION_KEY_CAMERA_UNAVAILABLE);
    }
  } catch {
    /* 配额满静默 */
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function deriveFocusStage(progress: number): FocusStage {
  const p = clamp(progress, 0, 100);
  if (p < 25) return 'locked';
  if (p < 60) return 'active';
  if (p < 95) return 'openable';
  return 'full';
}

export const useAppStore = create<AppState>((set) => ({
  stardust: 1280,
  familyCoin: 50,
  addStardust: (n) => set((s) => ({ stardust: Math.max(0, s.stardust + n) })),
  addFamilyCoin: (n) => set((s) => ({ familyCoin: Math.max(0, s.familyCoin + n) })),

  voiceStatus: 'idle',
  subtitle: '',
  subtitleRich: null,
  xiaokeEmotion: 'happy',
  setVoiceStatus: (voiceStatus) => set({ voiceStatus }),
  // 字符串路径(ASR/错误/状态机)覆盖：清掉打字机富文本，避免两条字幕并存
  setSubtitle: (subtitle) => set({ subtitle, subtitleRich: null }),
  // 打字机路径：激活富文本时清掉字符串字幕（如 ASR 的 "xxx..."），渲染层优先富文本；
  // 传 null(打字机 onClear)时一并清空，字幕彻底消失
  setSubtitleRich: (subtitleRich) => set({ subtitleRich, subtitle: '' }),
  setXiaokeEmotion: (xiaokeEmotion) => set({ xiaokeEmotion }),

  bootState: 'unconfigured',
  focusMachine: 'idle',
  rewardMachine: 'idle',
  setBootState: (bootState) => set({ bootState }),
  setFocusMachine: (focusMachine) => set({ focusMachine }),
  setRewardMachine: (rewardMachine) => set({ rewardMachine }),

  focusMode: null,
  setFocusMode: (focusMode) => set({ focusMode }),
  focusProgress: 0,
  focusStage: 'locked',
  focusStartedAt: null,
  focusSpeed: 1,
  // D5 P10：默认 4 秒/张，4 张共 16s 满 → 不再"切换太快"
  focusStageDurationMs: 4_000,
  setFocusProgress: (p) =>
    set(() => {
      const progress = clamp(p, 0, 100);
      return {
        focusProgress: progress,
        focusStage: deriveFocusStage(progress),
      };
    }),
  setFocusStage: (focusStage) => set({ focusStage }),
  setFocusStartedAt: (focusStartedAt) => set({ focusStartedAt }),
  setFocusSpeed: (s) => set({ focusSpeed: clamp(s, 0.5, 20) }),
  setFocusStageDurationMs: (ms) => set({ focusStageDurationMs: clamp(ms, 500, 10_000) }),

  currentBoxLevel: null,
  setCurrentBoxLevel: (currentBoxLevel) => set({ currentBoxLevel }),

  ecoLevel: 1,
  setEcoLevel: (ecoLevel) => set({ ecoLevel }),

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
      // 注意：bootState 由 dispatchBoot(SETUP_DONE/SETUP_RESET) 切换，
      // 走 bootTransition 触发 startTimer welcome 等 effects
    }),

  setupVideoRequested: false,
  setSetupVideoRequested: (setupVideoRequested) => set({ setupVideoRequested }),
  cameraUnavailable: loadCameraUnavailable(),
  setCameraUnavailable: (cameraUnavailable) => {
    saveCameraUnavailable(cameraUnavailable);
    set({ cameraUnavailable });
  },
  cameraPreview: false,
  setCameraPreview: (cameraPreview) => set({ cameraPreview }),

  settingsOpen: false,
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),

  farewellState: 'hidden',
  setFarewellState: (farewellState) => set({ farewellState }),

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

// dev/e2e 验证用：暴露 store 到 window，方便 playwright 断言状态机字段
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { __APP_STORE__: typeof useAppStore }).__APP_STORE__ = useAppStore;
}
