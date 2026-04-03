/**
 * experience-stream.ts — 经验流 JSONL 异步写入 + 反哺分析
 *
 * 每次请求异步写入 data/experiences/YYYY-MM-DD.jsonl，不阻塞响应。
 * getCategoryBoosts: 聚合最近 N 天经验，返回类别命中频率 boost 值。
 * getInsights: 洞察报告（高频查询、高频类别、失败率、建议补充）。
 */

import { appendFile, mkdir } from "fs/promises";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";

export interface ExperienceEntry {
  timestamp: string;
  model: string;
  query: string;
  responseSnippet: string;
  latencyMs: number;
  injectedCategories: string[];
  injectedItemCount: number;
  retrievalPaths: string[];  // 命中的检索路径：["keyword", "tfidf", "fts", "vector"]
}

function getExpDir(brainRoot: string): string {
  return join(brainRoot, "data", "experiences");
}

function todayFile(brainRoot: string): string {
  const d = new Date().toISOString().slice(0, 10);
  return join(getExpDir(brainRoot), `${d}.jsonl`);
}

export async function writeExperience(
  brainRoot: string,
  entry: ExperienceEntry,
): Promise<void> {
  try {
    const dir = getExpDir(brainRoot);
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    await appendFile(todayFile(brainRoot), JSON.stringify(entry) + "\n");
  } catch {
    // fire-and-forget: never block the response
  }
}

export function getTodayStats(brainRoot: string): {
  count: number;
  models: Record<string, number>;
  avgLatency: number;
} {
  const f = todayFile(brainRoot);
  if (!existsSync(f)) return { count: 0, models: {}, avgLatency: 0 };
  const lines = readFileSync(f, "utf-8").split("\n").filter(Boolean);
  const models: Record<string, number> = {};
  let totalLatency = 0;
  for (const line of lines) {
    try {
      const e: ExperienceEntry = JSON.parse(line);
      models[e.model] = (models[e.model] ?? 0) + 1;
      totalLatency += e.latencyMs;
    } catch { /* skip */ }
  }
  return {
    count: lines.length,
    models,
    avgLatency: lines.length > 0 ? Math.round(totalLatency / lines.length) : 0,
  };
}

export function getRecentDayStats(brainRoot: string, days = 7): Array<{
  date: string;
  count: number;
}> {
  const dir = getExpDir(brainRoot);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort().slice(-days);
  return files.map((f) => {
    const content = readFileSync(join(dir, f), "utf-8");
    const count = content.split("\n").filter(Boolean).length;
    return { date: f.replace(".jsonl", ""), count };
  });
}

// ─── Experience Feedback: Category Boosts ───

interface BoostCache {
  timestamp: number;
  days: number;
  boosts: Map<string, number>;
}

const BOOST_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
let _boostCache: BoostCache | null = null;

function readRecentEntries(brainRoot: string, days: number): ExperienceEntry[] {
  const dir = getExpDir(brainRoot);
  if (!existsSync(dir)) return [];

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl") && f.replace(".jsonl", "") >= cutoffStr)
    .sort();

  const entries: ExperienceEntry[] = [];
  for (const file of files) {
    const lines = readFileSync(join(dir, file), "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as ExperienceEntry);
      } catch { /* skip malformed */ }
    }
  }
  return entries;
}

/**
 * 聚合最近 N 天经验，返回类别命中频率 boost 值。
 * 最高频类别 = 0.3，最低 = 0，线性归一化。
 * 结果缓存 10 分钟。
 */
export function getCategoryBoosts(brainRoot: string, days = 7): Map<string, number> {
  const now = Date.now();
  if (_boostCache && _boostCache.days === days && (now - _boostCache.timestamp) < BOOST_CACHE_TTL_MS) {
    return _boostCache.boosts;
  }

  const entries = readRecentEntries(brainRoot, days);
  const freq = new Map<string, number>();

  for (const entry of entries) {
    for (const cat of entry.injectedCategories) {
      freq.set(cat, (freq.get(cat) ?? 0) + 1);
    }
  }

  const maxFreq = Math.max(...freq.values(), 1);
  const boosts = new Map<string, number>();
  for (const [cat, count] of freq) {
    boosts.set(cat, (count / maxFreq) * 0.3);
  }

  _boostCache = { timestamp: now, days, boosts };
  return boosts;
}

// ─── Experience Feedback: Insights Report ───

export interface InsightsResult {
  topQueries: Array<{ query: string; count: number }>;
  topCategories: Array<{ category: string; hitCount: number }>;
  missRate: number;
  suggestedPatches: string[];
}

/**
 * 洞察报告：高频查询、高频类别、无命中率、建议补充的关键词。
 */
export function getInsights(brainRoot: string, days = 7): InsightsResult {
  const entries = readRecentEntries(brainRoot, days);

  // Top queries (normalized, deduplicated by trimmed text)
  const queryFreq = new Map<string, number>();
  for (const entry of entries) {
    const key = entry.query.trim().toLowerCase().slice(0, 100);
    if (key) queryFreq.set(key, (queryFreq.get(key) ?? 0) + 1);
  }
  const topQueries = [...queryFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([query, count]) => ({ query, count }));

  // Top categories
  const catFreq = new Map<string, number>();
  for (const entry of entries) {
    for (const cat of entry.injectedCategories) {
      catFreq.set(cat, (catFreq.get(cat) ?? 0) + 1);
    }
  }
  const topCategories = [...catFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([category, hitCount]) => ({ category, hitCount }));

  // Miss rate: entries with no injected categories
  const missCount = entries.filter((e) => e.injectedCategories.length === 0).length;
  const missRate = entries.length > 0 ? missCount / entries.length : 0;

  // Suggested patches: extract keywords from missed queries (no category hit)
  const missedQueries = entries
    .filter((e) => e.injectedCategories.length === 0)
    .map((e) => e.query.trim());
  const wordFreq = new Map<string, number>();
  for (const q of missedQueries) {
    // Extract CJK bigrams and latin words
    const cjk = q.match(/[\u4e00-\u9fff\u3400-\u4dbf]{2,}/g) ?? [];
    const latin = q.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
    for (const w of [...cjk, ...latin]) {
      wordFreq.set(w, (wordFreq.get(w) ?? 0) + 1);
    }
  }
  const suggestedPatches = [...wordFreq.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word]) => word);

  return { topQueries, topCategories, missRate, suggestedPatches };
}

// ─── Health Metrics ───

export interface HealthMetrics {
  totalRequests: number;
  avgLatencyMs: number;
  missRate: number;
  retrievalPathHits: Record<string, number>;  // keyword: 42, tfidf: 38, fts: 12, vector: 8
  latencyP50: number;
  latencyP95: number;
  latencyP99: number;
}

export function getHealthMetrics(brainRoot: string, days = 7): HealthMetrics {
  const entries = readRecentEntries(brainRoot, days);

  const totalRequests = entries.length;

  // 延迟统计
  const latencies = entries.map(e => e.latencyMs).sort((a, b) => a - b);
  const avgLatencyMs = totalRequests > 0
    ? Math.round(latencies.reduce((s, l) => s + l, 0) / totalRequests)
    : 0;
  const latencyP50 = totalRequests > 0 ? latencies[Math.floor(totalRequests * 0.5)] : 0;
  const latencyP95 = totalRequests > 0 ? latencies[Math.floor(totalRequests * 0.95)] : 0;
  const latencyP99 = totalRequests > 0 ? latencies[Math.floor(totalRequests * 0.99)] : 0;

  // 未命中率
  const missCount = entries.filter(e => e.injectedCategories.length === 0).length;
  const missRate = totalRequests > 0 ? missCount / totalRequests : 0;

  // 检索路径命中统计（兼容旧数据：旧 JSONL 条目无 retrievalPaths 字段）
  const retrievalPathHits: Record<string, number> = {};
  for (const entry of entries) {
    const paths = (entry as any).retrievalPaths ?? [];
    for (const path of paths) {
      retrievalPathHits[path] = (retrievalPathHits[path] ?? 0) + 1;
    }
  }

  return {
    totalRequests,
    avgLatencyMs,
    missRate,
    retrievalPathHits,
    latencyP50,
    latencyP95,
    latencyP99,
  };
}
