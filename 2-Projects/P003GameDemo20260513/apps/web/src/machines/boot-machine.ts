import type { BootState, BootEvent, TransitionResult } from './types';
import { warnInvalid, noop } from './types';

const ASK_MODE_TIMEOUT_MS = 30_000;
const WELCOME_ANIM_MS = 4_000;
const NIGHT_REPORT_ANIM_MS = 6_000;

export function bootTransition(
  current: BootState,
  event: BootEvent,
): TransitionResult<BootState> {
  switch (current) {
    case 'unconfigured':
      if (event.type === 'SETUP_DONE') {
        return {
          state: 'welcome',
          effects: [
            { type: 'clearAllTimers' },
            { type: 'setSubtitle', text: '你好，指挥官！欢迎回到方舟' },
            { type: 'setXiaokeEmotion', emotion: 'happy' },
            { type: 'playSfx', id: 'boot-welcome' },
            { type: 'startTimer', key: 'welcome', ms: WELCOME_ANIM_MS },
          ],
        };
      }
      break;

    case 'welcome':
      if (event.type === 'SETUP_RESET') {
        return {
          state: 'unconfigured',
          effects: [{ type: 'clearAllTimers' }, { type: 'setSubtitle', text: '' }],
        };
      }
      if (event.type === 'WELCOME_END' || event.type === 'BOOT_ANIM_END') {
        return {
          state: 'nightReport',
          effects: [
            { type: 'clearTimer', key: 'welcome' },
            { type: 'setSubtitle', text: '夜航报告' },
            { type: 'setXiaokeEmotion', emotion: 'calm' },
            { type: 'startTimer', key: 'nightReport', ms: NIGHT_REPORT_ANIM_MS },
          ],
        };
      }
      break;

    case 'nightReport':
      if (event.type === 'SETUP_RESET') {
        return {
          state: 'unconfigured',
          effects: [{ type: 'clearAllTimers' }, { type: 'setSubtitle', text: '' }],
        };
      }
      if (event.type === 'NIGHT_REPORT_DONE') {
        return {
          state: 'askMode',
          effects: [
            { type: 'clearTimer', key: 'nightReport' },
            { type: 'setSubtitle', text: '今天想 探索 还是 陪伴？' },
            { type: 'setXiaokeEmotion', emotion: 'curious' },
            { type: 'startTimer', key: 'askMode', ms: ASK_MODE_TIMEOUT_MS },
          ],
        };
      }
      break;

    case 'askMode':
      if (event.type === 'SETUP_RESET') {
        return {
          state: 'unconfigured',
          effects: [{ type: 'clearAllTimers' }, { type: 'setSubtitle', text: '' }],
        };
      }
      if (event.type === 'ASK_MODE_PICK' || event.type === 'ASK_MODE_TIMEOUT') {
        return {
          state: 'running',
          effects: [
            { type: 'clearTimer', key: 'askMode' },
            { type: 'setSubtitle', text: '' },
          ],
        };
      }
      break;

    case 'running':
      if (event.type === 'SETUP_RESET') {
        return {
          state: 'unconfigured',
          effects: [{ type: 'clearAllTimers' }, { type: 'setSubtitle', text: '' }],
        };
      }
      break;
  }

  warnInvalid('boot', current, event);
  return noop(current);
}
