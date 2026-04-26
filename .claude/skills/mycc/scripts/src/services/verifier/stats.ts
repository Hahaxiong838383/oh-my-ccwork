/**
 * Verifier 统计（进程内 24h 滚动窗口）
 *
 * 设计权衡：
 * - 进程重启会丢统计 → V0.1 接受（只是观测数据，不影响业务）
 * - V0.2 视情况落 SQLite（mycc 已有 better-sqlite3）
 */

export type Layer = "cheap" | "cache" | "llm" | "dry-run";

interface Record {
  readonly ts: number;
  readonly source: string;
  readonly layer: Layer;
  readonly accepted: boolean;
  readonly wouldHaveBlocked: boolean;
  readonly tokenCost: number;
  readonly latencyMs: number;
}

const WINDOW_MS = 24 * 60 * 60 * 1000;
const HARD_CAP = 10000; // 内存上限：超过后丢最早的（防泄漏）

const records: Record[] = [];

export function record(entry: Omit<Record, "ts"> & { ts?: number }): void {
  const ts = entry.ts ?? Date.now();
  records.push({ ...entry, ts });
  pruneOld(ts);
  if (records.length > HARD_CAP) {
    records.splice(0, records.length - HARD_CAP);
  }
}

export interface StatsSnapshot {
  readonly range: string;
  readonly totalCalls: number;
  readonly bySource: Readonly<Record_SourceCount>;
  readonly byLayer: Readonly<Record_LayerCount>;
  readonly wouldHaveBlocked: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly tokenCost: number;
  readonly avgLatencyMs: number;
  readonly cheapHitRate: number;
}

type Record_SourceCount = { [source: string]: number };
type Record_LayerCount = { [layer in Layer]?: number };

export function snapshot(rangeMs: number = WINDOW_MS): StatsSnapshot {
  const cutoff = Date.now() - rangeMs;
  const recent = records.filter((r) => r.ts >= cutoff);
  const total = recent.length;

  const bySource: Record_SourceCount = {};
  const byLayer: Record_LayerCount = {};
  let blocked = 0;
  let accepted = 0;
  let tokenCost = 0;
  let latencySum = 0;

  for (const r of recent) {
    bySource[r.source] = (bySource[r.source] ?? 0) + 1;
    byLayer[r.layer] = (byLayer[r.layer] ?? 0) + 1;
    if (r.wouldHaveBlocked) blocked++;
    if (r.accepted) accepted++;
    tokenCost += r.tokenCost;
    latencySum += r.latencyMs;
  }

  const cheapHits = byLayer.cheap ?? 0;
  return {
    range: formatRange(rangeMs),
    totalCalls: total,
    bySource,
    byLayer,
    wouldHaveBlocked: blocked,
    accepted,
    rejected: total - accepted,
    tokenCost,
    avgLatencyMs: total > 0 ? latencySum / total : 0,
    cheapHitRate: total > 0 ? cheapHits / total : 0,
  };
}

/** 测试用：清空 */
export function _reset(): void {
  records.length = 0;
}

function pruneOld(now: number): void {
  const cutoff = now - WINDOW_MS;
  // 保持时间序：从头部丢
  while (records.length > 0 && records[0].ts < cutoff) {
    records.shift();
  }
}

function formatRange(ms: number): string {
  const hours = Math.round(ms / (60 * 60 * 1000));
  return `${hours}h`;
}
