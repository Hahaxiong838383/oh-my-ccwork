/**
 * search-log.ts — 第五路检索的轨迹日志
 *
 * 在 knowledgeSearch() 出口前用 setImmediate 异步写 JSONL，
 * Admin UI 读取并聚合，帮助川哥识别 "该召回但没召回" 的 query
 * → 降低 steering_tax（fitness = value × trust / steering_tax）。
 *
 * 设计原则（对齐 MANIFESTO）：
 *   - **双模运行不阻塞**：所有写入走 setImmediate + 错误静默，绝不阻塞主检索
 *   - **默认脱敏**：query 只存 sha256(12) + 前 20 字符；
 *     设 `DEBUG_KNOWLEDGE_SEARCH_LOG=full` 存明文
 *   - **append-only**：JSONL 文件，读的时候从尾部倒着扫 window
 *   - **静默失败**：读写任何一步失败都回退到安全默认值，不抛
 *
 * 三类事件语义（聚合时区分）：
 *   - 🟢 hit:          triggered=true  AND hit_count > 0
 *   - 🟠 miss:         triggered=true  AND hit_count = 0   ← 最值得看
 *   - 🔴 untriggered:  triggered=false                     ← 可能该调白名单
 */
import { appendFile, readFile } from "fs/promises";
import { createHash } from "crypto";

/** 单条日志事件 */
export interface SearchLogEvent {
  readonly ts: number;
  readonly query_sample: string;
  readonly query_hash: string;
  readonly triggered: boolean;
  readonly trigger_pattern?: string;
  readonly topK: number;
  readonly hit_count: number;
  readonly top_hits: ReadonlyArray<{
    readonly id: number;
    readonly namespace: string;
    readonly doc_title: string;
    readonly rank: number;
  }>;
  readonly latency_ms: number;
  readonly error?: string;
}

/** 聚合快照 */
export interface SearchLogAggregate {
  readonly windowMs: number;
  readonly total: number;
  readonly triggered: number;
  readonly hit: number;
  readonly miss: number;
  readonly untriggered: number;
  readonly avgLatencyMs: number;
  /** 按 hit_count 排序降序 top 5 */
  readonly topHitQueries: ReadonlyArray<{ sample: string; hash: string; count: number }>;
  /** miss（triggered 但 0 召回）top 5 */
  readonly topMissQueries: ReadonlyArray<{ sample: string; hash: string; count: number }>;
  /** untriggered top 5 */
  readonly topUntriggeredQueries: ReadonlyArray<{ sample: string; hash: string; count: number }>;
}

/** 脱敏处理：默认 hash + 前 20 字符，full 模式存完整 query */
export function sanitizeQuerySample(query: string): string {
  const isFullMode = process.env.DEBUG_KNOWLEDGE_SEARCH_LOG === "full";
  if (isFullMode) return query;
  return query.slice(0, 20);
}

export function hashQuery(query: string): string {
  return createHash("sha256").update(query).digest("hex").slice(0, 12);
}

/**
 * 异步追加单条事件到 JSONL。
 * 失败时走 console.error 但不抛（保护主路径）。
 */
export async function appendSearchLog(
  logPath: string,
  event: SearchLogEvent,
): Promise<void> {
  try {
    const line = JSON.stringify(event) + "\n";
    await appendFile(logPath, line, "utf-8");
  } catch (err) {
    console.error(
      "[knowledge-search-log] append failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * 读取 JSONL 日志（仅保留 windowMs 内的事件）。
 * 失败回退到空数组，不抛。
 */
export async function readSearchLog(
  logPath: string,
  windowMs: number = 24 * 60 * 60 * 1000,
): Promise<readonly SearchLogEvent[]> {
  try {
    const raw = await readFile(logPath, "utf-8");
    const cutoff = Date.now() - windowMs;
    const events: SearchLogEvent[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line) as SearchLogEvent;
        if (typeof evt.ts === "number" && evt.ts >= cutoff) {
          events.push(evt);
        }
      } catch {
        /* skip malformed line */
      }
    }
    return events;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      console.error(
        "[knowledge-search-log] read failed:",
        err instanceof Error ? err.message : err,
      );
    }
    return [];
  }
}

/** 按 filter 过滤事件 */
export type SearchLogFilter = "all" | "hit" | "miss" | "untriggered";

export function filterEvents(
  events: readonly SearchLogEvent[],
  filter: SearchLogFilter,
): readonly SearchLogEvent[] {
  if (filter === "all") return events;
  return events.filter((e) => {
    if (filter === "untriggered") return !e.triggered;
    if (filter === "miss") return e.triggered && e.hit_count === 0;
    if (filter === "hit") return e.triggered && e.hit_count > 0;
    return true;
  });
}

/** 聚合：按 query_hash 统计 top N */
function topByHash(
  events: readonly SearchLogEvent[],
  limit = 5,
): ReadonlyArray<{ sample: string; hash: string; count: number }> {
  const counts = new Map<string, { sample: string; count: number }>();
  for (const e of events) {
    const cur = counts.get(e.query_hash);
    if (cur) {
      cur.count += 1;
    } else {
      counts.set(e.query_hash, { sample: e.query_sample, count: 1 });
    }
  }
  return Array.from(counts.entries())
    .map(([hash, { sample, count }]) => ({ hash, sample, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

export function aggregateSearchLog(
  events: readonly SearchLogEvent[],
  windowMs: number,
): SearchLogAggregate {
  const total = events.length;
  const triggered = events.filter((e) => e.triggered).length;
  const hit = events.filter((e) => e.triggered && e.hit_count > 0).length;
  const miss = events.filter((e) => e.triggered && e.hit_count === 0).length;
  const untriggered = total - triggered;
  const latencySum = events.reduce((s, e) => s + (e.latency_ms || 0), 0);
  const avgLatencyMs = total > 0 ? Math.round(latencySum / total) : 0;
  return {
    windowMs,
    total,
    triggered,
    hit,
    miss,
    untriggered,
    avgLatencyMs,
    topHitQueries: topByHash(
      events.filter((e) => e.triggered && e.hit_count > 0),
      5,
    ),
    topMissQueries: topByHash(
      events.filter((e) => e.triggered && e.hit_count === 0),
      5,
    ),
    topUntriggeredQueries: topByHash(
      events.filter((e) => !e.triggered),
      5,
    ),
  };
}

/** 解析 window 参数：'24h' / '1h' / '7d' → ms */
export function parseWindow(windowStr: string | null | undefined): number {
  if (!windowStr) return 24 * 60 * 60 * 1000;
  const m = /^(\d+)([hd])$/.exec(windowStr.trim());
  if (!m) return 24 * 60 * 60 * 1000;
  const n = parseInt(m[1], 10);
  const unit = m[2];
  if (unit === "h") return n * 60 * 60 * 1000;
  if (unit === "d") return n * 24 * 60 * 60 * 1000;
  return 24 * 60 * 60 * 1000;
}
