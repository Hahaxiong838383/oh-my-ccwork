import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import type { ContextCache } from "./context-cache.js";
import { openEventsDB, type EventsDB } from "./events.js";
import { isValidEnvelope, type Engine, type ResultEnvelope } from "./envelope.js";

const DISPATCH_RESULT_PREFIX = "/tmp/dispatch-result-";

/**
 * 原子写：先写 .tmp，再 rename 到目标路径。
 * POSIX rename 在同分区是原子操作，poll 侧永远读到完整文件或读不到（ENOENT）。
 */
function atomicWriteEnvelope(targetPath: string, envelope: ResultEnvelope): void {
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, JSON.stringify(envelope), "utf8");
  renameSync(tmpPath, targetPath);
}

export interface DispatchOptions {
  task_id: string;
  engine: "codex" | "gemini";
  prompt: string;
  attempt?: number;
  eventsDB?: EventsDB;
  contextCache?: ContextCache;
}

export interface DispatchHandle {
  task_id: string;
  run_id: string;
  started_at: string;
}

export interface PollOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

export function dispatch(opts: DispatchOptions): DispatchHandle {
  const run_id = randomUUID();
  const started_at = new Date().toISOString();
  void executeInBackground(opts, run_id, started_at);
  return { task_id: opts.task_id, run_id, started_at };
}

async function executeInBackground(
  opts: DispatchOptions,
  run_id: string,
  started_at: string
): Promise<void> {
  const resultPath = `${DISPATCH_RESULT_PREFIX}${run_id}.json`;
  try {
    let result: ResultEnvelope;
    const db = opts.eventsDB ?? openEventsDB();
    if (opts.engine === "codex") {
      const { runCodexTask } = await import("../wrappers/codex-wrapper.js");
      result = await runCodexTask({
        task_id: opts.task_id,
        run_id,
        attempt: opts.attempt ?? 1,
        prompt: opts.prompt,
        eventsDB: db,
        contextCache: opts.contextCache,
      });
    } else {
      const { runGeminiTask } = await import("../wrappers/gemini-wrapper.js");
      result = await runGeminiTask({
        task_id: opts.task_id,
        run_id,
        attempt: opts.attempt ?? 1,
        prompt: opts.prompt,
        eventsDB: db,
        contextCache: opts.contextCache,
      });
    }
    atomicWriteEnvelope(resultPath, result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "dispatch failed";
    const failure: ResultEnvelope = {
      envelope_version: "0.4",
      run_id,
      task_id: opts.task_id,
      engine: opts.engine as Engine,
      attempt: opts.attempt ?? 1,
      started_at,
      finished_at: new Date().toISOString(),
      verdict: "failure",
      summary: message,
      error: { code: "DISPATCH_ERROR", message, retryable: false },
    };
    writeFileSync(resultPath, JSON.stringify(failure), "utf8");
  }
}

/**
 * 读侧容错：文件不存在返回 null（视为 pending）；
 * 文件存在但 JSON.parse 失败或 envelope 结构非法 → 视为残留，unlink 后返回 null。
 * 确保任何 poller 都不会因为 corrupt 文件而抛异常。
 */
function tryLoadEnvelope(resultPath: string): ResultEnvelope | null {
  if (!existsSync(resultPath)) return null;
  let raw: string;
  try {
    raw = readFileSync(resultPath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    try { unlinkSync(resultPath); } catch { /* ignore */ }
    return null;
  }
  if (!isValidEnvelope(parsed)) {
    try { unlinkSync(resultPath); } catch { /* ignore */ }
    return null;
  }
  return parsed;
}

export async function poll(
  run_id: string,
  opts: PollOptions = {}
): Promise<ResultEnvelope | null> {
  const resultPath = `${DISPATCH_RESULT_PREFIX}${run_id}.json`;
  const timeoutMs = opts.timeoutMs ?? 30 * 60 * 1000;
  const intervalMs = opts.intervalMs ?? 5000;
  const deadline = Date.now() + timeoutMs;

  // 先做一次同步探测：支持 timeoutMs=0 作为"存在性检查"单次调用
  const immediate = tryLoadEnvelope(resultPath);
  if (immediate) return immediate;
  if (timeoutMs <= 0) return null;

  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
    const got = tryLoadEnvelope(resultPath);
    if (got) return got;
  }

  return null;
}
