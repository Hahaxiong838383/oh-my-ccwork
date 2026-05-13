import { create } from 'zustand';

export type Gender = 'male' | 'female';
export type NewbiePhaseId = 1 | 2 | 3 | null;
export type FocusMode = 'explore' | 'companion';
export type FocusStatus = 'idle' | 'asking' | 'running' | 'paused' | 'confirmExit';

/** 小可人格预设 ID（V1.51 抽卡解锁，V1.0 仅有 default）—— 来自 3.4 */
export type PersonalityPresetId =
  | 'default'
  | 'explorer'
  | 'storyteller'
  | 'comedian'
  | 'curious'
  | 'healer';

/** 小可 5 维属性 0-100（来自 3.4 §二） */
export interface PersonalityStats {
  imagination: number;
  courage: number;
  humor: number;
  curiosity: number;
  warmth: number;
}

/** 单个生态缸状态（V1.0 仅 default，3.12 多缸扩展） */
export interface EcoTankState {
  tankId: string;
  unlockedParts: { partId: number; level: number }[];
  pendingAnims: { animId: string; partId: number; action: 'unlock' | 'upgrade' }[];
}

const DEFAULT_PERSONALITY: PersonalityStats = {
  imagination: 60,
  courage: 60,
  humor: 60,
  curiosity: 70,
  warmth: 80,
};

const DEFAULT_TANK: EcoTankState = {
  tankId: 'default',
  unlockedParts: [{ partId: 1301001, level: 0 }], // 默认底
  pendingAnims: [],
};

interface UserState {
  onboarded: boolean;
  setOnboarded: (v: boolean) => void;

  gender: Gender | null;
  setGender: (g: Gender) => void;

  // 资产
  stardust: number;
  familyCoin: number;
  setAssets: (delta: { stardust?: number; familyCoin?: number }) => void;

  // 新手期
  newbiePhase: NewbiePhaseId;
  newbieDaysLeft: number;
  setNewbie: (phase: NewbiePhaseId, daysLeft: number) => void;

  // 使用天数
  useDays: number;

  // 小可人格（V1.51 抽卡，V1.0 仅 default）
  personality: PersonalityStats;
  personalityPreset: PersonalityPresetId;
  unlockedPresets: PersonalityPresetId[];
  setPersonality: (preset: PersonalityPresetId, stats: PersonalityStats) => void;

  // 解锁
  unlockedSkins: string[];
  currentSkin: string;
  unlockedCollectibles: number[];

  // 生态缸（V1.0 仅 default，3.12 多缸）
  ecoTanks: EcoTankState[];
  currentEcoTankId: string;

  // 专注会话
  focusStatus: FocusStatus;
  focusMode: FocusMode | null;
  setFocus: (status: FocusStatus, mode?: FocusMode | null) => void;

  // 宝箱队列
  pendingBoxes: { boxId: string; level: 1 | 2 | 3 | 4; createdAt: number }[];
  addBox: (box: UserState['pendingBoxes'][number]) => void;
  popBox: (boxId: string) => void;
}

export const useUserStore = create<UserState>((set) => ({
  onboarded: false,
  setOnboarded: (v) => set({ onboarded: v }),

  gender: null,
  setGender: (g) => set({ gender: g }),

  stardust: 0,
  familyCoin: 0,
  setAssets: (delta) =>
    set((s) => ({
      stardust: delta.stardust !== undefined ? Math.max(0, s.stardust + delta.stardust) : s.stardust,
      familyCoin:
        delta.familyCoin !== undefined ? Math.max(0, s.familyCoin + delta.familyCoin) : s.familyCoin,
    })),

  newbiePhase: 1,
  newbieDaysLeft: 3,
  setNewbie: (phase, daysLeft) => set({ newbiePhase: phase, newbieDaysLeft: daysLeft }),

  useDays: 1,

  personality: DEFAULT_PERSONALITY,
  personalityPreset: 'default',
  unlockedPresets: ['default'],
  setPersonality: (preset, stats) => set({ personalityPreset: preset, personality: stats }),

  unlockedSkins: ['default'],
  currentSkin: 'default',
  unlockedCollectibles: [],

  ecoTanks: [DEFAULT_TANK],
  currentEcoTankId: 'default',

  focusStatus: 'idle',
  focusMode: null,
  setFocus: (status, mode = null) => set({ focusStatus: status, focusMode: mode }),

  pendingBoxes: [],
  addBox: (box) => set((s) => ({ pendingBoxes: [...s.pendingBoxes, box] })),
  popBox: (boxId) => set((s) => ({ pendingBoxes: s.pendingBoxes.filter((b) => b.boxId !== boxId) })),
}));
