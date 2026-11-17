import { ApiError } from './api-error';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
const text = (v: unknown) => typeof v === 'string' ? v : '';
const number = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
export const observationKinds = ['all', 'rewards', 'inventory', 'makeup_cards', 'progress', 'wallet'] as const;
export type ObservationKind = typeof observationKinds[number];
export type Observation = {
  eventId: string; eventName: string; kind: Exclude<ObservationKind, 'all'>;
  occurredAtMs: number | null; receivedAtMs: number | null; logicalDay: string | null;
  timeStatus: string; sourceMode: string;
  rewards: { itemId: string; kind: string; quantity: number | null; tankId: string | null }[];
  inventory: { itemId: string; before: number | null; after: number | null; delta: number | null; status: string | null; tankId: string | null } | null;
  progress: { elapsedSeconds: number | null; checkpointMinutes: number | null } | null;
};
export function observation(value: unknown): Observation {
  const x = obj(value), inventory = obj(x.inventory), progress = obj(x.progress);
  if (!text(x.eventId) || !observationKinds.slice(1).includes(x.kind as never)) throw new ApiError(502, { error: 'invalid_observation' });
  return {
    eventId: text(x.eventId), eventName: text(x.eventName), kind: x.kind as Observation['kind'],
    occurredAtMs: number(x.occurredAtMs), receivedAtMs: number(x.receivedAtMs), logicalDay: text(x.logicalDay) || null,
    timeStatus: text(x.timeStatus), sourceMode: text(x.sourceMode) || 'unknown',
    rewards: (Array.isArray(x.rewards) ? x.rewards : []).map(v => { const r = obj(v); return { itemId: text(r.itemId), kind: text(r.kind), quantity: number(r.quantity), tankId: text(r.tankId) || null }; }),
    inventory: x.inventory ? { itemId: text(inventory.itemId), before: number(inventory.before), after: number(inventory.after), delta: number(inventory.delta), status: text(inventory.status) || null, tankId: text(inventory.tankId) || null } : null,
    progress: x.progress ? { elapsedSeconds: number(progress.elapsedSeconds), checkpointMinutes: number(progress.checkpointMinutes) } : null,
  };
}
export function observationSummary(value: unknown) {
  const x = obj(value), counts = obj(x.counts), latest = obj(x.latest), coverage = obj(x.coverage);
  const last = (key: string) => latest[key] ? observation(latest[key]) : null;
  return {
    available: x.available === true, reason: text(x.reason),
    counts: { rewards: number(counts.rewards), inventory: number(counts.inventory), makeupCards: number(counts.makeupCards), progress: number(counts.progress), wallet: number(counts.wallet) },
    latest: { rewards: last('rewards'), inventory: last('inventory'), makeupCards: last('makeupCards'), progress: last('progress'), wallet: last('wallet') },
    coverage: { complete: false as const, firstOccurredAtMs: number(coverage.firstOccurredAtMs), lastOccurredAtMs: number(coverage.lastOccurredAtMs), firstReceivedAtMs: number(coverage.firstReceivedAtMs), lastReceivedAtMs: number(coverage.lastReceivedAtMs) },
  };
}
export const observationKindLabel = (kind: string) => ({ all: '全部历史', rewards: '奖励', inventory: '道具库存', makeup_cards: '补勤卡', progress: '奖励进度', wallet: '钱包变化' })[kind] || '历史记录';
export function durationText(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '暂无数据';
  const rounded = Math.floor(seconds);
  return rounded < 60 ? `${rounded} 秒` : rounded % 60 ? `${Math.floor(rounded / 60)} 分 ${rounded % 60} 秒` : `${Math.floor(rounded / 60)} 分钟`;
}
