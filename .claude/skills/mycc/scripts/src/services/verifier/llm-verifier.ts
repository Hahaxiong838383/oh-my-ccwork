/**
 * LLM Verifier — Gemini Flash 多维度评分
 *
 * 借鉴 llm-as-a-verifier 的 criteria decomposition：
 * 每个 criterion 独立并行调用，结果加权聚合。
 *
 * 关键反模式 prompt："DO NOT trust agent self-assessment. Look at hard evidence only."
 * 环境变量：
 *   GEMINI_PROXY_URL  默认 http://23.226.135.149:4000
 *   GEMINI_PROXY_KEY  必须设置，否则返回 null（静默跳过 LLM）
 */

import type { EvidencePayload } from "./cheap-signals.js";
import type { Criterion } from "./policy.js";

const PROXY_URL = (process.env.GEMINI_PROXY_URL ?? "http://23.226.135.149:4000").replace(/\/$/, "");
const MODEL = "gemini-2.5-flash";
const LLM_TIMEOUT_MS = 15_000;
// 每次调用的 token 估算：~300 input + 5 output（Gemini Flash）
const TOKENS_PER_CALL = 305;

export interface LlmVerifierResult {
  readonly confidence: number;
  readonly tokenCost: number;
  readonly perCriterion: ReadonlyArray<{ readonly id: string; readonly score: number }>;
  readonly reason: string;
}

/**
 * 对 claim/evidence 执行多维度 LLM 评分。
 * 若 GEMINI_PROXY_KEY 未设置，返回 null（保持 dry-run stub 行为）。
 */
export async function runLlmVerifier(
  source: string,
  claim: string,
  evidence: EvidencePayload,
  criteria: readonly Criterion[],
): Promise<LlmVerifierResult | null> {
  const apiKey = process.env.GEMINI_PROXY_KEY;
  if (!apiKey || criteria.length === 0) return null;

  const evidenceSummary = JSON.stringify(evidence, null, 2).slice(0, 1200);

  const scored = await Promise.all(
    criteria.map(async (c) => {
      const score = await scoreCriterion(apiKey, source, claim, evidenceSummary, c);
      return { id: c.id, score, weight: c.weight };
    }),
  );

  const totalWeight = scored.reduce((s, x) => s + x.weight, 0);
  const weightedSum = scored.reduce((s, x) => s + x.score * x.weight, 0);
  const confidence = totalWeight > 0 ? weightedSum / totalWeight : 0.5;
  const tokenCost = criteria.length * TOKENS_PER_CALL;

  const lowest = scored.reduce((a, b) => (a.score < b.score ? a : b));
  const reason =
    confidence >= 0.7
      ? `LLM 验证通过 (conf=${confidence.toFixed(2)}, ${criteria.length} 维)`
      : `LLM 低分 (conf=${confidence.toFixed(2)}, 最低: ${lowest.id}=${lowest.score.toFixed(2)})`;

  return {
    confidence,
    tokenCost,
    perCriterion: scored.map(({ id, score }) => ({ id, score })),
    reason,
  };
}

async function scoreCriterion(
  apiKey: string,
  source: string,
  claim: string,
  evidenceSummary: string,
  criterion: Criterion,
): Promise<number> {
  const prompt = `You are a strict verifier. DO NOT trust the agent's self-assessment. Look at hard evidence only.

Source: ${source}
Claim: "${claim}"

Evidence:
${evidenceSummary}

Scoring dimension: ${criterion.name}
Definition: ${criterion.description}

Rate 0-10 (0=claim false/unverifiable, 10=claim clearly true from evidence).
Reply with a SINGLE INTEGER 0-10. Nothing else.`;

  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  try {
    const resp = await fetch(`${PROXY_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 5,
        temperature: 0,
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      console.warn(`[LlmVerifier] ${criterion.id} HTTP ${resp.status}`);
      return 0.5;
    }

    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content?.trim() ?? "";
    const raw = parseInt(content.match(/^-?\d+/)?.[0] ?? "", 10);
    if (isNaN(raw)) return 0.5;
    return Math.max(0, Math.min(10, raw)) / 10;
  } catch {
    return 0.5;
  } finally {
    clearTimeout(tid);
  }
}
