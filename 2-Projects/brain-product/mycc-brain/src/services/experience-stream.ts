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

export type TrajectoryOutcome = "success" | "failure" | "unknown";

export interface ExperienceEntry {
  timestamp: string;
  model: string;
  query: string;
  responseSnippet: string;
  latencyMs: number;
  injectedCategories: string[];
  injectedItemCount: number;
  retrievalPaths: string[];  // 命中的检索路径：["keyword", "tfidf", "fts", "vector"]
  // GAP4: 情感维度（由 brain-api 基于规则标注，非 LLM 推断）
  valence?: number;   // 情感效价 [-1, 1]：-1=负面, 0=中性, 1=正面
  arousal?: number;   // 情感唤醒度 [0, 1]：0=平静, 1=激动
  // 轨迹双流
  outcome?: TrajectoryOutcome;    // 轨迹结果：success/failure/unknown
  failureReason?: string;         // 失败原因（仅 outcome=failure 时有值）
  toolsUsed?: string[];           // 使用的工具列表（agent loop 场景）
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
    // 原有文件继续写入（保持兼容）
    await appendFile(todayFile(brainRoot), JSON.stringify(entry) + "\n");

    // 双流分流
    if (entry.outcome === "success" || entry.outcome === "failure") {
      const trajDir = join(brainRoot, "data", "trajectories", entry.outcome);
      if (!existsSync(trajDir)) await mkdir(trajDir, { recursive: true });
      const d = new Date().toISOString().slice(0, 10);
      await appendFile(join(trajDir, `${d}.jsonl`), JSON.stringify(entry) + "\n");
    }
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

export function readRecentEntries(brainRoot: string, days: number): ExperienceEntry[] {
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

// ─── Memory Health (供给侧洞察) ───

export interface MemoryHealthResult {
  totalItems: number;
  sourceDistribution: Record<string, number>; // brain: 10, air-sync: 25, unknown: 5
  namespaceCoverage: Array<{ namespace: string; itemCount: number; hitCount: number; source: string }>;
  coldRate: number; // 从未被命中的命名空间占比
  coldNamespaces: string[]; // 从未被命中的命名空间列表
}

export function getMemoryHealth(brainRoot: string, days = 30): MemoryHealthResult {
  // 解析 memory-items.md + memory-items-intake.md 并合并
  const dataDir = join(brainRoot, "data");
  const files = ["memory-items.md", "memory-items-intake.md", "memory-items-claude.md"];
  const merged = new Map<string, { header: string; items: string[] }>();
  for (const filename of files) {
    const filePath = join(dataDir, filename);
    if (!existsSync(filePath)) continue;
    const content = readFileSync(filePath, "utf-8");
    let current: { header: string; items: string[] } | null = null;
    for (const line of content.split("\n")) {
      if (/^###?\s*\[.+?\]/.test(line)) {
        const ns = line.match(/\[(.+?)\]/)?.[1] ?? line;
        const existing = merged.get(ns);
        if (existing) { current = existing; }
        else { current = { header: line, items: [] }; merged.set(ns, current); }
      }
      else if (current && line.startsWith("- ")) { current.items.push(line); }
    }
  }
  const categories = [...merged.values()];

  // 1. 解析完成，categories 已填充
  const sourceDist: Record<string, number> = {};
  const nsCoverage: Array<{ namespace: string; itemCount: number; hitCount: number; source: string }> = [];

  for (const cat of categories) {
    const nsMatch = cat.header.match(/\[(.+?)\]/);
    const ns = nsMatch ? nsMatch[1] : cat.header;
    const itemCount = cat.items.length;

    // 统计来源分布
    let primarySource = "unknown";
    const srcCounts: Record<string, number> = {};
    for (const item of cat.items) {
      const srcMatch = item.match(/\[src:(\S+?)\]/);
      const src = srcMatch ? srcMatch[1] : "unknown";
      srcCounts[src] = (srcCounts[src] ?? 0) + 1;
      sourceDist[src] = (sourceDist[src] ?? 0) + 1;
    }
    // 最多来源作为该 namespace 的主来源
    let maxCount = 0;
    for (const [src, count] of Object.entries(srcCounts)) {
      if (count > maxCount) { maxCount = count; primarySource = src; }
    }

    nsCoverage.push({ namespace: ns, itemCount, hitCount: 0, source: primarySource });
  }

  // 2. 从 experience 数据中统计命名空间命中次数
  const entries = readRecentEntries(brainRoot, days);
  const hitSet = new Set<string>();
  const hitCounts = new Map<string, number>();
  for (const entry of entries) {
    for (const cat of entry.injectedCategories) {
      hitSet.add(cat);
      hitCounts.set(cat, (hitCounts.get(cat) ?? 0) + 1);
    }
  }

  // 3. 交叉：为每个 namespace 填充 hitCount
  for (const ns of nsCoverage) {
    ns.hitCount = hitCounts.get(ns.namespace) ?? 0;
  }

  // 4. 冷记忆
  const coldNamespaces = nsCoverage.filter(n => n.hitCount === 0).map(n => n.namespace);
  const coldRate = nsCoverage.length > 0 ? coldNamespaces.length / nsCoverage.length : 0;

  return {
    totalItems: categories.reduce((sum, c) => sum + c.items.length, 0),
    sourceDistribution: sourceDist,
    namespaceCoverage: nsCoverage.sort((a, b) => b.hitCount - a.hitCount),
    coldRate,
    coldNamespaces,
  };
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

// ─── Per-Tool Statistics ───

export interface ToolStats {
  toolName: string;
  totalCalls: number;
  successCount: number;
  failureCount: number;
  successRate: number;
}

export function getPerToolStats(brainRoot: string, days = 7): ToolStats[] {
  const entries = readRecentEntries(brainRoot, days);
  const toolMap = new Map<string, { total: number; success: number; failure: number }>();

  for (const entry of entries) {
    const tools = entry.toolsUsed ?? [];
    for (const tool of tools) {
      const stats = toolMap.get(tool) ?? { total: 0, success: 0, failure: 0 };
      stats.total++;
      if (entry.outcome === "success") stats.success++;
      if (entry.outcome === "failure") stats.failure++;
      toolMap.set(tool, stats);
    }
  }

  return [...toolMap.entries()]
    .map(([toolName, s]) => ({
      toolName,
      totalCalls: s.total,
      successCount: s.success,
      failureCount: s.failure,
      successRate: s.total > 0 ? s.success / s.total : 0,
    }))
    .sort((a, b) => b.totalCalls - a.totalCalls);
}

// ─── Trajectory Dual-Stream Stats ───

export interface DualStreamStats {
  totalEntries: number;
  successCount: number;
  failureCount: number;
  unknownCount: number;
  successRate: number;
  failureRate: number;
  recentFailures: Array<{ timestamp: string; query: string; failureReason?: string }>;
}

export function getDualStreamStats(brainRoot: string, days = 7): DualStreamStats {
  const entries = readRecentEntries(brainRoot, days);
  let successCount = 0;
  let failureCount = 0;
  let unknownCount = 0;
  const failures: Array<{ timestamp: string; query: string; failureReason?: string }> = [];

  for (const entry of entries) {
    if (entry.outcome === "success") successCount++;
    else if (entry.outcome === "failure") {
      failureCount++;
      failures.push({
        timestamp: entry.timestamp,
        query: entry.query.slice(0, 100),
        failureReason: entry.failureReason,
      });
    }
    else unknownCount++;
  }

  const total = entries.length;
  return {
    totalEntries: total,
    successCount,
    failureCount,
    unknownCount,
    successRate: total > 0 ? successCount / total : 0,
    failureRate: total > 0 ? failureCount / total : 0,
    recentFailures: failures.slice(-10),
  };
}
