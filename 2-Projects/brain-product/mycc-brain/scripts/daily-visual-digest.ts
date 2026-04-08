/**
 * daily-visual-digest.ts — 每日视觉行为摘要聚合
 *
 * 从 semantic-history JSONL 聚合昨天的用户行为模式，
 * 写入 data/patterns/visual-digest.jsonl 和 visual-habits.json。
 *
 * 用法: npx tsx scripts/daily-visual-digest.ts
 * 由 scheduler 每日 04:30 调用。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "fs";
import { resolve } from "path";

// ─── 类型定义 ───

interface SemanticHistoryEntry {
  ts: string;
  present: boolean;
  rawText: string;
  method: string;
  change: string | null;
}

interface PresenceSegment {
  start: string; // HH:MM
  end: string;   // HH:MM
}

interface DailyDigest {
  date: string;
  firstSeen: string;
  lastSeen: string;
  totalPresentMinutes: number;
  presenceSegments: PresenceSegment[];
  topObjects: string[];
  sceneChanges: number;
  personArrivals: number;
  personDepartures: number;
}

interface VisualHabits {
  updatedAt: string;
  avgArrival: string;
  avgDeparture: string;
  avgPresentHours: number;
  typicalBreak: string;
  frequentObjects: string[];
  daysAnalyzed: number;
}

// ─── 常量 ───

const OBJECT_KEYWORDS = [
  "显示器", "键盘", "鼠标", "电脑", "手机", "水杯", "咖啡",
  "耳机", "台灯", "笔记本", "iPad", "充电器", "书", "笔",
  "摄像头", "椅", "桌", "音箱",
];

const GAP_THRESHOLD_MS = 30 * 60 * 1000; // 30 分钟间隔视为新 segment
const MAX_DIGEST_LINES = 30;

// ─── 工具函数 ───

function formatHHMM(date: Date): string {
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function minutesToHHMM(minutes: number): string {
  const h = String(Math.floor(minutes / 60) % 24).padStart(2, "0");
  const m = String(Math.round(minutes % 60)).padStart(2, "0");
  return `${h}:${m}`;
}

function roundTo15Min(minutes: number): number {
  return Math.round(minutes / 15) * 15;
}

// ─── 聚合逻辑 ───

function extractObjects(rawText: string): string[] {
  const found: string[] = [];
  for (const kw of OBJECT_KEYWORDS) {
    if (rawText.includes(kw)) {
      found.push(kw);
    }
  }
  return found;
}

function buildDailyDigest(date: string, entries: SemanticHistoryEntry[]): DailyDigest {
  // 按时间排序
  const sorted = [...entries].sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

  // 过滤出 present=true 的记录
  const presentEntries = sorted.filter((e) => e.present === true);

  // firstSeen / lastSeen
  const firstSeen = presentEntries.length > 0 ? formatHHMM(new Date(presentEntries[0].ts)) : "00:00";
  const lastSeen = presentEntries.length > 0 ? formatHHMM(new Date(presentEntries[presentEntries.length - 1].ts)) : "00:00";

  // 在位时段计算
  const segments: PresenceSegment[] = [];
  let segStart: Date | null = null;
  let segEnd: Date | null = null;

  for (const entry of presentEntries) {
    const ts = new Date(entry.ts);
    if (segStart === null || segEnd === null) {
      segStart = ts;
      segEnd = ts;
    } else if (ts.getTime() - segEnd.getTime() > GAP_THRESHOLD_MS) {
      segments.push({ start: formatHHMM(segStart), end: formatHHMM(segEnd) });
      segStart = ts;
      segEnd = ts;
    } else {
      segEnd = ts;
    }
  }
  if (segStart !== null && segEnd !== null) {
    segments.push({ start: formatHHMM(segStart), end: formatHHMM(segEnd) });
  }

  // totalPresentMinutes: 每条 present=true 记录按 15min 计
  const totalPresentMinutes = presentEntries.length * 15;

  // 物品提取与频率统计
  const objectCounts = new Map<string, number>();
  for (const entry of sorted) {
    const objects = extractObjects(entry.rawText);
    for (const obj of objects) {
      objectCounts.set(obj, (objectCounts.get(obj) ?? 0) + 1);
    }
  }
  const topObjects = [...objectCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name]) => name);

  // 变化统计
  const sceneChanges = sorted.filter((e) => e.change !== null && e.change !== undefined).length;
  const personArrivals = sorted.filter((e) => e.change === "person_arrived").length;
  const personDepartures = sorted.filter((e) => e.change === "person_left").length;

  return {
    date,
    firstSeen,
    lastSeen,
    totalPresentMinutes,
    presenceSegments: segments,
    topObjects,
    sceneChanges,
    personArrivals,
    personDepartures,
  };
}

// ─── 7 天滑动平均 ───

function computeVisualHabits(digests: DailyDigest[]): VisualHabits {
  const recent = digests.slice(-7);
  const n = recent.length;

  // 平均到达/离开时间
  const arrivalMinutes = recent.map((d) => hhmmToMinutes(d.firstSeen));
  const departureMinutes = recent.map((d) => hhmmToMinutes(d.lastSeen));
  const avgArrival = minutesToHHMM(arrivalMinutes.reduce((s, v) => s + v, 0) / n);
  const avgDeparture = minutesToHHMM(departureMinutes.reduce((s, v) => s + v, 0) / n);

  // 平均在位小时
  const avgPresentHours = Math.round(
    (recent.reduce((s, d) => s + d.totalPresentMinutes, 0) / n / 60) * 10,
  ) / 10;

  // 最常见休息时段：所有 segment 之间的间隔
  const breakCounts = new Map<string, number>();
  for (const digest of recent) {
    const segs = digest.presenceSegments;
    for (let i = 1; i < segs.length; i++) {
      const breakStart = roundTo15Min(hhmmToMinutes(segs[i - 1].end));
      const breakEnd = roundTo15Min(hhmmToMinutes(segs[i].start));
      if (breakEnd > breakStart) {
        const key = `${minutesToHHMM(breakStart)}-${minutesToHHMM(breakEnd)}`;
        breakCounts.set(key, (breakCounts.get(key) ?? 0) + 1);
      }
    }
  }
  const typicalBreak = breakCounts.size > 0
    ? [...breakCounts.entries()].sort((a, b) => b[1] - a[1])[0][0]
    : "未检测到";

  // 合并所有天的 topObjects 频次
  const objectFreq = new Map<string, number>();
  for (const digest of recent) {
    for (const obj of digest.topObjects) {
      objectFreq.set(obj, (objectFreq.get(obj) ?? 0) + 1);
    }
  }
  const frequentObjects = [...objectFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name]) => name);

  return {
    updatedAt: recent[recent.length - 1].date,
    avgArrival,
    avgDeparture,
    avgPresentHours,
    typicalBreak,
    frequentObjects,
    daysAnalyzed: n,
  };
}

// ─── 主入口 ───

function main(): void {
  const brainRoot = resolve(import.meta.dirname, "..");

  // 计算昨天日期
  const now = new Date();
  const yesterday = new Date(now.getTime() - 86400_000);
  const dateStr = yesterday.toISOString().slice(0, 10);

  // 读取昨天的 semantic-history
  const historyPath = resolve(brainRoot, "data", "activity", `semantic-history-${dateStr}.jsonl`);
  if (!existsSync(historyPath)) {
    console.log(`[daily-visual-digest] 无昨日数据: ${historyPath}，跳过。`);
    return;
  }

  const content = readFileSync(historyPath, "utf-8").trim();
  if (!content) {
    console.log(`[daily-visual-digest] 昨日数据为空: ${historyPath}，跳过。`);
    return;
  }

  const entries: SemanticHistoryEntry[] = content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as SemanticHistoryEntry);

  if (entries.length === 0) {
    console.log(`[daily-visual-digest] 昨日无有效记录，跳过。`);
    return;
  }

  // 聚合
  const digest = buildDailyDigest(dateStr, entries);

  // 确保 data/patterns/ 目录存在
  const patternsDir = resolve(brainRoot, "data", "patterns");
  if (!existsSync(patternsDir)) {
    mkdirSync(patternsDir, { recursive: true });
  }

  // 追加到 visual-digest.jsonl（滚动保留 30 天）
  const digestPath = resolve(patternsDir, "visual-digest.jsonl");
  appendFileSync(digestPath, JSON.stringify(digest) + "\n", "utf-8");

  // 截断保留最后 30 行
  const digestContent = readFileSync(digestPath, "utf-8").trim();
  const digestLines = digestContent.split("\n").filter((l) => l.trim());
  if (digestLines.length > MAX_DIGEST_LINES) {
    writeFileSync(digestPath, digestLines.slice(-MAX_DIGEST_LINES).join("\n") + "\n", "utf-8");
  }

  // 计算 7 天滑动平均
  const allDigests: DailyDigest[] = readFileSync(digestPath, "utf-8")
    .trim()
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as DailyDigest);

  const habits = computeVisualHabits(allDigests);

  // 写入 visual-habits.json
  const habitsPath = resolve(patternsDir, "visual-habits.json");
  writeFileSync(habitsPath, JSON.stringify(habits, null, 2) + "\n", "utf-8");

  console.log(`✅ Daily visual digest complete: ${dateStr} (${entries.length} entries → ${digest.presenceSegments.length} segments)`);
}

main();
