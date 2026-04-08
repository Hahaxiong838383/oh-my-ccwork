/**
 * retrieval-evaluator.ts — 检索层硬指标评测
 *
 * 调用 /admin/api/memory-preview 获取 matchedCategories
 * 硬算 categoryHitRate（召回率）和 retrievalPrecision（精确率）
 * 不经过 LLM Judge
 */

import type { TestCase } from "./test-cases.js";
import { httpPost } from "./http-direct.js";

export interface RetrievalResult {
  id: string;
  query: string;
  matched_categories: string[];
  expected_categories: string[];
  item_count: number;
  latency_ms: number;
  category_hit_rate: number;
  retrieval_precision: number;
}

export interface RetrievalSummary {
  total: number;
  avg_hit_rate: number;
  avg_precision: number;
  results: RetrievalResult[];
}

async function callMemoryPreview(
  brainUrl: string,
  query: string,
  authHeaders?: Record<string, string>,
): Promise<{ matchedCategories: string[]; itemCount: number }> {
  const { status, data } = await httpPost(`${brainUrl}/admin/api/memory-preview`, { query }, 2, authHeaders);
  if (status !== 200) {
    throw new Error(`memory-preview ${status}: ${JSON.stringify(data)}`);
  }
  return data as { matchedCategories: string[]; itemCount: number };
}

function calcHitRate(matched: string[], expected: string[]): number {
  if (expected.length === 0) return 1.0; // no expectation = pass
  const hit = expected.filter((e) => matched.includes(e));
  return hit.length / expected.length;
}

function calcPrecision(matched: string[], expected: string[]): number {
  if (matched.length === 0) return expected.length === 0 ? 1.0 : 0.0;
  if (expected.length === 0) return 1.0; // creative/adversarial — no expected = pass
  const hit = matched.filter((m) => expected.includes(m));
  return hit.length / matched.length;
}

export async function evaluateRetrieval(
  cases: TestCase[],
  brainUrl: string,
  authHeaders?: Record<string, string>,
): Promise<RetrievalSummary> {
  const results: RetrievalResult[] = [];

  for (const tc of cases) {
    const start = Date.now();
    try {
      const { matchedCategories, itemCount } = await callMemoryPreview(
        brainUrl,
        tc.query,
        authHeaders,
      );
      const latency = Date.now() - start;

      results.push({
        id: tc.id,
        query: tc.query,
        matched_categories: matchedCategories,
        expected_categories: tc.expected_categories,
        item_count: itemCount,
        latency_ms: latency,
        category_hit_rate: calcHitRate(matchedCategories, tc.expected_categories),
        retrieval_precision: calcPrecision(matchedCategories, tc.expected_categories),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[retrieval] ${tc.id} failed: ${msg}`);
      results.push({
        id: tc.id,
        query: tc.query,
        matched_categories: [],
        expected_categories: tc.expected_categories,
        item_count: 0,
        latency_ms: Date.now() - start,
        category_hit_rate: 0,
        retrieval_precision: 0,
      });
    }
  }

  const withExpected = results.filter((r) => r.expected_categories.length > 0);
  const avgHitRate =
    withExpected.length > 0
      ? withExpected.reduce((s, r) => s + r.category_hit_rate, 0) / withExpected.length
      : 1.0;
  const avgPrecision =
    withExpected.length > 0
      ? withExpected.reduce((s, r) => s + r.retrieval_precision, 0) / withExpected.length
      : 1.0;

  return {
    total: results.length,
    avg_hit_rate: Math.round(avgHitRate * 1000) / 1000,
    avg_precision: Math.round(avgPrecision * 1000) / 1000,
    results,
  };
}
