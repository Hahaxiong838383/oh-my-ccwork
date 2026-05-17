import type { SceneId, BootState, FocusMachineState, RewardMachineState, BoxLevel, VoiceStatus, XiaokeEmotion, FocusMode, FarewellState } from '../store/app-store';

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
  focusMode: FocusMode;
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
  focusMode: null,
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
    // D5 P8：preset 字幕必须与 boot-machine transition 文本一致，否则 TTS 被截断
    subtitle: '夜航报告出炉，这是你不在的时候我去赚来的哦！',
    xiaokeEmotion: 'calm',
  },
  askMode: {
    ...BASE,
    bootState: 'askMode',
    subtitle: '指挥官，今天想出航，还是静思呢？',
    xiaokeEmotion: 'curious',
  },
  focusRunning: {
    ...BASE,
    focusMachine: 'running',
    focusMode: 'explore',
    xiaokeEmotion: 'excited',
  },
  focusCompanion: {
    ...BASE,
    focusMachine: 'running',
    focusMode: 'companion',
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
  focusRunning: '4. 进入专注（出航）',
  focusCompanion: '5. 进入专注（静思）',
  boxCommon: '6. 普通宝箱',
  boxRare: '7. 精品宝箱',
  boxEpic: '8. 史诗宝箱',
  boxLegendary: '9. 传说宝箱',
  ecoUnlock: '0. 生态缸升级',
  farewell: 'F. 关盖告别',
};

export const SCENE_ORDER: SceneId[] = [
  'welcome',
  'nightReport',
  'askMode',
  'focusRunning',
  'focusCompanion',
  'boxCommon',
  'boxRare',
  'boxEpic',
  'boxLegendary',
  'ecoUnlock',
  'farewell',
];

/**
 * D5 P9：从 store 状态反推当前 SceneId
 * 用于 debug 下一步按钮 + 左下角数字标注
 * 中间态（unconfigured / 切换瞬间）返 null
 */
export interface DeriveSceneInput {
  bootState: BootState;
  focusMachine: FocusMachineState;
  focusMode: FocusMode;
  rewardMachine: RewardMachineState;
  currentBoxLevel: BoxLevel | null;
  farewellState: FarewellState;
}

export function deriveCurrentScene(s: DeriveSceneInput): SceneId | null {
  if (s.farewellState === 'waving' || s.farewellState === 'shutdown') return 'farewell';
  if (s.rewardMachine === 'ecoUnlock') return 'ecoUnlock';
  if (
    (s.rewardMachine === 'openingBox' || s.rewardMachine === 'showingReward') &&
    s.currentBoxLevel !== null
  ) {
    return ('box' + s.currentBoxLevel.charAt(0).toUpperCase() + s.currentBoxLevel.slice(1)) as SceneId;
  }
  if (s.bootState === 'welcome') return 'welcome';
  if (s.bootState === 'nightReport') return 'nightReport';
  if (s.bootState === 'askMode') return 'askMode';
  if (s.focusMachine !== 'idle') {
    if (s.focusMode === 'explore') return 'focusRunning';
    if (s.focusMode === 'companion') return 'focusCompanion';
  }
  return null;
}

// 键盘快捷键：1-5 = 主流程，6-9 = 4 级宝箱，0 = ecoUnlock，F = farewell
// （focusCompanion 新增挤占了 boxCommon 原来的 5 号位，box* 整体后移；
//  ecoUnlock 从 9 移到 0；farewell 改 'f' 键避免冲突）
export const SCENE_KEYBOARD_MAP: Record<string, SceneId> = {
  '1': 'welcome',
  '2': 'nightReport',
  '3': 'askMode',
  '4': 'focusRunning',
  '5': 'focusCompanion',
  '6': 'boxCommon',
  '7': 'boxRare',
  '8': 'boxEpic',
  '9': 'boxLegendary',
  '0': 'ecoUnlock',
  f: 'farewell',
  F: 'farewell',
};
