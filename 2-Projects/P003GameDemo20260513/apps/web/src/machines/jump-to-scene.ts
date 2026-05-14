import type { SceneId, BootState, FocusMachineState, RewardMachineState, BoxLevel, VoiceStatus, XiaokeEmotion } from '../store/app-store';

export interface ScenePreset {
  bootState: BootState;
  focusMachine: FocusMachineState;
  rewardMachine: RewardMachineState;
  currentBoxLevel: BoxLevel | null;
  voiceStatus: VoiceStatus;
  subtitle: string;
  xiaokeEmotion: XiaokeEmotion;
  stardust: number;
  familyCoin: number;
  setupComplete: boolean;
}

const BASE: ScenePreset = {
  bootState: 'running',
  focusMachine: 'idle',
  rewardMachine: 'idle',
  currentBoxLevel: null,
  voiceStatus: 'idle',
  subtitle: '',
  xiaokeEmotion: 'happy',
  stardust: 1280,
  familyCoin: 50,
  setupComplete: true,
};

export const SCENE_PRESETS: Record<SceneId, ScenePreset> = {
  welcome: {
    ...BASE,
    bootState: 'welcome',
    subtitle: '你好，指挥官！欢迎回到方舟',
    xiaokeEmotion: 'happy',
  },
  nightReport: {
    ...BASE,
    bootState: 'nightReport',
    subtitle: '夜航报告',
    xiaokeEmotion: 'calm',
  },
  askMode: {
    ...BASE,
    bootState: 'askMode',
    subtitle: '今天想 探索 还是 陪伴？',
    xiaokeEmotion: 'curious',
  },
  focusRunning: {
    ...BASE,
    focusMachine: 'running',
    xiaokeEmotion: 'warm',
  },
  boxCommon: {
    ...BASE,
    focusMachine: 'idle',
    rewardMachine: 'openingBox',
    currentBoxLevel: 'common',
    xiaokeEmotion: 'calm',
  },
  boxRare: {
    ...BASE,
    focusMachine: 'idle',
    rewardMachine: 'openingBox',
    currentBoxLevel: 'rare',
    xiaokeEmotion: 'curious',
  },
  boxEpic: {
    ...BASE,
    focusMachine: 'idle',
    rewardMachine: 'openingBox',
    currentBoxLevel: 'epic',
    xiaokeEmotion: 'excited',
  },
  boxLegendary: {
    ...BASE,
    focusMachine: 'idle',
    rewardMachine: 'openingBox',
    currentBoxLevel: 'legendary',
    xiaokeEmotion: 'excited',
  },
  ecoUnlock: {
    ...BASE,
    focusMachine: 'idle',
    rewardMachine: 'ecoUnlock',
    subtitle: '生态缸有新解锁...',
    xiaokeEmotion: 'excited',
  },
  farewell: {
    ...BASE,
    focusMachine: 'idle',
    subtitle: '指挥官，明天见～',
    xiaokeEmotion: 'warm',
  },
};

/**
 * jumpToScene —— 跳关原子函数
 * 一次性 hydrate 所有相关字段，避免多机不一致。
 * 调用前 effect runner 必须 clearAllTimers。
 */
export function getScenePreset(scene: SceneId): ScenePreset {
  return SCENE_PRESETS[scene];
}

export const SCENE_LABELS: Record<SceneId, string> = {
  welcome: '1. 开机欢迎',
  nightReport: '2. 夜航报告',
  askMode: '3. 状态询问（开机）',
  focusRunning: '4. 进入专注',
  boxCommon: '5. 普通宝箱',
  boxRare: '6. 精品宝箱',
  boxEpic: '7. 史诗宝箱',
  boxLegendary: '8. 传说宝箱',
  ecoUnlock: '9. 生态缸升级',
  farewell: '0. 关盖告别',
};

export const SCENE_ORDER: SceneId[] = [
  'welcome',
  'nightReport',
  'askMode',
  'focusRunning',
  'boxCommon',
  'boxRare',
  'boxEpic',
  'boxLegendary',
  'ecoUnlock',
  'farewell',
];

export const SCENE_KEYBOARD_MAP: Record<string, SceneId> = {
  '1': 'welcome',
  '2': 'nightReport',
  '3': 'askMode',
  '4': 'focusRunning',
  '5': 'boxCommon',
  '6': 'boxRare',
  '7': 'boxEpic',
  '8': 'boxLegendary',
  '9': 'ecoUnlock',
  '0': 'farewell',
};
