/**
 * extractor.ts — Gemini Flash 原子事实抽取器（P0.2 实装）
 *
 * 职责：
 *   - 给一篇 docx 正文，调 Gemini Flash 抽出 `{facts: [...]}`。
 *   - F3 tweak（Spike 发现）：SYSTEM_PROMPT 强制"仅抽取原文明确陈述的事实"，
 *     防止模型虚构/补形容词。
 *   - T4 tweak：前端过滤 confidence < 0.85 的条目。
 *   - 预算硬顶：options.budgetUsd；超出抛 BudgetExceededError 中断本轮调度。
 *   - 重试 × 2：网络/HTTP 错误指数退避；解析失败不重试（返回空 facts）。
 *   - **不写 knowledge_items**：只返回 ExtractionResult，落盘由调度器决定。
 *
 * 依赖：openai-compat proxy（baseUrl + apiKey 由调用方提供），
 *       模型固定 gemini-2.5-flash（可由 GeminiClientConfig.model 覆盖）。
 */
import type {
  ExtractedFact,
  ExtractionResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

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

/** 可注入的 fetch（测试用） */
export type FetchFn = typeof fetch;

/**
 * Gemini Flash 2.5 公示单价（per 1M tokens, USD, 2026-04）
 * 用于成本估算；proxy 端可能加 markup，实际扣费以 proxy 账单为准。
 */
const GEMINI_FLASH_PRICING = {
  inputUsdPer1M: 0.075,
  outputUsdPer1M: 0.3,
} as const;

/** 预算超限错误 */
export class BudgetExceededError extends Error {
  constructor(
    public readonly spent: number,
    public readonly budget: number,
  ) {
    super(
      `Gemini Flash budget exceeded: spent=$${spent.toFixed(6)} budget=$${budget.toFixed(2)}`,
    );
    this.name = "BudgetExceededError";
  }
}

// ---------------------------------------------------------------------------
// 纯函数（P0 复用）
// ---------------------------------------------------------------------------

/** 纯函数：按公示单价估算成本 */
export function estimateCostUsd(tokenIn: number, tokenOut: number): number {
  return (
    (tokenIn / 1_000_000) * GEMINI_FLASH_PRICING.inputUsdPer1M +
    (tokenOut / 1_000_000) * GEMINI_FLASH_PRICING.outputUsdPer1M
  );
}

/** 纯函数：验证一个 unknown 是否符合 ExtractedFact 形状 */
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

// ---------------------------------------------------------------------------
// Gemini Flash Prompt（F3 tweak 版）
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `你是一个精确的知识抽取器。从飞书文档正文中抽取"原子事实"。
每个事实必须：
1. 是 1-2 句话的独立断言
2. 包含具体信息（名词/数字/决策），不是空洞套话或目录标题
3. 跳过导航、目录、"同步块"标记、空白占位
4. 如果文档只是目录或空壳，返回空的 facts 数组

额外约束（严格遵守 — F3 tweak）：
- 只抽取原文**明确陈述**的事实；如果某条信息需要你推断或补充形容词，**不要输出该条目**。
- 宁可少抽几条、宁可返回空数组，也不要编造或扩写。

输出必须是严格合法 JSON，格式：
{
  "facts": [
    {
      "content": "一段原子事实，1-2 句话，包含具体信息",
      "keywords": ["词1", "词2", "词3"],
      "confidence": 0.0-1.0 的数字,
      "namespace": "类别路径，如 公司/战略/目标"
    }
  ]
}

confidence 低于 0.5 的事实不要输出。keywords 3-6 个中文关键词。namespace 用 / 分层的中文路径。`;

/** T4 tweak：丢弃低于此阈值的 facts */
const CONFIDENCE_THRESHOLD = 0.85;

// ---------------------------------------------------------------------------
// Gemini Flash HTTP 调用
// ---------------------------------------------------------------------------

interface GeminiChatResponse {
  readonly choices?: ReadonlyArray<{
    readonly message?: { readonly content?: string };
  }>;
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
  };
}

/**
 * POST 到 openai-compat proxy。单次调用，不重试（上层 extractFacts 管重试）。
 * 支持注入 fetchImpl（测试用），默认走全局 fetch。
 */
export async function callGeminiFlash(
  client: GeminiClientConfig,
  systemPrompt: string,
  userMsg: string,
  fetchImpl: FetchFn = fetch,
): Promise<GeminiChatResponse> {
  const body = {
    model: client.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMsg },
    ],
    max_tokens: client.maxTokens,
    temperature: client.temperature,
    response_format: { type: "json_object" },
  };
  const resp = await fetchImpl(`${client.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${client.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `Gemini Flash HTTP ${resp.status}: ${text.slice(0, 300)}`,
    );
  }
  return (await resp.json()) as GeminiChatResponse;
}

// ---------------------------------------------------------------------------
// extractFacts()
// ---------------------------------------------------------------------------

/** 响应 content 里剥 ```json fence + 解析；失败返回 undefined */
function parseFactsJson(contentStr: string): unknown | undefined {
  const cleaned = contentStr
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 从文档正文抽取原子事实。
 *
 * - 预算 check：估算 cost + accumulatedCost > budget → 抛 BudgetExceededError
 * - 重试 × 2：指数退避（500ms / 1000ms）
 * - 解析失败返回空 facts（不抛）
 * - T4 过滤 confidence < 0.85
 */
export async function extractFacts(
  input: ExtractInput,
  options: ExtractorOptions,
  accumulatedCostUsd = 0,
  fetchImpl: FetchFn = fetch,
): Promise<ExtractionResult> {
  // 预算 check（上限估算：假设 input tokens = 字节/2 + prompt，output ≤ max_tokens）
  const estInTokens = Math.ceil(input.content.length / 2) + 300;
  const estOutTokens = options.client.maxTokens;
  const estCost = estimateCostUsd(estInTokens, estOutTokens);
  if (accumulatedCostUsd + estCost > options.budgetUsd) {
    throw new BudgetExceededError(
      accumulatedCostUsd + estCost,
      options.budgetUsd,
    );
  }

  const userMsg = `文档标题：${input.docTitle}\n\n文档正文（${input.content.length} 字节）：\n${input.content}`;

  const startTs = Date.now();
  let resp: GeminiChatResponse | undefined;
  let lastErr: unknown;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      resp = await callGeminiFlash(
        options.client,
        SYSTEM_PROMPT,
        userMsg,
        fetchImpl,
      );
      break;
    } catch (err) {
      lastErr = err;
      if (attempt < 2) {
        await sleep(500 * Math.pow(2, attempt));
      }
    }
  }
  if (!resp) {
    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    throw new Error(`extractFacts failed after 3 attempts: ${msg}`);
  }

  const latencyMs = Date.now() - startTs;
  const tokenIn = resp.usage?.prompt_tokens ?? 0;
  const tokenOut = resp.usage?.completion_tokens ?? 0;
  const costUsd = estimateCostUsd(tokenIn, tokenOut);

  const contentStr = resp.choices?.[0]?.message?.content ?? "";
  const parsed = parseFactsJson(contentStr);

  const baseResult: Omit<ExtractionResult, "facts"> = {
    docToken: input.docToken,
    docTitle: input.docTitle,
    contentHash: input.contentHash,
    model: options.client.model,
    latencyMs,
    tokenIn,
    tokenOut,
    costUsd,
  };

  if (!parsed) {
    return { ...baseResult, facts: [] };
  }

  const rawFacts = Array.isArray((parsed as { facts?: unknown }).facts)
    ? (parsed as { facts: unknown[] }).facts
    : [];

  const facts: ExtractedFact[] = [];
  for (const raw of rawFacts) {
    if (!validateFact(raw)) continue;
    if (raw.confidence < CONFIDENCE_THRESHOLD) continue; // T4 tweak
    facts.push(raw);
  }

  return { ...baseResult, facts };
}
