import { create } from 'zustand';

/**
 * 通用 Tips 队列（来自 3.13 §1.2）
 *
 * 规则：
 * - 队列最多 3 条
 * - 队列满时新 push 直接丢弃（产品文档明确）
 * - 一条 Tips：浮入 → 停 1s → 浮出（总周期约 1.6s）
 * - 文字 ≤10 字一行；≤20 字两行字号变小；>20 字截断
 */

export interface TipsItem {
  id: string;
  text: string;
  createdAt: number;
}

const MAX_QUEUE = 3;
const TIPS_DURATION_MS = 1600; // 浮入 0.3 + 停 1.0 + 浮出 0.3

interface FeedbackQueueState {
  queue: TipsItem[];
  pushTip: (text: string) => void;
  dismissTip: (id: string) => void;
}

export const useFeedbackQueue = create<FeedbackQueueState>((set, get) => ({
  queue: [],
  pushTip: (rawText) => {
    const text = truncateTip(rawText);
    const { queue } = get();
    if (queue.length >= MAX_QUEUE) return; // 队列满直接丢
    const item: TipsItem = { id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, text, createdAt: Date.now() };
    set({ queue: [...queue, item] });
    setTimeout(() => {
      set((s) => ({ queue: s.queue.filter((t) => t.id !== item.id) }));
    }, TIPS_DURATION_MS);
  },
  dismissTip: (id) => set((s) => ({ queue: s.queue.filter((t) => t.id !== id) })),
}));

function truncateTip(text: string): string {
  return text.length > 20 ? `${text.slice(0, 20)}…` : text;
}
