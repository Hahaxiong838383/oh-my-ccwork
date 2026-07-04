// 记忆面板共享类型 + 五类视觉常量(单一真源:列表/图谱/流水线/DebugFlow 事件统一用这套)。
// 字段与 apps/server/src/memory-item-store.ts 的 MemoryItem 逐字对齐,改动必须两边同步。

export type MemoryTypeKey = 'promise' | 'event' | 'emotion' | 'relation' | 'preference';

export interface MemoryItemView {
  id: string;
  account_id: string;
  type: MemoryTypeKey;
  content: string;
  subject: string;
  status: 'active' | 'resolved' | 'retracted' | 'archived';
  confidence: number;
  source: string; // voice | parent | system | manual
  session_id: string;
  source_role: string; // user | assistant
  source_quote: string;
  due_text: string;
  due_at: number | null;
  due_granularity: string; // day | next_session | unknown | ''
  meta: string;
  created_at: number;
  last_injected_at: number;
  resolved_at: number | null;
}

export interface InterestView {
  value: string;
  note?: string;
}

export interface ProfileView {
  nickname: string;
  birthday: string; // YYYY-MM 或 ''
  gender: string;
  interests: InterestView[];
}

export interface MemoryApiResponse {
  ok: boolean;
  profile: ProfileView | null;
  items: MemoryItemView[];
  archived_emotion_count: number;
  server_now: number;
}

// last_injected_at 距 server_now 在此窗口内 = 「小可现在记着这条」高亮
export const INJECT_RECENT_MS = 15 * 60 * 1000;

export interface TypeMeta {
  label: string;
  emoji: string;
  hex: string; // 图谱 SVG 用
  taxonomy: '情景记忆' | '语义记忆';
  lifecycle: string;
  cap: number | null; // null = 无上限(promise)
  badgeCls: string; // tailwind 完整类串(JIT 禁止拼接)
  dotCls: string;
}

export const TYPE_META: Record<MemoryTypeKey, TypeMeta> = {
  promise: {
    label: '约定', emoji: '🤝', hex: '#34d399',
    taxonomy: '情景记忆', lifecycle: '永不遗忘,直到兑现', cap: null,
    badgeCls: 'bg-emerald-500/15 text-emerald-300', dotCls: 'bg-emerald-400',
  },
  event: {
    label: '最近的事', emoji: '📅', hex: '#38bdf8',
    taxonomy: '情景记忆', lifecycle: '滚动保留最近 30 件', cap: 30,
    badgeCls: 'bg-sky-500/15 text-sky-300', dotCls: 'bg-sky-400',
  },
  emotion: {
    label: '情绪近况', emoji: '💛', hex: '#fbbf24',
    taxonomy: '情景记忆', lifecycle: '30 天后淡忘归档', cap: 60,
    badgeCls: 'bg-amber-500/15 text-amber-300', dotCls: 'bg-amber-400',
  },
  relation: {
    label: '重要的人', emoji: '👥', hex: '#f472b6',
    taxonomy: '语义记忆', lifecycle: '稳定保留(最多 8 人)', cap: 8,
    badgeCls: 'bg-pink-500/15 text-pink-300', dotCls: 'bg-pink-400',
  },
  preference: {
    label: '偏好', emoji: '⭐', hex: '#a78bfa',
    taxonomy: '语义记忆', lifecycle: '稳定保留(最多 10 条)', cap: 10,
    badgeCls: 'bg-violet-500/15 text-violet-300', dotCls: 'bg-violet-400',
  },
};

export const TYPE_ORDER: MemoryTypeKey[] = ['promise', 'emotion', 'relation', 'preference', 'event'];
