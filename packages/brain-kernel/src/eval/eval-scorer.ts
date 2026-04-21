/**
 * EvoAgentBench 评分器
 *
 * 三维评分：正确性(0.5) + 完整性(0.3) + 效率(0.2)
 * 每维 0-1 归一化，加权合并为总分
 */

import type { EvalTask } from './eval-tasks.js';

export interface EvalScores {
  readonly correctness: number;
  readonly completeness: number;
  readonly efficiency: number;
  readonly total: number;
}

const WEIGHTS = { correctness: 0.5, completeness: 0.3, efficiency: 0.2 } as const;

function clamp01(v: number): number {
  return Math.min(Math.max(Number.isFinite(v) ? v : 0, 0), 1);
}

/**
 * 基于关键词覆盖的简易评分（不依赖 LLM）
 * 从 referenceAnswer 提取关键词，检查 response 的覆盖率
 */
function keywordOverlap(reference: string, response: string): number {
  const refTokens = extractKeywords(reference);
  if (refTokens.length === 0) return 0.5;

  const respLower = response.toLowerCase();
  const hits = refTokens.filter(t => respLower.includes(t)).length;
  return hits / refTokens.length;
}

function extractKeywords(text: string): readonly string[] {
  // 提取有意义的关键词（>3 字符的英文词 + >1 字符的中文词组）
  const lower = text.toLowerCase();
  const english = lower.match(/\b[a-z]{4,}\b/g) ?? [];
  const chinese = lower.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  // 去重
  return [...new Set([...english, ...chinese])];
}

/**
 * 正确性评分：核心关键词是否命中
 */
function scoreCorrectness(task: EvalTask, response: string): number {
  return clamp01(keywordOverlap(task.referenceAnswer, response));
}

/**
 * 完整性评分：响应长度相对于参考答案的比率
 * 太短扣分，太长也略微扣分（冗余）
 */
function scoreCompleteness(task: EvalTask, response: string): number {
  const refLen = task.referenceAnswer.length;
  const respLen = response.length;
  if (refLen === 0) return 0.5;

  const ratio = respLen / refLen;
  if (ratio < 0.3) return ratio / 0.3 * 0.5; // 太短
  if (ratio > 3.0) return Math.max(0.5, 1 - (ratio - 3) * 0.1); // 太长
  if (ratio >= 0.5 && ratio <= 2.0) return 1.0; // 理想区间
  return 0.7; // 略短或略长
}

/**
 * 效率评分：基于延迟和 token 使用量
 * 阈值针对 Cloud LLM 调整（非本地工具）
 */
function scoreEfficiency(latencyMs: number, totalTokens: number): number {
  // 延迟评分：<3s 满分，>15s 0 分（Cloud LLM 典型延迟 2-8s）
  const latencyScore = latencyMs < 3000 ? 1 : latencyMs > 15000 ? 0 : 1 - (latencyMs - 3000) / 12000;

  // Token 评分：<1000 满分，>6000 0 分
  const tokenScore = totalTokens < 1000 ? 1 : totalTokens > 6000 ? 0 : 1 - (totalTokens - 1000) / 5000;

  return clamp01(latencyScore * 0.6 + tokenScore * 0.4);
}

/**
 * 计算单个任务的评分
 */
export function scoreEvalResult(
  task: EvalTask,
  response: string,
  latencyMs: number,
  totalTokens: number,
): EvalScores {
  // 空响应兜底：超时/失败时全零分
  if (response.trim().length === 0) {
    return { correctness: 0, completeness: 0, efficiency: 0, total: 0 };
  }

  const correctness = clamp01(scoreCorrectness(task, response));
  const completeness = clamp01(scoreCompleteness(task, response));
  const efficiency = clamp01(scoreEfficiency(latencyMs, totalTokens));

  const total = clamp01(
    correctness * WEIGHTS.correctness
    + completeness * WEIGHTS.completeness
    + efficiency * WEIGHTS.efficiency,
  );

  return { correctness, completeness, efficiency, total };
}
