import type { FocusMachineState, FocusEvent, TransitionResult } from './types';
import { warnInvalid, noop } from './types';

// D5 P12：出航 02 完全显示后再停 4s 再切到 running
// 01 显示 2.7s + 1.8s 过渡到 02 + 02 停 4s = 8.5s
const LAUNCH_ANIM_EXPLORE_MS = 8_500;
// D5 P17：静思 launching 单图淡入 → 2.5s 足够，不要陪出航拖时间
const LAUNCH_ANIM_COMPANION_MS = 2_500;
const PRESENCE_LOST_TO_PAUSED_MS = 30_000;
const EXIT_CONFIRM_TIMEOUT_MS = 30_000;
// D6 P2：FOCUS_REWARD_READY 点击后给"变黄"美术 1.5s 展示，再切到开宝箱场景
// 川哥反馈出航模式切换太快，加缓冲让用户看到收获瞬间
const REWARD_OPEN_DELAY_MS = 1_500;

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
            { type: 'setSubtitle', text: event.mode === 'explore' ? '坐稳啦，我们要出发咯！' : '慢慢来，深呼吸放松一下。' },
            { type: 'setXiaokeEmotion', emotion: event.mode === 'explore' ? 'excited' : 'warm' },
            { type: 'playSfx', id: event.mode === 'explore' ? 'focus-launch' : 'focus-companion' },
            { type: 'startTimer', key: 'launch', ms: event.mode === 'explore' ? LAUNCH_ANIM_EXPLORE_MS : LAUNCH_ANIM_COMPANION_MS },
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
      if (event.type === 'FOCUS_REWARD_READY') {
        // D6 P2：点击"收获奖励"后先 setFocusStage='full' 让"变黄"美术展示 1.5s，
        // 再由 rewardOpenDelay timer 触发 dispatchRandomBox 进入开箱场景。
        // 修川哥反馈"出航模式宝箱领取后切换太快"。
        return {
          state: 'rewarding',
          effects: [
            { type: 'setFocusStage', stage: 'full' },
            { type: 'playSfx', id: 'reward-flow-start' },
            { type: 'startTimer', key: 'rewardOpenDelay', ms: REWARD_OPEN_DELAY_MS },
          ],
        };
      }
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

    case 'rewarding':
      if (event.type === 'REWARD_FLOW_DONE') {
        return {
          state: 'idle',
          effects: [
            { type: 'setFocusProgress', progress: 0 },
            { type: 'setFocusStartedAt', timestamp: null },
            { type: 'setFocusStage', stage: 'locked' },
            { type: 'setFocusMode', mode: null },
            { type: 'setSubtitle', text: '' },
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
