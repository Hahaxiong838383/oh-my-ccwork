/**
 * extractor.ts — Gemini Flash 原子事实抽取器（stub）
 *
 * Spike 阶段只定义类型 + 两个纯函数（estimateCostUsd / validateFact）。
 * 真正的 `extractFacts()` 实装由 Spike 的一次性脚本验证 prompt + 调用姿势，
 * 然后 P0 把脚本里的稳定部分搬进来。
 *
 * 预算硬顶：Spike 阶段 $0.50，P0 阶段由 ExtractorOptions.budgetUsd 控制。
 *
 * 依赖：brain 的 `memoryLLM.intake` 路由（见 src/config.ts），
 *       或 .env.local 的 GEMINI_PROXY_BASE + GEMINI_PROXY_KEY。
 */
import type { ExtractedFact, ExtractionResult } from "./types.js";

/** OpenAI 兼容 proxy 客户端配置 */
export interface GeminiClientConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly maxTokens: number;
  readonly temperature: number;
}

export interface ExtractorOptions {
  readonly client: GeminiClientConfig;
  /** 单次调用成本硬上限（USD）；超出直接抛错 */
  readonly budgetUsd: number;
  /** 可选的 namespace 提示（给 prompt 做 hint） */
  readonly namespaceHint?: string;
}

export interface ExtractInput {
  readonly docToken: string;
  readonly docTitle: string;
  readonly contentHash: string;
  readonly content: string;
}

/**
 * Gemini Flash 2.5 公示单价（per 1M tokens, USD, 2026-04）
 * 用于成本估算；proxy 端可能加 markup，实际扣费以 proxy 账单为准。
 */
const GEMINI_FLASH_PRICING = {
  inputUsdPer1M: 0.075,
  outputUsdPer1M: 0.3,
} as const;

/** 纯函数：按公示单价估算成本 */
export function estimateCostUsd(tokenIn: number, tokenOut: number): number {
  return (
    (tokenIn / 1_000_000) * GEMINI_FLASH_PRICING.inputUsdPer1M +
    (tokenOut / 1_000_000) * GEMINI_FLASH_PRICING.outputUsdPer1M
  );
}

/** 抽取入口（stub，P0 实装） */
export async function extractFacts(
  _input: ExtractInput,
  _options: ExtractorOptions,
): Promise<ExtractionResult> {
  throw new Error(
    "extractor.extractFacts is not implemented (stub). Spike uses tasks/knowledge-spike/scripts/ to validate prompt + call pattern first.",
  );
}

/** 纯函数：验证一个 unknown 是否符合 ExtractedFact 形状（P0 复用） */
export function validateFact(value: unknown): value is ExtractedFact {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.content !== "string" || v.content.length === 0) return false;
  if (!Array.isArray(v.keywords)) return false;
  if (!v.keywords.every((k) => typeof k === "string")) return false;
  if (typeof v.confidence !== "number") return false;
  if (v.confidence < 0 || v.confidence > 1) return false;
  if (typeof v.namespace !== "string" || v.namespace.length === 0) return false;
  return true;
}
