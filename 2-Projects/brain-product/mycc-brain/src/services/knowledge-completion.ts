/**
 * knowledge-completion.ts — GAP3 离线知识补全
 *
 * 借鉴 Harness Agent Loop 架构：
 * - 从 learningPriority + curiosityScores 生成搜索计划
 * - 对每条搜索任务调用 webSearch()（Gemini grounding）
 * - 结果写入 memory-items.md（标 ★ 低置信度）
 *
 * 每日预算：5 条搜索（可配置），由巩固任务 Phase 6 调用。
 */

import { appendFile, mkdir, readFile, writeFile } from "fs/promises";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { computeLearningPriority, computeCuriosityScores, type LearningItem, type CuriosityEntry } from "./prediction-engine.js";
import { webSearch, type WebSearchResult } from "../tools/web-search.js";

// ─── Types ───

export interface SearchTask {
  readonly topic: string;
  readonly category: string;
  readonly source: "learning_priority" | "curiosity";
  readonly priority: number;
}

export interface CompletionEntry {
  readonly task: SearchTask;
  readonly result: WebSearchResult;
  readonly memoryItem: string;        // 生成的 memory-item 格式文本
  readonly writtenToMemory: boolean;
  readonly completedAt: string;
}

export interface KnowledgeCompletionResult {
  readonly tasksPlanned: number;
  readonly tasksCompleted: number;
  readonly itemsWritten: number;
  readonly errors: readonly string[];
  readonly entries: readonly CompletionEntry[];
  readonly completedAt: string;
}

export interface KnowledgeCompletionConfig {
  readonly maxTasksPerDay: number;     // 每日最大搜索次数（默认 5）
  readonly minPriority: number;        // 最低优先级阈值（默认 0.2）
  readonly memoryItemsPath: string;    // memory-items.md 路径
}

// ─── 搜索计划生成 ───

/**
 * 合并 learningPriority + curiosityScores 生成搜索任务。
 * 去重 + 排序 + 截断到 maxTasks。
 */
function generateSearchPlan(
  learningItems: readonly LearningItem[],
  curiosityItems: readonly CuriosityEntry[],
  maxTasks: number,
  minPriority: number,
): readonly SearchTask[] {
  const tasks: SearchTask[] = [];
  const seenCategories = new Set<string>();

  // 从 learningPriority 提取（预测失败驱动）
  for (const item of learningItems) {
    if (item.priority < minPriority) continue;
    if (seenCategories.has(item.category)) continue;
    seenCategories.add(item.category);
    tasks.push({
      topic: `${item.category} 领域的最新知识和最佳实践`,
      category: item.category,
      source: "learning_priority",
      priority: item.priority,
    });
  }

  // 从 curiosityScores 提取（学习进度最快的方向）
  for (const item of curiosityItems) {
    if (item.delta <= 0) continue; // 只关注正在进步的方向
    if (seenCategories.has(item.category)) continue;
    seenCategories.add(item.category);
    tasks.push({
      topic: `${item.category} 领域的深入知识（当前准确率 ${Math.round(item.recentAccuracy * 100)}%，正在快速学习）`,
      category: item.category,
      source: "curiosity",
      priority: item.delta,
    });
  }

  // 按优先级降序，截断
  return tasks
    .sort((a, b) => b.priority - a.priority)
    .slice(0, maxTasks);
}

// ─── 搜索结果 → memory-item 格式 ───

function formatAsMemoryItem(task: SearchTask, result: WebSearchResult): string {
  const keyPointsText = result.keyPoints
    .map((p) => `- ${p}`)
    .join("\n");

  const sourcesText = result.sources.length > 0
    ? `\n来源: ${result.sources.join(", ")}`
    : "";

  // ★ 低置信度标注（用户决策 C：直接写入，标 ★）
  return [
    `## [${task.category}] ${result.query}`,
    `★ (自动补全 ${new Date().toISOString().slice(0, 10)})`,
    "",
    result.summary,
    "",
    keyPointsText,
    sourcesText,
  ].join("\n").trim();
}

// ─── 写入 memory-items.md ───

async function appendToMemoryItems(
  memoryItemsPath: string,
  memoryItem: string,
): Promise<boolean> {
  try {
    const content = existsSync(memoryItemsPath)
      ? readFileSync(memoryItemsPath, "utf-8")
      : "";

    // 检查是否已有相同标题（简单去重）
    const titleLine = memoryItem.split("\n")[0];
    if (content.includes(titleLine)) {
      return false; // 已存在，跳过
    }

    await appendFile(memoryItemsPath, "\n\n" + memoryItem + "\n");
    return true;
  } catch {
    return false;
  }
}

// ─── 记录补全日志 ───

async function writeCompletionLog(
  brainRoot: string,
  entries: readonly CompletionEntry[],
): Promise<void> {
  try {
    const logDir = join(brainRoot, "data", "knowledge-completion");
    if (!existsSync(logDir)) await mkdir(logDir, { recursive: true });

    const logFile = join(logDir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    const lines = entries.map((e) => JSON.stringify(e)).join("\n");
    await appendFile(logFile, lines + "\n");
  } catch {
    // fire-and-forget
  }
}

// ─── 每日预算检查 ───

function getTodayCompletionCount(brainRoot: string): number {
  const logFile = join(
    brainRoot, "data", "knowledge-completion",
    `${new Date().toISOString().slice(0, 10)}.jsonl`,
  );
  if (!existsSync(logFile)) return 0;
  const lines = readFileSync(logFile, "utf-8").split("\n").filter(Boolean);
  return lines.length;
}

// ─── 主入口 ───

/**
 * 运行知识补全流程。
 *
 * 流程：
 * 1. 检查今日预算
 * 2. 合并 learningPriority + curiosityScores → 搜索计划
 * 3. 逐条执行 webSearch
 * 4. 结果格式化为 memory-item → 写入 memory-items.md（标 ★）
 * 5. 记录补全日志
 */
export async function runKnowledgeCompletion(
  brainRoot: string,
  config: KnowledgeCompletionConfig,
): Promise<KnowledgeCompletionResult> {
  const errors: string[] = [];
  const entries: CompletionEntry[] = [];

  // 检查今日预算
  const todayCount = getTodayCompletionCount(brainRoot);
  const remaining = config.maxTasksPerDay - todayCount;
  if (remaining <= 0) {
    return {
      tasksPlanned: 0,
      tasksCompleted: 0,
      itemsWritten: 0,
      errors: [`Daily budget exhausted (${todayCount}/${config.maxTasksPerDay})`],
      entries: [],
      completedAt: new Date().toISOString(),
    };
  }

  // 获取学习优先级和好奇心分数
  const learningItems = computeLearningPriority(brainRoot, 14);
  let curiosityItems: readonly CuriosityEntry[];
  try {
    curiosityItems = computeCuriosityScores(brainRoot);
  } catch {
    curiosityItems = [];
    errors.push("Failed to compute curiosity scores, using learning priorities only");
  }

  // 生成搜索计划
  const plan = generateSearchPlan(
    learningItems,
    curiosityItems,
    remaining,
    config.minPriority,
  );

  if (plan.length === 0) {
    return {
      tasksPlanned: 0,
      tasksCompleted: 0,
      itemsWritten: 0,
      errors: ["No search tasks generated (insufficient prediction data or all priorities below threshold)"],
      entries: [],
      completedAt: new Date().toISOString(),
    };
  }

  // 逐条执行搜索（串行，避免 rate limit）
  let itemsWritten = 0;

  for (const task of plan) {
    try {
      const result = await webSearch(task.topic);
      const memoryItem = formatAsMemoryItem(task, result);
      const written = await appendToMemoryItems(config.memoryItemsPath, memoryItem);

      if (written) itemsWritten++;

      entries.push({
        task,
        result,
        memoryItem,
        writtenToMemory: written,
        completedAt: new Date().toISOString(),
      });

      // 请求间隔 2 秒，对 Gemini 友善
      await new Promise((r) => setTimeout(r, 2000));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`Search failed for "${task.topic}": ${msg}`);
    }
  }

  // 写日志
  await writeCompletionLog(brainRoot, entries);

  return {
    tasksPlanned: plan.length,
    tasksCompleted: entries.length,
    itemsWritten,
    errors,
    entries,
    completedAt: new Date().toISOString(),
  };
}
