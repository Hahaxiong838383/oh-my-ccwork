/**
 * 双路召回 + RRF (Reciprocal Rank Fusion)
 *
 * Path 1: FTS5 全文搜索（现有 searchTruths）
 * Path 2: 关键词伪向量匹配（TF-IDF-like）
 * 融合: RRF score = Σ 1/(k + rank_i), k=60
 */
import type { CompiledTruth } from '@evodesk/shared';
import { searchTruths, listTruths } from './memory-db.js';
import { tokenize } from '../lib/tokenize.js';

const RRF_K = 60;
const DEFAULT_LIMIT = 10;

// ============================================================
// Path 2: 关键词伪向量匹配
// ============================================================

function termFrequency(tokens: readonly string[]): ReadonlyMap<string, number> {
  const freq = new Map<string, number>();
  for (const t of tokens) {
    freq.set(t, (freq.get(t) ?? 0) + 1);
  }
  return freq;
}

/**
 * 基于关键词重叠的余弦相似度（伪向量）
 */
function keywordSimilarity(queryTokens: readonly string[], statementTokens: readonly string[]): number {
  if (queryTokens.length === 0 || statementTokens.length === 0) return 0;

  const qFreq = termFrequency(queryTokens);
  const sFreq = termFrequency(statementTokens);

  let dotProduct = 0;
  let qMag = 0;
  let sMag = 0;

  const allTerms = new Set([...qFreq.keys(), ...sFreq.keys()]);
  for (const term of allTerms) {
    const qVal = qFreq.get(term) ?? 0;
    const sVal = sFreq.get(term) ?? 0;
    dotProduct += qVal * sVal;
    qMag += qVal * qVal;
    sMag += sVal * sVal;
  }

  const magnitude = Math.sqrt(qMag) * Math.sqrt(sMag);
  return magnitude > 0 ? dotProduct / magnitude : 0;
}

interface ScoredTruth {
  readonly truth: CompiledTruth;
  readonly score: number;
}

/** keyword 路径最大扫描条数，控制主线程阻塞时间 */
const KEYWORD_SCAN_LIMIT = 200;

/**
 * 关键词伪向量路径：扫描最近 N 条有效真值，按相似度排序。
 * 控制在 200 条以内，避免主线程阻塞。大规模时需切换到真实向量索引。
 */
function searchByKeywordVector(query: string, limit: number): readonly ScoredTruth[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  const allTruths = listTruths(KEYWORD_SCAN_LIMIT);
  const scored: ScoredTruth[] = allTruths
    .map(truth => {
      const statementTokens = tokenize(`${truth.domain} ${truth.statement}`);
      const score = keywordSimilarity(queryTokens, statementTokens);
      return { truth, score };
    })
    .filter(s => s.score > 0);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// ============================================================
// RRF 融合
// ============================================================

/**
 * RRF 公式: score = Σ 1/(k + rank_i)
 * 双路排名取倒数和，k=60 平滑因子
 */
export function hybridSearch(query: string, limit: number = DEFAULT_LIMIT): readonly CompiledTruth[] {
  // Path 1: FTS5
  const ftsResults = searchTruths(query, limit * 2);

  // Path 2: 关键词伪向量
  const vectorResults = searchByKeywordVector(query, limit * 2);

  // 构建 RRF 分数映射
  const rrfScores = new Map<string, { truth: CompiledTruth; score: number }>();

  // FTS5 路径贡献
  ftsResults.forEach((truth, rank) => {
    const rrfScore = 1 / (RRF_K + rank);
    const existing = rrfScores.get(truth.id);
    rrfScores.set(truth.id, {
      truth,
      score: (existing?.score ?? 0) + rrfScore,
    });
  });

  // 关键词路径贡献
  vectorResults.forEach(({ truth }, rank) => {
    const rrfScore = 1 / (RRF_K + rank);
    const existing = rrfScores.get(truth.id);
    rrfScores.set(truth.id, {
      truth: existing?.truth ?? truth,
      score: (existing?.score ?? 0) + rrfScore,
    });
  });

  // 按 RRF 分数降序排列
  const merged = [...rrfScores.values()];
  merged.sort((a, b) => b.score - a.score);

  return merged.slice(0, limit).map(s => s.truth);
}

/**
 * 纯 FTS5 搜索（兼容原有路径）
 */
export function ftsSearch(query: string, limit: number = DEFAULT_LIMIT): readonly CompiledTruth[] {
  return searchTruths(query, limit);
}
