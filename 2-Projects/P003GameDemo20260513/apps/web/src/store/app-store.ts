import { create } from 'zustand';

export type FocusState = 'idle' | 'focusing' | 'paused';

interface AppState {
  onboarded: boolean;
  setOnboarded: (v: boolean) => void;

  familyCoin: number;
  addCoin: (n: number) => void;

  focusState: FocusState;
  setFocusState: (s: FocusState) => void;

  treasureBoxCount: number;
  setTreasureBoxCount: (n: number) => void;

  unlockedEcosystemItems: string[];
  unlockItem: (id: string) => void;
}

export const useAppStore = create<AppState>((set) => ({
  onboarded: false,
  setOnboarded: (v) => set({ onboarded: v }),

  familyCoin: 0,
  addCoin: (n) => set((s) => ({ familyCoin: s.familyCoin + n })),

  focusState: 'idle',
  setFocusState: (s) => set({ focusState: s }),

  treasureBoxCount: 0,
  setTreasureBoxCount: (n) => set({ treasureBoxCount: Math.min(3, Math.max(0, n)) }),

  unlockedEcosystemItems: [],
  unlockItem: (id) =>
    set((s) =>
      s.unlockedEcosystemItems.includes(id)
        ? s
        : { unlockedEcosystemItems: [...s.unlockedEcosystemItems, id] },
    ),
}));
