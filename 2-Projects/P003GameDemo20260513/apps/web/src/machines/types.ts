import type {
  BootState,
  FocusMachineState,
  RewardMachineState,
  BoxLevel,
  VoiceStatus,
  XiaokeEmotion,
  SceneId,
  FocusStage,
  FocusMode,
} from '../store/app-store';

export type { BootState, FocusMachineState, RewardMachineState, SceneId };

export type BootEvent =
  | { type: 'SETUP_DONE' }
  | { type: 'SETUP_RESET' }
  | { type: 'BOOT_ANIM_END' }
  | { type: 'WELCOME_END' }
  | { type: 'NIGHT_REPORT_DONE' }
  | { type: 'ASK_MODE_TIMEOUT' }
  | { type: 'ASK_MODE_PICK'; mode: 'explore' | 'companion' }
  | { type: 'JUMP'; scene: SceneId };

export type FocusEvent =
  | { type: 'LAUNCH'; mode: 'explore' | 'companion' }
  | { type: 'LAUNCH_ANIM_END' }
  | { type: 'FOCUS_PROGRESS_TICK'; progress: number }
  | { type: 'FOCUS_REWARD_READY' }
  | { type: 'REWARD_FLOW_DONE' }
  | { type: 'PRESENCE_LOST' }
  | { type: 'PRESENCE_BACK' }
  | { type: 'EXIT_REQUEST' }
  | { type: 'EXIT_CONFIRM' }
  | { type: 'EXIT_CANCEL' }
  | { type: 'EXIT_TIMEOUT' }
  | { type: 'JUMP'; scene: SceneId };

export type RewardEvent =
  | { type: 'OPEN_BOX'; level: BoxLevel }
  | { type: 'OPEN_ANIM_END'; level: BoxLevel }
  | { type: 'REWARD_SHOWN' }
  | { type: 'ECO_CHECK'; hasUnlock: boolean }
  | { type: 'ECO_DONE' }
  | { type: 'ASK_PICK'; choice: 'continue' | 'return' }
  | { type: 'ASK_TIMEOUT' }
  | { type: 'JUMP'; scene: SceneId };

export type Effect =
  | { type: 'startTimer'; key: string; ms: number }
  | { type: 'clearTimer'; key: string }
  | { type: 'clearAllTimers' }
  | { type: 'playSfx'; id: string }
  | { type: 'setVoiceStatus'; status: VoiceStatus }
  | { type: 'setSubtitle'; text: string; silent?: boolean }
  | { type: 'addStardust'; amount: number }
  | { type: 'addFamilyCoin'; amount: number }
  | { type: 'setXiaokeEmotion'; emotion: XiaokeEmotion }
  | { type: 'setCurrentBoxLevel'; level: BoxLevel | null }
  | { type: 'pushOpenedBoxLevel'; level: BoxLevel }
  | { type: 'tickFocusProgress'; progress: number }
  | { type: 'setFocusProgress'; progress: number }
  | { type: 'setFocusStage'; stage: FocusStage }
  | { type: 'setFocusMode'; mode: FocusMode }
  | { type: 'setFocusStartedAt'; timestamp: number | null }
  | { type: 'dispatchRewardEvent'; event: RewardEvent }
  // D5 P16：随机宝箱品质，effect runner 内用 boxes.pickNextBoxLevel
  | { type: 'dispatchRandomBox' };

export interface TransitionResult<S> {
  state: S;
  effects: Effect[];
}

export function warnInvalid<S, E extends { type: string }>(
  machine: string,
  state: S,
  event: E,
): void {
  if (import.meta.env.DEV) {
    console.warn(`[${machine}] invalid event`, { state, event });
  }
}

export function noop<S>(state: S): TransitionResult<S> {
  return { state, effects: [] };
}
