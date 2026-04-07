/**
 * pattern-miner.ts — GAP3 缺口4: 离线学习（模式挖掘）
 *
 * 从经验流中提取两种模式：
 * A. 时间模式（Temporal Patterns）：周几 × 时段 × intent 的频率矩阵
 * B. 类别转换模式（Transition Patterns）：同一天内相邻请求的 intent 转换概率
 *
 * 设计原则：
 * - 纯规则驱动，不引入 LLM 调用
 * - readonly + immutable 风格
 * - 复用 user-state.ts 的 inferUserState() 推断 intent
 * - 持久化到 data/user-patterns.json
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { inferUserState } from "./user-state.js";
import type { ExperienceEntry } from "./experience-stream.js";

// ─── 类型定义 ───

export type TimeSlot = "morning" | "afternoon" | "evening" | "night";

export interface TemporalPattern {
  readonly dayOfWeek: number;     // 0=日 6=六
  readonly timeSlot: TimeSlot;
  readonly dominantIntent: string;
  readonly frequency: number;     // 该时段此 intent 的占比
  readonly sampleSize: number;
}

export interface TransitionPattern {
  readonly from: string;
  readonly to: string;
  readonly count: number;
  readonly probability: number;   // count / total_transitions_from_this_intent
}

export interface UserPatterns {
  readonly temporal: readonly TemporalPattern[];
  readonly transitions: readonly TransitionPattern[];
  readonly minedAt: string;
  readonly experienceCount: number;
  readonly daysCovered: number;
}

// ─── 工具函数 ───

function getTimeSlot(hour: number): TimeSlot {
  if (hour >= 6 && hour < 12) return "morning";
  if (hour >= 12 && hour < 18) return "afternoon";
  if (hour >= 18 && hour < 23) return "evening";
  return "night";
}

function getExpDir(brainRoot: string): string {
  return join(brainRoot, "data", "experiences");
}

function readExperienceEntries(brainRoot: string, days: number): ExperienceEntry[] {
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

function inferIntentFromQuery(query: string): string {
  const state = inferUserState(query);
  return state.intent;
}

// ─── 时间模式挖掘 ───

interface TimeSlotKey {
  readonly dayOfWeek: number;
  readonly timeSlot: TimeSlot;
}

function serializeTimeSlotKey(key: TimeSlotKey): string {
  return `${key.dayOfWeek}:${key.timeSlot}`;
}

function deserializeTimeSlotKey(s: string): TimeSlotKey {
  const [dow, ts] = s.split(":");
  return { dayOfWeek: Number(dow), timeSlot: ts as TimeSlot };
}

function mineTemporalPatterns(entries: ExperienceEntry[]): readonly TemporalPattern[] {
  // 聚合：timeSlotKey → intent → count
  const slotIntentCounts = new Map<string, Map<string, number>>();
  const slotTotals = new Map<string, number>();

  for (const entry of entries) {
    const ts = new Date(entry.timestamp);
    const key = serializeTimeSlotKey({
      dayOfWeek: ts.getDay(),
      timeSlot: getTimeSlot(ts.getHours()),
    });

    const intent = inferIntentFromQuery(entry.query);

    const intentMap = slotIntentCounts.get(key) ?? new Map<string, number>();
    intentMap.set(intent, (intentMap.get(intent) ?? 0) + 1);
    slotIntentCounts.set(key, intentMap);

    slotTotals.set(key, (slotTotals.get(key) ?? 0) + 1);
  }

  // 为每个时段生成 dominant intent pattern
  const patterns: TemporalPattern[] = [];

  for (const [key, intentMap] of slotIntentCounts) {
    const total = slotTotals.get(key) ?? 0;
    if (total === 0) continue;

    const { dayOfWeek, timeSlot } = deserializeTimeSlotKey(key);

    // 找出该时段的 dominant intent
    let dominantIntent = "unknown";
    let maxCount = 0;
    for (const [intent, count] of intentMap) {
      if (count > maxCount) {
        maxCount = count;
        dominantIntent = intent;
      }
    }

    patterns.push({
      dayOfWeek,
      timeSlot,
      dominantIntent,
      frequency: maxCount / total,
      sampleSize: total,
    });
  }

  // 按 frequency 降序排序，取前 10
  return patterns
    .sort((a, b) => b.frequency - a.frequency || b.sampleSize - a.sampleSize)
    .slice(0, 10);
}

// ─── 类别转换模式挖掘 ───

function mineTransitionPatterns(entries: ExperienceEntry[]): readonly TransitionPattern[] {
  // 按日期分组
  const dayGroups = new Map<string, ExperienceEntry[]>();
  for (const entry of entries) {
    const dateKey = entry.timestamp.slice(0, 10);
    const group = dayGroups.get(dateKey) ?? [];
    dayGroups.set(dateKey, [...group, entry]);
  }

  // 统计相邻 intent 转换
  const transitionCounts = new Map<string, number>();
  const fromTotals = new Map<string, number>();

  for (const [, dayEntries] of dayGroups) {
    // 按时间排序
    const sorted = [...dayEntries].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );

    for (let i = 0; i < sorted.length - 1; i++) {
      const fromIntent = inferIntentFromQuery(sorted[i].query);
      const toIntent = inferIntentFromQuery(sorted[i + 1].query);

      const key = `${fromIntent}→${toIntent}`;
      transitionCounts.set(key, (transitionCounts.get(key) ?? 0) + 1);
      fromTotals.set(fromIntent, (fromTotals.get(fromIntent) ?? 0) + 1);
    }
  }

  // 构建 TransitionPattern 列表
  const patterns: TransitionPattern[] = [];
  for (const [key, count] of transitionCounts) {
    const [from, to] = key.split("→");
    const fromTotal = fromTotals.get(from) ?? 1;
    patterns.push({
      from,
      to,
      count,
      probability: count / fromTotal,
    });
  }

  // 按 count 降序排序，取前 10
  return patterns
    .sort((a, b) => b.count - a.count || b.probability - a.probability)
    .slice(0, 10);
}

// ─── 主入口 ───

/**
 * 从经验流中挖掘用户模式，持久化到 data/user-patterns.json。
 *
 * @param brainRoot - brain 项目根目录
 * @param days - 分析的天数范围（默认 30）
 */
export async function mineUserPatterns(
  brainRoot: string,
  days: number = 30,
): Promise<UserPatterns> {
  const entries = readExperienceEntries(brainRoot, days);

  // 统计覆盖天数
  const dateSet = new Set<string>();
  for (const entry of entries) {
    dateSet.add(entry.timestamp.slice(0, 10));
  }

  const temporal = mineTemporalPatterns(entries);
  const transitions = mineTransitionPatterns(entries);

  const patterns: UserPatterns = {
    temporal,
    transitions,
    minedAt: new Date().toISOString(),
    experienceCount: entries.length,
    daysCovered: dateSet.size,
  };

  // 持久化
  const outputPath = join(brainRoot, "data", "user-patterns.json");
  const outputDir = dirname(outputPath);
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }
  writeFileSync(outputPath, JSON.stringify(patterns, null, 2), "utf-8");

  return patterns;
}
