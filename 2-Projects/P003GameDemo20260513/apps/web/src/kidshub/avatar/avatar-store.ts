import { create } from 'zustand';
import type { VoiceStatus } from '../../store/app-store';
import { getExpression } from './expressions';

export type AvatarSource = 'state' | 'llm' | 'click';

/**
 * 小可形象状态 · 三层驱动的仲裁规则：
 *  - state（状态机兜底）：listening/thinking/error 总是覆盖（新一轮开始）；
 *    speaking 仅在 LLM 没选表情时给默认；idle 总是回待机（说完一句自然放松）
 *  - llm（每句话的表情标记）：speaking 期间持有，不被 state 默认覆盖
 *  - click（摸一摸互动 / 表情库面板）：idle 期间生效，下一轮语音状态变化时让位
 */
interface AvatarState {
  expressionId: string;
  /** files 变体下标（giggle 两张随机挑） */
  fileIndex: number;
  /** 每次表情变化自增 → 组件用作 key 触发弹跳动画 */
  bumpKey: number;
  source: AvatarSource;
  /** LLM 表情持有中：speaking/idle 状态切换不得覆盖（直到 endTurn / 新一轮） */
  llmHold: boolean;
  setExpression: (id: string, source: AvatarSource) => void;
  applyVoiceStatus: (status: VoiceStatus) => void;
  applyNetState: (state: 'connecting' | 'success' | 'fail') => void;
  /** 一轮 TTS 真正结束（tts.end）：解除 LLM 持有，回待机 */
  endTurn: () => void;
}

function pickFileIndex(id: string): number {
  const def = getExpression(id);
  if (!def || def.files.length <= 1) return 0;
  return Math.floor(Math.random() * def.files.length);
}

/** thinking 双表情交替（沉思 ↔ 挠头），避免每次思考都一个样 */
let lastThinkId: string = 'scratch-head';

export const useAvatarStore = create<AvatarState>((set, get) => ({
  expressionId: 'head-tilt',
  fileIndex: 0,
  bumpKey: 0,
  source: 'state',
  llmHold: false,

  setExpression: (id, source) => {
    if (!getExpression(id)) return;
    set((s) => ({
      expressionId: id,
      fileIndex: pickFileIndex(id),
      bumpKey: s.bumpKey + 1,
      source,
      // LLM 选的表情持有到本轮 tts.end（llm.done 会先把 voiceStatus 拉回 idle，
      // TTS 其实还在播——没有 hold 的话表情只闪 <1s 就被待机脸覆盖，实测踩过）
      llmHold: source === 'llm' ? true : s.llmHold,
    }));
  },

  applyVoiceStatus: (status) => {
    const { setExpression, llmHold } = get();
    switch (status) {
      case 'listening':
        set({ llmHold: false });
        setExpression('confused-wave', 'state');
        return;
      case 'thinking': {
        set({ llmHold: false });
        lastThinkId = lastThinkId === 'ponder' ? 'scratch-head' : 'ponder';
        setExpression(lastThinkId, 'state');
        return;
      }
      case 'speaking':
        // LLM 已为本句选过表情 → 不用默认说话脸覆盖
        if (llmHold) return;
        setExpression('hello-laugh', 'state');
        return;
      case 'idle':
        // llm.done 触发的中场 idle（TTS 仍在播）不打断 LLM 表情；真结束走 endTurn
        if (llmHold) return;
        setExpression('head-tilt', 'state');
        return;
    }
  },

  applyNetState: (state) => {
    const { setExpression } = get();
    if (state === 'connecting') setExpression('net-typing', 'state');
    else if (state === 'success') setExpression('net-success', 'state');
    else setExpression('net-fail', 'state');
  },

  endTurn: () => {
    const { setExpression, expressionId } = get();
    set({ llmHold: false });
    // 连网失败脸是异常提示，不被回待机吞掉（下一轮交互自然恢复）
    if (expressionId.startsWith('net-')) return;
    setExpression('head-tilt', 'state');
  },
}));
