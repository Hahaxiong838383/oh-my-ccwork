import { create } from 'zustand';

interface LEDState {
  on: boolean;
  brightness: 1 | 2 | 3;
  colorTemp: 1 | 2 | 3;
}

interface SettingsState {
  led: LEDState;
  toggleLED: () => void;
  cycleBrightness: () => void;
  cycleColorTemp: () => void;

  volume: number; // 0-100, step 5
  setVolume: (v: number) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
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
