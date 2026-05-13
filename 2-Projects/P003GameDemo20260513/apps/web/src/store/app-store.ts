import { create } from 'zustand';

/**
 * V0.4 单一 store —— 4 天 demo 用，"过 demo 即可"原则
 *
 * 之前的 user/device/settings 三个 store 合并。
 * 跨深组件用 Zustand 比 prop drilling 清爽，但只保留这一个 store。
 *
 * 字段分组：
 *   - 资产：stardust / familyCoin
 *   - 语音对话：voiceStatus / subtitle / xiaokeEmotion
 *   - 专注循环：focusStatus
 *   - 设备模拟：lidOpen
 *   - 设置：led / volume
 */

export type VoiceStatus = 'idle' | 'listening' | 'thinking' | 'speaking';
export type FocusStatus = 'idle' | 'running';
export type XiaokeEmotion = 'happy' | 'curious' | 'warm' | 'calm' | 'excited';

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

  // —— 专注循环 ——
  focusStatus: FocusStatus;
  setFocusStatus: (s: FocusStatus) => void;

  // —— 设备模拟（手机上没有真的开关盖按钮，用 device 外壳上的电源键模拟）——
  lidOpen: boolean;
  toggleLid: () => void;

  // —— 设置（外壳 LED 联动）——
  led: LEDState;
  toggleLED: () => void;
  cycleBrightness: () => void;
  cycleColorTemp: () => void;
  volume: number;
  setVolume: (v: number) => void;
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

  lidOpen: true,
  toggleLid: () => set((s) => ({ lidOpen: !s.lidOpen })),

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
