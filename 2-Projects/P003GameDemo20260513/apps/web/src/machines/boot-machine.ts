import type { BootState, BootEvent, TransitionResult } from './types';
import { warnInvalid, noop } from './types';

// D5 P5：川哥要求取消 demo 自动推进，删除 boot 链路的所有 autoTimer
// 仍保留 transition event 类型，靠 DebugBar 跳关或用户主动操作触发

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
            { type: 'setSubtitle', text: '夜航报告出炉，这是你不在的时候我去赚来的哦！' },
            { type: 'setXiaokeEmotion', emotion: 'calm' },
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
