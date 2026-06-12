import { create } from 'zustand';
import type { VoiceStatus } from '../../store/app-store';
import { getExpression } from './expressions';

export type AvatarSource = 'state' | 'llm' | 'click' | 'tutorial';

/**
 * 小可形象状态 · 三层驱动的仲裁规则：
 *  - state（状态机兜底）：listening/thinking/error 总是覆盖（新一轮开始）；
 *    speaking 仅在 LLM 没选表情时给默认；idle 总是回待机（说完一句自然放松）
 *  - llm（每句话的表情标记）：speaking 期间持有，不被 state 默认覆盖
 *  - click（摸一摸互动 / 表情库面板）：idle 期间生效，下一轮语音状态变化时让位
 *  - tutorial（新手引导锁）：引导期表情由配表 anim_type 指定，压过以上所有层；
 *    仅 net-* 异常脸可穿透（连接问题必须可见）。退出引导时解锁
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
  /** 本轮句级表情队列（index>0 的后续表情，按 tts.segment_start 逐句消费） */
  exprQueue: string[];
  /** 本轮是否已见过首个句边界段（表情 0 提前上脸，首段开播不消费队列） */
  firstSegmentSeen: boolean;
  /** 最近一次表情变化时间戳：待机轮换的静默期判据（对话中不轮换） */
  lastBumpAt: number;
  /** 引导锁：true 期间非 tutorial 来源的表情变更一律忽略（net-* 除外） */
  tutorialLock: boolean;
  setTutorialLock: (on: boolean) => void;
  setExpression: (id: string, source: AvatarSource) => void;
  /** LLM 句级表情到达：index===0 清场立即上脸（新一轮），否则入队等句边界 */
  enqueueLlmExpression: (id: string, index: number) => void;
  /** 一个句边界段开播（tts.segment_start）：消费队列里下一个表情 */
  consumeNextExpression: () => void;
  applyVoiceStatus: (status: VoiceStatus) => void;
  applyNetState: (state: 'connecting' | 'success' | 'fail') => void;
  /** 一轮音频真正播完（tts.playback_end）：清队列+解除持有，回待机 */
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
  exprQueue: [],
  firstSegmentSeen: false,
  lastBumpAt: 0,
  tutorialLock: false,

  setTutorialLock: (on) => set({ tutorialLock: on }),

  setExpression: (id, source) => {
    if (!getExpression(id)) return;
    // 引导锁：固定配表表情不被语音状态机 / LLM 句级表情 / 点击覆盖；
    // net-* 异常脸放行（连接断了孩子必须能看见）
    if (get().tutorialLock && source !== 'tutorial' && !id.startsWith('net-')) return;
    set((s) => ({
      expressionId: id,
      fileIndex: pickFileIndex(id),
      bumpKey: s.bumpKey + 1,
      lastBumpAt: Date.now(),
      source,
      // LLM 选的表情持有到本轮播放真正结束（tts.playback_end → endTurn）。
      // llm.done / tts.end 会先把 voiceStatus 拉回 idle 但音频还在播——
      // 没有 hold 的话表情提前被待机脸覆盖，实测踩过
      llmHold: source === 'llm' ? true : s.llmHold,
    }));
  },

  enqueueLlmExpression: (id, index) => {
    const { setExpression } = get();
    if (index === 0) {
      // 新一轮第一个表情：清掉上轮残留队列，开口前先上脸（预告感）
      set({ exprQueue: [], firstSegmentSeen: false });
      setExpression(id, 'llm');
      return;
    }
    set((s) => ({ exprQueue: [...s.exprQueue, id] }));
  },

  consumeNextExpression: () => {
    const { exprQueue, firstSegmentSeen, setExpression } = get();
    // 第 0 句开播：表情 0 已在 enqueue(index 0) 时提前上脸，跳过防错位 +1
    if (!firstSegmentSeen) {
      set({ firstSegmentSeen: true });
      return;
    }
    if (exprQueue.length === 0) return;
    const [next, ...rest] = exprQueue;
    set({ exprQueue: rest });
    setExpression(next, 'llm');
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
    set({ llmHold: false, exprQueue: [], firstSegmentSeen: false });
    // 连网失败脸是异常提示，不被回待机吞掉（下一轮交互自然恢复）
    if (expressionId.startsWith('net-')) return;
    setExpression('head-tilt', 'state');
  },
}));
