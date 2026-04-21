/**
 * proxy-ranker.ts — B13c Proxy-Ranker
 *
 * 在 rrfMerge 输出后、formatContext 前进行精排：
 *   1. 根据 ContextBudget 确定 top-K（Fibonacci tier）
 *   2. 贪心边际贡献选取：优先选与 query 相关且与已选不重复的 truth
 *
 * Fibonacci tier topK 映射（产品定义 V1.3 §3.1）：
 *   POOR=1, LOW=3, HIGH=8, PEAK=20
 */

import type { CompiledTruth } from '@evodesk/shared';
import { tokenize } from '../lib/tokenize.js';

// ============================================================
// Context Budget
// ============================================================

export type ContextBudget = 'PEAK' | 'HIGH' | 'LOW' | 'POOR';

const BUDGET_TOP_K: Readonly<Record<ContextBudget, number>> = {
  PEAK: 20,
  HIGH: 8,
  LOW:  3,
  POOR: 1,
} as const;

// ============================================================
// 边际贡献预估
// ============================================================

function marginalScore(
  truth: CompiledTruth,
  queryTerms: ReadonlySet<string>,
  covered: ReadonlySet<string>,
): number {
  const terms = tokenize(`${truth.domain} ${truth.statement}`);
  let newRelevant = 0;
  for (const t of terms) {
    if (queryTerms.has(t) && !covered.has(t)) newRelevant++;
  }
  return newRelevant;
}

// ============================================================
// Proxy-Ranker 主函数
// ============================================================

/**
 * proxyRank — rrfMerge 后的精排（纯函数，无副作用）。
 *
 * 1. 按 budget 确定 topK（Fibonacci tier）
 * 2. 空 query → 直接截断，保持 rrfMerge 原始顺序
 * 3. 贪心边际贡献：每步选当前剩余中边际贡献最大的 truth；平局保持原始顺序
 */
export function proxyRank(
  merged: readonly CompiledTruth[],
  query: string,
  budget: ContextBudget = 'HIGH',
): readonly CompiledTruth[] {
  if (merged.length === 0) return merged;

  const topK = BUDGET_TOP_K[budget];
  if (merged.length <= topK) return merged;

  const queryTerms = new Set(tokenize(query.trim()));
  if (queryTerms.size === 0) {
    return merged.slice(0, topK);
  }

  const selected: CompiledTruth[] = [];
  const remaining = [...merged];
  const covered = new Set<string>();

  while (selected.length < topK && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -1;

    for (let i = 0; i < remaining.length; i++) {
      const score = marginalScore(remaining[i], queryTerms, covered);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    const chosen = remaining[bestIdx];
    selected.push(chosen);
    for (const t of tokenize(`${chosen.domain} ${chosen.statement}`)) {
      covered.add(t);
    }
    remaining.splice(bestIdx, 1);
  }

  return selected;
}
