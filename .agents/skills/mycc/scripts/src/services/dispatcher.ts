import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ContextCache } from "./context-cache.js";
import { openEventsDB, type EventsDB } from "./events.js";
import type { Engine, ResultEnvelope } from "./envelope.js";

const DISPATCH_RESULT_PREFIX = "/tmp/dispatch-result-";

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
    writeFileSync(resultPath, JSON.stringify(result), "utf8");
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

export async function poll(
  run_id: string,
  opts: PollOptions = {}
): Promise<ResultEnvelope | null> {
  const resultPath = `${DISPATCH_RESULT_PREFIX}${run_id}.json`;
  const timeoutMs = opts.timeoutMs ?? 30 * 60 * 1000;
  const intervalMs = opts.intervalMs ?? 5000;
  const deadline = Date.now() + timeoutMs;

  // 先做一次同步探测：支持 timeoutMs=0 作为"存在性检查"单次调用
  if (existsSync(resultPath)) {
    const raw = readFileSync(resultPath, "utf8");
    return JSON.parse(raw) as ResultEnvelope;
  }
  if (timeoutMs <= 0) return null;

  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
    if (existsSync(resultPath)) {
      const raw = readFileSync(resultPath, "utf8");
      return JSON.parse(raw) as ResultEnvelope;
    }
  }

  return null;
}
