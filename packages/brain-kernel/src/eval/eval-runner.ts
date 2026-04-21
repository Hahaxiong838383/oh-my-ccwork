/**
 * EvoAgentBench 运行器
 *
 * 三档测量：
 * - Baseline: 无记忆注入，纯 LLM 回答
 * - Memory: 有记忆上下文注入
 * - Full: 记忆 + Gates 门控 + flowBoost 动态提示词
 */

import { getDb } from '../memory/memory-db.js';
import { getLlmConfig } from '../memory/memcell-extractor.js';
import { loadBrainContext, buildBrainSystemPrompt } from '../memory/brain-context.js';
import { EVAL_TASKS, type EvalTask } from './eval-tasks.js';
import { scoreEvalResult, type EvalScores } from './eval-scorer.js';

export type EvalTier = 'baseline' | 'memory' | 'full';

export interface EvalResult {
  readonly id: string;
  readonly taskId: string;
  readonly tier: EvalTier;
  readonly scores: EvalScores;
  readonly latencyMs: number;
  readonly totalTokens: number;
  readonly response: string;
  readonly timestamp: number;
}

const CHAT_SYSTEM_PROMPT = '你是 EvoDesk，一个自进化桌面 AI 助手。简洁、有用、有深度。用中文回复。';

const BOOST_PROMPTS: Record<string, string> = {
  BOREDOM: '\n\n[flowBoost:BOREDOM] 请提供更深入、更有挑战性的分析。',
  ANXIETY: '\n\n[flowBoost:ANXIETY] 请简化回答，分步骤说明。',
  APATHY: '\n\n[flowBoost:APATHY] 请深入思考后再回答，避免模板化输出。',
};

// ============================================================
// DB Schema — eval_results
// ============================================================

export function initEvalTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS eval_results (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      tier TEXT NOT NULL CHECK(tier IN ('baseline', 'memory', 'full')),
      scores_json TEXT NOT NULL,
      latency_ms INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      response TEXT NOT NULL DEFAULT '',
      timestamp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_eval_task_tier ON eval_results(task_id, tier);
    CREATE INDEX IF NOT EXISTS idx_eval_ts ON eval_results(timestamp DESC);
  `);
}

// ============================================================
// LLM 调用
// ============================================================

interface LlmCallResult {
  readonly content: string;
  readonly latencyMs: number;
  readonly totalTokens: number;
}

async function callLlm(systemPrompt: string, userMessage: string): Promise<LlmCallResult> {
  const llmConfig = getLlmConfig();
  if (!llmConfig) throw new Error('LLM not configured');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  const start = Date.now();

  try {
    const res = await fetch(`${llmConfig.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${llmConfig.apiKey}`,
      },
      body: JSON.stringify({
        model: llmConfig.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        max_tokens: llmConfig.maxTokens ?? 4096,
        temperature: 0.7,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`LLM API ${res.status}`);
    }

    const json = await res.json() as {
      choices: { message: { content: string } }[];
      usage?: { total_tokens?: number };
    };

    return {
      content: json.choices[0]?.message?.content ?? '',
      latencyMs: Date.now() - start,
      totalTokens: json.usage?.total_tokens ?? 0,
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ============================================================
// 三档运行
// ============================================================

async function buildSystemPrompt(tier: EvalTier, userMessage: string): Promise<string> {
  switch (tier) {
    case 'baseline':
      return CHAT_SYSTEM_PROMPT;
    case 'memory': {
      const brainResult = await loadBrainContext(userMessage);
      return buildBrainSystemPrompt(CHAT_SYSTEM_PROMPT, brainResult.context, brainResult.itemCount);
    }
    case 'full': {
      const brainResult = await loadBrainContext(userMessage);
      const withMemory = buildBrainSystemPrompt(CHAT_SYSTEM_PROMPT, brainResult.context, brainResult.itemCount);
      return `${withMemory}${BOOST_PROMPTS['BOREDOM']}`;
    }
  }
}

/**
 * 运行单个任务的单个档位评测
 */
export async function runSingleEval(taskId: string, tier: EvalTier): Promise<EvalResult> {
  const task = EVAL_TASKS.find(t => t.taskId === taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  const systemPrompt = await buildSystemPrompt(tier, task.userMessage);
  const { content, latencyMs, totalTokens } = await callLlm(systemPrompt, task.userMessage);
  const scores = scoreEvalResult(task, content, latencyMs, totalTokens);

  const result: EvalResult = {
    id: crypto.randomUUID(),
    taskId,
    tier,
    scores,
    latencyMs,
    totalTokens,
    response: content,
    timestamp: Date.now(),
  };

  // 持久化
  persistEvalResult(result);
  return result;
}

/**
 * 运行所有任务的指定档位评测
 */
export async function runAllEvals(tier: EvalTier): Promise<readonly EvalResult[]> {
  const results: EvalResult[] = [];
  for (const task of EVAL_TASKS) {
    const result = await runSingleEval(task.taskId, tier);
    results.push(result);
  }
  return results;
}

// ============================================================
// 持久化
// ============================================================

function persistEvalResult(result: EvalResult): void {
  try {
    getDb().prepare(`
      INSERT INTO eval_results (id, task_id, tier, scores_json, latency_ms, total_tokens, response, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      result.id, result.taskId, result.tier,
      JSON.stringify(result.scores), result.latencyMs, result.totalTokens,
      result.response, result.timestamp,
    );
  } catch {
    // 静默跳过（表可能未初始化）
  }
}

/**
 * 查询评测结果
 */
export function listEvalResults(limit = 50): readonly EvalResult[] {
  try {
    const rows = getDb().prepare(
      'SELECT * FROM eval_results ORDER BY timestamp DESC LIMIT ?'
    ).all(limit) as Array<{
      id: string; task_id: string; tier: string; scores_json: string;
      latency_ms: number; total_tokens: number; response: string; timestamp: number;
    }>;

    return rows.flatMap(r => {
      try {
        return [{
          id: r.id,
          taskId: r.task_id,
          tier: r.tier as EvalTier,
          scores: JSON.parse(r.scores_json) as EvalScores,
          latencyMs: r.latency_ms,
          totalTokens: r.total_tokens,
          response: r.response,
          timestamp: r.timestamp,
        }];
      } catch { return []; }
    });
  } catch {
    return [];
  }
}
