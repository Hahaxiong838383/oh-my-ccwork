import Taro from '@tarojs/taro';
import { initialState, normalizeVisionReport, updateDemo, type Action, type DemoState } from '../model';

const KEY = 'xiaoke-development-preview-v2';

export function loadDemo(): DemoState {
  try {
    const saved = Taro.getStorageSync(KEY);
    if (saved?.version === 2 && Array.isArray(saved.tasks) && Array.isArray(saved.records)) {
      const base = initialState();
      const validIntervals = [5, 10, 15, 30];
      const validVoiceLimits = Array.from({ length: 24 }, (_, i) => `${i + 1}小时`);
      const settings = { ...base.settings, ...saved.settings };
      return {
        ...saved,
        phone: typeof saved.phone === 'string' ? saved.phone : base.phone,
        redeemedDate: typeof saved.redeemedDate === 'string' ? saved.redeemedDate : null,
        lastAppActiveAt: typeof saved.lastAppActiveAt === 'string' ? saved.lastAppActiveAt : base.lastAppActiveAt,
        lastDeviceActiveAt: typeof saved.lastDeviceActiveAt === 'string' ? saved.lastDeviceActiveAt : base.lastDeviceActiveAt,
        lastRecallAt: typeof saved.lastRecallAt === 'string' ? saved.lastRecallAt : null,
        readMessageCategories: Array.isArray(saved.readMessageCategories) ? saved.readMessageCategories.filter((value: unknown): value is string => typeof value === 'string') : [],
        cards: Array.isArray(saved.cards) ? saved.cards : base.cards,
        weeklyEmpty: typeof saved.weeklyEmpty === 'boolean' ? saved.weeklyEmpty : base.weeklyEmpty,
        device: saved.device ? { ...saved.device, present: typeof saved.device.present === 'boolean' ? saved.device.present : true } : null,
        settings: {
          ...settings,
          interval: validIntervals.includes(settings.interval) ? settings.interval : base.settings.interval,
          voiceLimit: validVoiceLimits.includes(settings.voiceLimit) ? settings.voiceLimit : base.settings.voiceLimit,
        },
        reports: Array.isArray(saved.reports) ? saved.reports.map(normalizeVisionReport) : [],
      };
    }
  } catch { /* 读不到本地示例时使用初始状态。 */ }
  return initialState();
}

export function saveDemo(state: DemoState) {
  try {
    Taro.setStorageSync(KEY, state);
    return true;
  } catch {
    return false;
  }
}

export function dispatchDemo(state: DemoState, action: Action) {
  const next = updateDemo(state, action);
  if (!saveDemo(next)) throw new Error('本机存储失败，请检查存储空间后重试');
  return next;
}

export function resetDemo() {
  const next = initialState();
  if (!saveDemo(next)) throw new Error('本机存储失败，请检查存储空间后重试');
  return next;
}
