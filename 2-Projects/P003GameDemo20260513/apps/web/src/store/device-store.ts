import { create } from 'zustand';

interface DeviceState {
  lidOpen: boolean;
  toggleLid: () => void;
  setLid: (open: boolean) => void;

  userPresent: boolean;
  awayStartedAt: number | null;
  markPresent: () => void;
  markAway: () => void;
}

export const useDeviceStore = create<DeviceState>((set) => ({
  lidOpen: true,
  toggleLid: () => set((s) => ({ lidOpen: !s.lidOpen })),
  setLid: (open) => set({ lidOpen: open }),

  userPresent: true,
  awayStartedAt: null,
  markPresent: () => set({ userPresent: true, awayStartedAt: null }),
  markAway: () => set((s) => ({ userPresent: false, awayStartedAt: s.awayStartedAt ?? Date.now() })),
}));
