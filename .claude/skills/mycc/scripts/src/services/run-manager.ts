/**
 * RunManager — 轻量级 CLI Agent 运行管理器
 *
 * 借鉴 ACP 协议的 Run 生命周期模型，但走 stdio 不走 HTTP。
 * 核心能力：
 * - Run 状态机：created → in-progress → completed/failed/cancelled/timed-out
 * - 并发限制：每个引擎最多 N 个并发 Run
 * - 可观测：实时查询任意 Run 的状态、耗时、输出
 * - 自动清理：已完成的 Run 保留 10 分钟后自动清理
 *
 * 零外部依赖，纯 TypeScript 实现。
 */

import { randomUUID } from "crypto";
import type { EngineType } from "../adapters/cli-engine.js";

// ============================================================
// Run 状态机（借鉴 ACP Run lifecycle）
// ============================================================

export type RunStatus =
  | "created"
  | "in-progress"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed-out";

export interface Run {
  /** 唯一标识 */
  id: string;
  /** 执行引擎 */
  engine: EngineType;
  /** prompt 摘要（前 80 字符） */
  promptSummary: string;
  /** 当前状态 */
  status: RunStatus;
  /** 创建时间 */
  createdAt: number;
  /** 开始执行时间 */
  startedAt?: number;
  /** 结束时间 */
  finishedAt?: number;
  /** 输出内容 */
  output?: string;
  /** 错误信息 */
  error?: string;
  /** 来源（飞书 chatId / scheduler / CLI） */
  source?: string;
}

// ============================================================
// RunManager
// ============================================================

/** 每个引擎的并发上限 */
const MAX_CONCURRENT_PER_ENGINE = 2;

/** 已完成 Run 保留时间（10 分钟） */
const RETENTION_MS = 10 * 60 * 1000;

/** 所有 Run（含进行中 + 最近已完成的） */
const runs = new Map<string, Run>();

/**
 * 创建一个新 Run（状态：created）
 */
export function createRun(
  engine: EngineType,
  prompt: string,
  source?: string,
): Run {
  const run: Run = {
    id: randomUUID().substring(0, 8),
    engine,
    promptSummary: prompt.substring(0, 80),
    status: "created",
    createdAt: Date.now(),
    source,
  };
  runs.set(run.id, run);
  return run;
}

/**
 * 标记 Run 开始执行
 */
export function startRun(runId: string): void {
  const run = runs.get(runId);
  if (!run || run.status !== "created") return;
  run.status = "in-progress";
  run.startedAt = Date.now();
}

/**
 * 标记 Run 完成
 */
export function completeRun(runId: string, output: string): void {
  const run = runs.get(runId);
  if (!run) return;
  run.status = "completed";
  run.output = output;
  run.finishedAt = Date.now();
  scheduleCleanup(runId);
  logRun(run);
}

/**
 * 标记 Run 失败
 */
export function failRun(runId: string, error: string, timedOut?: boolean): void {
  const run = runs.get(runId);
  if (!run) return;
  run.status = timedOut ? "timed-out" : "failed";
  run.error = error;
  run.finishedAt = Date.now();
  scheduleCleanup(runId);
  logRun(run);
}

/**
 * 取消 Run
 */
export function cancelRun(runId: string): boolean {
  const run = runs.get(runId);
  if (!run || (run.status !== "created" && run.status !== "in-progress")) {
    return false;
  }
  run.status = "cancelled";
  run.finishedAt = Date.now();
  scheduleCleanup(runId);
  logRun(run);
  return true;
}

/**
 * 查询单个 Run 状态
 */
export function getRun(runId: string): Run | undefined {
  return runs.get(runId);
}

/**
 * 查询指定引擎当前正在执行的 Run 数量
 */
export function getActiveCount(engine: EngineType): number {
  let count = 0;
  runs.forEach((run) => {
    if (run.engine === engine && run.status === "in-progress") {
      count++;
    }
  });
  return count;
}

/**
 * 检查引擎是否可以接受新任务（并发控制）
 */
export function canAcceptRun(engine: EngineType): boolean {
  return getActiveCount(engine) < MAX_CONCURRENT_PER_ENGINE;
}

/**
 * 获取所有活跃 Run（in-progress）
 */
export function getActiveRuns(): Run[] {
  const active: Run[] = [];
  runs.forEach((run) => {
    if (run.status === "in-progress") {
      active.push(run);
    }
  });
  return active;
}

/**
 * 获取指定引擎最近的 Run 列表（最多 10 条）
 */
export function getRecentRuns(engine?: EngineType, limit: number = 10): Run[] {
  const result: Run[] = [];
  runs.forEach((run) => {
    if (!engine || run.engine === engine) {
      result.push(run);
    }
  });
  // 按创建时间倒序
  result.sort((a, b) => b.createdAt - a.createdAt);
  return result.slice(0, limit);
}

/**
 * 生成 Run 摘要（用于飞书状态汇报）
 */
export function getRunSummary(): string {
  const active = getActiveRuns();
  if (active.length === 0) return "无进行中的任务";

  return active
    .map((r) => {
      const elapsed = ((Date.now() - (r.startedAt || r.createdAt)) / 1000).toFixed(0);
      return `• [${r.engine}] ${r.promptSummary}... (${elapsed}s)`;
    })
    .join("\n");
}

// ============================================================
// 内部工具
// ============================================================

function scheduleCleanup(runId: string): void {
  setTimeout(() => {
    runs.delete(runId);
  }, RETENTION_MS);
}

function logRun(run: Run): void {
  const duration = run.finishedAt && run.startedAt
    ? ((run.finishedAt - run.startedAt) / 1000).toFixed(1)
    : "?";
  const outputLen = run.output?.length || 0;
  console.log(
    `[RunManager] ${run.id} [${run.engine}] ${run.status} (${duration}s, output=${outputLen})`
    + (run.error ? ` error=${run.error.substring(0, 100)}` : ""),
  );
}
