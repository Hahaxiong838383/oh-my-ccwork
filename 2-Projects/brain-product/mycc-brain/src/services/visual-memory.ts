/**
 * visual-memory.ts — 视觉记忆沉淀（Phase 2B-2 扩展）
 *
 * 每 10 分钟聚合 semantic-history JSONL，对比上次结果，
 * 有显著变化时写入 memory-items-visual.md，接入记忆巩固管线。
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import { resolve } from "path";

/* ---------- 常量 ---------- */

const INTERVAL_MS = 600_000; // 10 分钟
const MAX_RECENT_LINES = 40;
const MAX_DAILY_ENTRIES = 5;

const ITEM_KEYWORDS: readonly string[] = [
  "显示器", "键盘", "鼠标", "电脑", "手机", "水杯", "咖啡",
  "耳机", "台灯", "笔记本", "iPad", "充电器", "书", "笔",
  "摄像头", "椅", "桌", "音箱",
];

/* ---------- 类型 ---------- */

interface SemanticRecord {
  readonly ts: string;
  readonly present: boolean | null;
  readonly rawText: string;
  readonly method: string;
  readonly change: string | null;
}

interface PresenceSpan {
  readonly start: string;
  readonly end: string;
}

interface AggregationResult {
  readonly topItems: readonly string[];
  readonly presenceSpans: readonly PresenceSpan[];
  readonly changeCount: number;
  readonly date: string;
}

interface LastCache {
  readonly topItems: readonly string[];
  readonly spanCount: number;
  readonly date: string;
}

/* ---------- 解析辅助 ---------- */

function parseLine(line: string): SemanticRecord | null {
  try {
    const raw = JSON.parse(line);
    return {
      ts: typeof raw.ts === "string" ? raw.ts : "",
      present: raw.present === true ? true : raw.present === false ? false : null,
      rawText: typeof raw.rawText === "string" ? raw.rawText : "",
      method: typeof raw.method === "string" ? raw.method : "",
      change: typeof raw.change === "string" ? raw.change : null,
    };
  } catch {
    return null;
  }
}

function extractTimeHHMM(ts: string): string {
  // ts 可能是 ISO 字符串或 "HH:MM:SS" 等
  const timeMatch = ts.match(/(\d{2}:\d{2})/);
  return timeMatch ? timeMatch[1] : ts.slice(0, 5);
}

/* ---------- 聚合逻辑 ---------- */

function countItemsFromTexts(texts: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const text of texts) {
    for (const keyword of ITEM_KEYWORDS) {
      if (text.includes(keyword)) {
        counts.set(keyword, (counts.get(keyword) ?? 0) + 1);
      }
    }
  }
  return counts;
}

function getTopItems(counts: Map<string, number>, n: number): string[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([keyword]) => keyword);
}

function computePresenceSpans(records: readonly SemanticRecord[]): PresenceSpan[] {
  const spans: PresenceSpan[] = [];
  let spanStart: string | null = null;
  let lastTs = "";

  for (const record of records) {
    if (record.present === true) {
      if (spanStart === null) {
        spanStart = extractTimeHHMM(record.ts);
      }
      lastTs = extractTimeHHMM(record.ts);
    } else {
      if (spanStart !== null) {
        spans.push({ start: spanStart, end: lastTs });
        spanStart = null;
      }
    }
  }

  // 关闭尾部未结束的 span
  if (spanStart !== null) {
    spans.push({ start: spanStart, end: lastTs });
  }

  return spans;
}

function estimateTotalHours(spans: readonly PresenceSpan[]): number {
  let totalMinutes = 0;
  for (const span of spans) {
    const [sh, sm] = span.start.split(":").map(Number);
    const [eh, em] = span.end.split(":").map(Number);
    if (!Number.isNaN(sh) && !Number.isNaN(sm) && !Number.isNaN(eh) && !Number.isNaN(em)) {
      const diff = (eh * 60 + em) - (sh * 60 + sm);
      if (diff > 0) totalMinutes += diff;
    }
  }
  return Math.round((totalMinutes / 60) * 10) / 10; // 保留 1 位小数
}

function aggregate(records: readonly SemanticRecord[], date: string): AggregationResult {
  const texts = records.map((r) => r.rawText);
  const itemCounts = countItemsFromTexts(texts);
  const topItems = getTopItems(itemCounts, 5);
  const presenceSpans = computePresenceSpans(records);
  const changeCount = records.filter((r) => r.change !== null).length;

  return { topItems, presenceSpans, changeCount, date };
}

/* ---------- 对比 & 写入 ---------- */

function hasSignificantChange(current: AggregationResult, last: LastCache | null): boolean {
  if (last === null) return true;

  // 新物品出现（不在上次 top5 中）
  const newItems = current.topItems.filter((item) => !last.topItems.includes(item));
  if (newItems.length > 0) return true;

  // 在位模式变化（时段数不同）
  if (current.presenceSpans.length !== last.spanCount) return true;

  return false;
}

function readLastCache(cachePath: string): LastCache | null {
  if (!existsSync(cachePath)) return null;
  try {
    const raw = JSON.parse(readFileSync(cachePath, "utf-8"));
    return {
      topItems: Array.isArray(raw.topItems) ? raw.topItems : [],
      spanCount: typeof raw.spanCount === "number" ? raw.spanCount : 0,
      date: typeof raw.date === "string" ? raw.date : "",
    };
  } catch {
    return null;
  }
}

function writeLastCache(cachePath: string, result: AggregationResult): void {
  const cache: LastCache = {
    topItems: [...result.topItems],
    spanCount: result.presenceSpans.length,
    date: result.date,
  };
  writeFileSync(cachePath, JSON.stringify(cache, null, 2), "utf-8");
}

function countTodayEntries(memoryPath: string, date: string): number {
  if (!existsSync(memoryPath)) return 0;
  try {
    const content = readFileSync(memoryPath, "utf-8");
    const marker = `（${date}`;
    let count = 0;
    let idx = 0;
    while ((idx = content.indexOf(marker, idx)) !== -1) {
      count++;
      idx += marker.length;
    }
    return count;
  } catch {
    return 0;
  }
}

function formatMemoryEntry(result: AggregationResult): string {
  const itemsLine = result.topItems.length > 0
    ? `- 川哥工位常见物品：${result.topItems.join("、")}（${result.date} 观察）`
    : `- 川哥工位常见物品：无明显物品识别（${result.date} 观察）`;

  const spanStrings = result.presenceSpans.map((s) => `${s.start}-${s.end}`);
  const totalHours = estimateTotalHours(result.presenceSpans);
  const presenceLine = spanStrings.length > 0
    ? `- 今日在位时段：${spanStrings.join(", ")}，共约 ${totalHours}h（${result.date}）`
    : `- 今日在位时段：无记录（${result.date}）`;

  return `\n## [visual]\n\n${itemsLine}\n${presenceLine}\n`;
}

/* ---------- 主聚合函数 ---------- */

function runVisualMemoryAggregation(dataDir: string): void {
  const today = new Date().toISOString().slice(0, 10);
  const historyPath = resolve(dataDir, "activity", `semantic-history-${today}.jsonl`);

  if (!existsSync(historyPath)) {
    console.log(`[visual-memory] 今日历史文件不存在，跳过: ${historyPath}`);
    return;
  }

  // 读取并解析 JSONL
  let content: string;
  try {
    content = readFileSync(historyPath, "utf-8").trim();
  } catch (err) {
    console.log(`[visual-memory] 读取历史文件失败: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  if (!content) {
    console.log("[visual-memory] 历史文件为空，跳过");
    return;
  }

  const lines = content.split("\n");
  const recentLines = lines.slice(-MAX_RECENT_LINES);
  const records: SemanticRecord[] = [];
  for (const line of recentLines) {
    const record = parseLine(line);
    if (record !== null) {
      records.push(record);
    }
  }

  if (records.length === 0) {
    console.log("[visual-memory] 无有效记录，跳过");
    return;
  }

  // 聚合
  const result = aggregate(records, today);

  // 对比上次缓存
  const cachePath = resolve(dataDir, "visual-memory-last.json");
  const lastCache = readLastCache(cachePath);

  if (!hasSignificantChange(result, lastCache)) {
    console.log("[visual-memory] 无显著变化，跳过写入");
    return;
  }

  // 检查每日写入限制
  const memoryPath = resolve(dataDir, "..", "memory-items-visual.md");
  const todayCount = countTodayEntries(memoryPath, today);
  if (todayCount >= MAX_DAILY_ENTRIES) {
    console.log(`[visual-memory] 今日已写入 ${todayCount} 条，达到上限 ${MAX_DAILY_ENTRIES}，跳过`);
    return;
  }

  // 更新缓存
  writeLastCache(cachePath, result);

  // 追加记忆
  const entry = formatMemoryEntry(result);
  appendFileSync(memoryPath, entry, "utf-8");
  console.log(`[visual-memory] 已写入视觉记忆: ${memoryPath} (今日第 ${todayCount + 1} 条)`);
}

/* ---------- 导出 ---------- */

/** 启动视觉记忆定时聚合。dataDir = brain data 目录。 */
export function startVisualMemory(dataDir: string): void {
  // 立即执行一次
  runVisualMemoryAggregation(dataDir);
  // 定时执行
  setInterval(() => runVisualMemoryAggregation(dataDir), INTERVAL_MS);
  console.log(`[visual-memory] 定时聚合已启动，间隔 ${INTERVAL_MS / 60_000} 分钟`);
}
