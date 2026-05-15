import type { FocusMachineState, FocusEvent, TransitionResult } from './types';
import { warnInvalid, noop } from './types';

const LAUNCH_ANIM_MS = 2_500;
const PRESENCE_LOST_TO_PAUSED_MS = 30_000;
const EXIT_CONFIRM_TIMEOUT_MS = 30_000;

export function focusTransition(
  current: FocusMachineState,
  event: FocusEvent,
): TransitionResult<FocusMachineState> {
  switch (current) {
    case 'idle':
      if (event.type === 'LAUNCH') {
        return {
          state: 'launching',
          effects: [
            { type: 'setSubtitle', text: event.mode === 'explore' ? '出航中...' : '小可来陪你读书' },
            { type: 'setXiaokeEmotion', emotion: event.mode === 'explore' ? 'excited' : 'warm' },
            { type: 'playSfx', id: event.mode === 'explore' ? 'focus-launch' : 'focus-companion' },
            { type: 'startTimer', key: 'launch', ms: LAUNCH_ANIM_MS },
          ],
        };
      }
      break;

    case 'launching':
      if (event.type === 'LAUNCH_ANIM_END') {
        return {
          state: 'running',
          effects: [
            { type: 'clearTimer', key: 'launch' },
            { type: 'setSubtitle', text: '' },
            { type: 'setVoiceStatus', status: 'idle' },
            { type: 'setFocusStartedAt', timestamp: Date.now() },
          ],
        };
      }
      break;

    case 'running':
      if (event.type === 'FOCUS_PROGRESS_TICK') {
        return {
          state: 'running',
          effects: [{ type: 'tickFocusProgress', progress: event.progress }],
        };
      }
      if (event.type === 'PRESENCE_LOST') {
        return {
          state: 'paused',
          effects: [
            { type: 'setSubtitle', text: '等待指挥官归来...' },
            { type: 'setXiaokeEmotion', emotion: 'calm' },
            { type: 'startTimer', key: 'pauseDetect', ms: PRESENCE_LOST_TO_PAUSED_MS },
          ],
        };
      }
      if (event.type === 'EXIT_REQUEST') {
        return {
          state: 'confirmExit',
          effects: [
            { type: 'setSubtitle', text: '确定结束学习吗？' },
            { type: 'startTimer', key: 'exitConfirm', ms: EXIT_CONFIRM_TIMEOUT_MS },
          ],
        };
      }
      break;

    case 'paused':
      if (event.type === 'PRESENCE_BACK') {
        return {
          state: 'running',
          effects: [
            { type: 'clearTimer', key: 'pauseDetect' },
            { type: 'setSubtitle', text: '欢迎回来' },
            { type: 'setXiaokeEmotion', emotion: 'happy' },
          ],
        };
      }
      break;

    case 'confirmExit':
      if (event.type === 'EXIT_CONFIRM') {
        return {
          state: 'idle',
          effects: [
            { type: 'clearTimer', key: 'exitConfirm' },
            { type: 'setSubtitle', text: '太棒了！获得家族币 +10' },
            { type: 'setXiaokeEmotion', emotion: 'happy' },
            { type: 'addFamilyCoin', amount: 10 },
            { type: 'playSfx', id: 'reward-familycoin' },
          ],
        };
      }
      if (event.type === 'EXIT_CANCEL' || event.type === 'EXIT_TIMEOUT') {
        return {
          state: 'running',
          effects: [
            { type: 'clearTimer', key: 'exitConfirm' },
            { type: 'setSubtitle', text: '' },
          ],
        };
      }
      break;
  }

  warnInvalid('focus', current, event);
  return noop(current);
}
