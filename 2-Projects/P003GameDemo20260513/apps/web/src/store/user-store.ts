import { create } from 'zustand';

export type Gender = 'male' | 'female';
export type NewbiePhase = 1 | 2 | 3 | null;
export type FocusMode = 'explore' | 'companion';
export type FocusStatus = 'idle' | 'asking' | 'running' | 'paused' | 'confirmExit';

/**
 * 用户域状态 —— 服务器为权威，本地仅作渲染缓存
 *
 * V0.2 关键变更：
 * - 双货币 stardust + family_coin
 * - newbiePhase 跟踪当前阶段（1金/2紫/3蓝）
 * - gender 必填，影响藏品库 + 宝箱外观
 */
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
  newbiePhase: NewbiePhase;
  newbieDaysLeft: number;
  setNewbie: (phase: NewbiePhase, daysLeft: number) => void;

  // 使用天数（实际开机天数）
  useDays: number;

  // 解锁
  unlockedSkins: string[];
  currentSkin: string;
  unlockedEcoParts: { partId: number; level: number }[];
  unlockedCollectibles: number[];

  // 专注会话
  focusStatus: FocusStatus;
  focusMode: FocusMode | null;
  setFocus: (status: FocusStatus, mode?: FocusMode | null) => void;

  // 宝箱队列（待开）
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
      familyCoin: delta.familyCoin !== undefined ? Math.max(0, s.familyCoin + delta.familyCoin) : s.familyCoin,
    })),

  newbiePhase: 1,
  newbieDaysLeft: 3,
  setNewbie: (phase, daysLeft) => set({ newbiePhase: phase, newbieDaysLeft: daysLeft }),

  useDays: 1,

  unlockedSkins: ['default'],
  currentSkin: 'default',
  unlockedEcoParts: [{ partId: 1301001, level: 0 }],
  unlockedCollectibles: [],

  focusStatus: 'idle',
  focusMode: null,
  setFocus: (status, mode = null) => set({ focusStatus: status, focusMode: mode }),

  pendingBoxes: [],
  addBox: (box) => set((s) => ({ pendingBoxes: [...s.pendingBoxes, box] })),
  popBox: (boxId) => set((s) => ({ pendingBoxes: s.pendingBoxes.filter((b) => b.boxId !== boxId) })),
}));
