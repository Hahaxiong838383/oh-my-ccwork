/**
 * steering-tax.ts — 用户纠正频率采集模块
 *
 * fitness = value_created * trust_score / steering_tax
 * 本模块负责 steering_tax 的检测、记录和计算。
 *
 * 设计原则：
 * - 纯正则驱动，不引入 NLP 库
 * - JSONL 存储，与 experience 日志格式一致
 * - 读取失败返回零值，写入失败 fire-and-forget
 */

import { existsSync, mkdirSync, readFileSync, readdirSync } from "fs";
import { appendFile } from "fs/promises";
import { join } from "path";

// ─── Types ───

export type CorrectionType =
  | "explicit_deny"     // "不对"、"错了"、"你搞错了"
  | "redirect"          // "不是这个意思"、"我说的是..."
  | "repeat_request"    // 用户重复发了类似请求（意味着上次没满足）
  | "undo_request"      // "回滚"、"撤销"、"改回来"
  | "frustration";      // "算了"、"不用了"、"无语"

export interface CorrectionEvent {
  readonly timestamp: string;
  readonly conversationId: string;
  readonly userMessage: string;       // 截取前 200 字符
  readonly correctionType: CorrectionType;
  readonly confidence: number;        // 0-1，匹配强度
}

export interface SteeringTaxMetrics {
  readonly totalInteractions: number;
  readonly totalCorrections: number;
  readonly steeringTax: number;       // corrections / totalInteractions, [0, 1]
  readonly trend: "improving" | "stable" | "degrading";
  readonly correctionsByType: Record<CorrectionType, number>;
}

export interface SteeringTaxReport {
  readonly current: SteeringTaxMetrics;
  readonly previous: SteeringTaxMetrics;
  readonly dailyTrend: ReadonlyArray<{
    date: string;
    tax: number;
    corrections: number;
    interactions: number;
  }>;
  readonly recentCorrections: ReadonlyArray<CorrectionEvent>;
}

// ─── Correction Detection ───

const CORRECTION_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  type: CorrectionType;
  confidence: number;
}> = [
  // explicit_deny
  { pattern: /不对|错了|你搞错|不是这样|说错|理解错|弄错|搞反/u, type: "explicit_deny", confidence: 0.9 },
  // redirect
  { pattern: /不是这个意思|我(?:说|要|想)的是|我的意思是|换个|不是让你/u, type: "redirect", confidence: 0.85 },
  // undo_request
  { pattern: /回滚|撤销|改回|恢复|还原|退回|undo|revert|rollback/iu, type: "undo_request", confidence: 0.9 },
  // frustration
  { pattern: /算了|不用了|无语|没事了|别管了|行了行了|forget it/iu, type: "frustration", confidence: 0.7 },
];

/**
 * 按标点分句，逐句匹配纠正模式。
 * 返回最高置信度的匹配，无匹配返回 null。
 */
function splitSentences(text: string): string[] {
  return text.split(/[。！？；\n.!?;]+/).filter(Boolean);
}

export function detectCorrection(userMessage: string): CorrectionEvent | null {
  const sentences = splitSentences(userMessage);
  let bestMatch: { type: CorrectionType; confidence: number } | null = null;

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;

    for (const { pattern, type, confidence } of CORRECTION_PATTERNS) {
      if (pattern.test(trimmed)) {
        if (!bestMatch || confidence > bestMatch.confidence) {
          bestMatch = { type, confidence };
        }
      }
    }
  }

  if (!bestMatch) return null;

  return {
    timestamp: new Date().toISOString(),
    conversationId: "",     // 由调用方填充
    userMessage: userMessage.slice(0, 200),
    correctionType: bestMatch.type,
    confidence: bestMatch.confidence,
  };
}

// ─── JSONL Storage ───

function getSteeringTaxDir(brainRoot: string): string {
  return join(brainRoot, "data", "steering-tax");
}

function getSteeringTaxFilePath(brainRoot: string, date: string): string {
  return join(getSteeringTaxDir(brainRoot), `${date}.jsonl`);
}

function ensureDir(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

/** 记录纠正事件到 JSONL（异步写入，fire-and-forget） */
export function recordCorrection(brainRoot: string, event: CorrectionEvent): void {
  const dir = getSteeringTaxDir(brainRoot);
  ensureDir(dir);

  const date = event.timestamp.slice(0, 10);
  const filePath = getSteeringTaxFilePath(brainRoot, date);
  const line = JSON.stringify(event) + "\n";

  appendFile(filePath, line, "utf-8").catch(() => {
    // fire-and-forget: 写入失败不影响主流程
  });
}

// ─── JSONL Reading Helpers ───

function readJsonlLines(filePath: string): string[] {
  if (!existsSync(filePath)) return [];
  try {
    const content = readFileSync(filePath, "utf-8");
    return content.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function parseCorrectionEvents(lines: string[]): CorrectionEvent[] {
  const events: CorrectionEvent[] = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as CorrectionEvent);
    } catch {
      // skip malformed lines
    }
  }
  return events;
}

// ─── Date Helpers ───

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function getDateRange(days: number, endDate?: Date): string[] {
  const end = endDate ?? new Date();
  const dates: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setDate(d.getDate() - i);
    dates.push(formatDate(d));
  }
  return dates;
}

// ─── Interaction Counting ───

function countExperienceInteractions(brainRoot: string, date: string): number {
  const filePath = join(brainRoot, "data", "experiences", `${date}.jsonl`);
  const lines = readJsonlLines(filePath);
  return lines.length;
}

function countCorrections(brainRoot: string, date: string): CorrectionEvent[] {
  const filePath = getSteeringTaxFilePath(brainRoot, date);
  const lines = readJsonlLines(filePath);
  return parseCorrectionEvents(lines);
}

// ─── Metrics Calculation ───

function emptyCorrectionsByType(): Record<CorrectionType, number> {
  return {
    explicit_deny: 0,
    redirect: 0,
    repeat_request: 0,
    undo_request: 0,
    frustration: 0,
  };
}

function computeMetrics(
  brainRoot: string,
  dates: string[],
  previousTax?: number,
): SteeringTaxMetrics {
  let totalInteractions = 0;
  let totalCorrections = 0;
  const byType = emptyCorrectionsByType();

  for (const date of dates) {
    totalInteractions += countExperienceInteractions(brainRoot, date);
    const events = countCorrections(brainRoot, date);
    totalCorrections += events.length;
    for (const ev of events) {
      byType[ev.correctionType]++;
    }
  }

  const steeringTax = totalInteractions > 0
    ? totalCorrections / totalInteractions
    : 0;

  let trend: "improving" | "stable" | "degrading" = "stable";
  if (previousTax !== undefined) {
    const diff = steeringTax - previousTax;
    if (diff < -0.02) trend = "improving";      // tax 下降 = 改善
    else if (diff > 0.02) trend = "degrading";   // tax 上升 = 退化
  }

  return {
    totalInteractions,
    totalCorrections,
    steeringTax,
    trend,
    correctionsByType: byType,
  };
}

/** 计算指定天数的 steering_tax 指标 */
export function getSteeringTax(brainRoot: string, days: number = 7): SteeringTaxMetrics {
  const now = new Date();
  const currentDates = getDateRange(days, now);

  // 计算前一个周期用于 trend 对比
  const previousEnd = new Date(now);
  previousEnd.setDate(previousEnd.getDate() - days);
  const previousDates = getDateRange(days, previousEnd);

  const previousMetrics = computeMetrics(brainRoot, previousDates);
  return computeMetrics(brainRoot, currentDates, previousMetrics.steeringTax);
}

/** 生成 Admin 仪表板用的完整报告 */
export function getSteeringTaxReport(brainRoot: string): SteeringTaxReport {
  const now = new Date();

  // current: 最近 7 天
  const currentDates = getDateRange(7, now);
  // previous: 上一个 7 天
  const previousEnd = new Date(now);
  previousEnd.setDate(previousEnd.getDate() - 7);
  const previousDates = getDateRange(7, previousEnd);

  const previous = computeMetrics(brainRoot, previousDates);
  const current = computeMetrics(brainRoot, currentDates, previous.steeringTax);

  // 每日趋势
  const dailyTrend: Array<{
    date: string;
    tax: number;
    corrections: number;
    interactions: number;
  }> = [];

  for (const date of currentDates) {
    const interactions = countExperienceInteractions(brainRoot, date);
    const corrections = countCorrections(brainRoot, date).length;
    dailyTrend.push({
      date,
      tax: interactions > 0 ? corrections / interactions : 0,
      corrections,
      interactions,
    });
  }

  // 最近 10 条纠正事件
  const allRecentEvents: CorrectionEvent[] = [];
  const taxDir = getSteeringTaxDir(brainRoot);
  if (existsSync(taxDir)) {
    try {
      const files = readdirSync(taxDir)
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
        .sort()
        .reverse();

      for (const file of files) {
        if (allRecentEvents.length >= 10) break;
        const filePath = join(taxDir, file);
        const events = parseCorrectionEvents(readJsonlLines(filePath));
        allRecentEvents.push(...events);
      }
    } catch {
      // ignore read errors
    }
  }

  const recentCorrections = allRecentEvents
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, 10);

  return {
    current,
    previous,
    dailyTrend,
    recentCorrections,
  };
}
