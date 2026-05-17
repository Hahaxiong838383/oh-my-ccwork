import type { RewardMachineState, RewardEvent, TransitionResult } from './types';
import type { BoxLevel } from '../store/app-store';
import { warnInvalid, noop } from './types';

const OPEN_ANIM_MS: Record<BoxLevel, number> = {
  common: 2_000,
  rare: 2_500,
  epic: 3_000,
  legendary: 4_000,
};

// D5 P8：showingReward 时长按奖励语字数动态计算，确保小可说完 + 留 800ms 静默
// 公式：length × 220ms + 800ms，clamp [3000, 6000]
function rewardShownMsFor(level: BoxLevel): number {
  const text = REWARD_TABLE[level].line;
  return Math.max(3_000, Math.min(6_000, text.length * 220 + 800));
}
const ECO_ANIM_MS = 4_000;
const ASK_TIMEOUT_MS = 30_000;

const REWARD_TABLE: Record<BoxLevel, { stardust: number; familyCoin: number; line: string; emotion: 'calm' | 'curious' | 'excited' }> = {
  common: { stardust: 20, familyCoin: 1, line: '嗯，常规收获，加油哦指挥官～', emotion: 'calm' },
  rare: { stardust: 50, familyCoin: 3, line: '哦！精品宝箱！今天表现不错呢！', emotion: 'curious' },
  epic: { stardust: 150, familyCoin: 8, line: '哇！是史诗级！让我好好瞧瞧！', emotion: 'excited' },
  legendary: { stardust: 500, familyCoin: 20, line: '！！传说宝箱！！指挥官今天运气爆棚啊！！', emotion: 'excited' },
};

export function rewardTransition(
  current: RewardMachineState,
  event: RewardEvent,
): TransitionResult<RewardMachineState> {
  switch (current) {
    case 'idle':
      if (event.type === 'OPEN_BOX') {
        return {
          state: 'openingBox',
          effects: [
            { type: 'setCurrentBoxLevel', level: event.level },
            { type: 'setXiaokeEmotion', emotion: REWARD_TABLE[event.level].emotion },
            { type: 'playSfx', id: `box-${event.level}` },
            { type: 'startTimer', key: 'openAnim', ms: OPEN_ANIM_MS[event.level] },
          ],
        };
      }
      break;

    case 'openingBox':
      if (event.type === 'OPEN_ANIM_END') {
        return {
          state: 'showingReward',
          // D5 P7：OPEN_ANIM_END 带 level，setSubtitle 用奖励语→自动 TTS
          // D5 P8：时长按字数动态，避免小可没说完就切倒计时
          effects: [
            { type: 'setSubtitle', text: REWARD_TABLE[event.level].line },
            { type: 'playSfx', id: 'reward-coin-flying' },
            { type: 'startTimer', key: 'rewardShown', ms: rewardShownMsFor(event.level) },
          ],
        };
      }
      break;

    case 'showingReward':
      if (event.type === 'REWARD_SHOWN') {
        return {
          state: 'idle',
          effects: [
            { type: 'clearTimer', key: 'rewardShown' },
            { type: 'setCurrentBoxLevel', level: null },
            { type: 'setSubtitle', text: '' },
          ],
        };
      }
      if (event.type === 'ECO_CHECK') {
        if (event.hasUnlock) {
          return {
            state: 'ecoUnlock',
            effects: [
              { type: 'clearTimer', key: 'rewardShown' },
              { type: 'setSubtitle', text: '生态缸有新解锁...' },
              { type: 'setXiaokeEmotion', emotion: 'excited' },
              { type: 'startTimer', key: 'ecoAnim', ms: ECO_ANIM_MS },
            ],
          };
        }
        return {
          state: 'askMode',
          effects: [
            { type: 'clearTimer', key: 'rewardShown' },
            { type: 'setSubtitle', text: '继续出航 还是 返舱？' },
            { type: 'startTimer', key: 'rewardAsk', ms: ASK_TIMEOUT_MS },
          ],
        };
      }
      break;

    case 'ecoUnlock':
      if (event.type === 'ECO_DONE') {
        return {
          state: 'askMode',
          effects: [
            { type: 'clearTimer', key: 'ecoAnim' },
            { type: 'setSubtitle', text: '继续出航 还是 返舱？' },
            { type: 'startTimer', key: 'rewardAsk', ms: ASK_TIMEOUT_MS },
          ],
        };
      }
      break;

    case 'askMode':
      if (event.type === 'ASK_PICK' || event.type === 'ASK_TIMEOUT') {
        return {
          state: 'done',
          effects: [
            { type: 'clearTimer', key: 'rewardAsk' },
            { type: 'setSubtitle', text: '' },
            { type: 'setCurrentBoxLevel', level: null },
          ],
        };
      }
      break;

    case 'done':
      if (event.type === 'OPEN_BOX') {
        return {
          state: 'openingBox',
          effects: [
            { type: 'setCurrentBoxLevel', level: event.level },
            { type: 'setXiaokeEmotion', emotion: REWARD_TABLE[event.level].emotion },
            { type: 'playSfx', id: `box-${event.level}` },
            { type: 'startTimer', key: 'openAnim', ms: OPEN_ANIM_MS[event.level] },
          ],
        };
      }
      break;
  }

  warnInvalid('reward', current, event);
  return noop(current);
}

export { REWARD_TABLE, OPEN_ANIM_MS };
