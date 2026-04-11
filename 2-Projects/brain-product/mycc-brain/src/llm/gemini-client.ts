/**
 * gemini-client.ts — mycc-brain 调用 Gemini 的唯一入口
 *
 * 唯一事实来源：docs/gemini-calling-rules.md (v5.3, 2026-04-11)
 *
 * 所有 Gemini 系列调用必须经过本文件，禁止绕过：
 *   - 禁止硬编码 baseURL / api key
 *   - 禁止引用 2.0 / 1.5 系列或 gemini-3-pro-preview（已 discontinued）
 *   - 禁止引用带日期/版本号后缀的变体（`-002` / `-preview-09-2025` 等）
 *   - 禁止自行实现 429 退避 / Vertex fallback —— wrapper 已做
 *
 * 背景：brain 项目没有依赖 `openai` npm 包，使用原生 fetch + OpenAI Chat Completions
 * 协议。wrapper `http://23.226.135.149:4000/v1` 是 OpenAI 兼容入口。
 */

import { loadProjectEnv } from "../env.js";

// 确保 .env 已加载（env.ts 顶层也会自动 load，这里显式调用是防御性写法）
loadProjectEnv();

// ─── 常量 ───

/** Gemini Proxy wrapper 的 OpenAI-compatible base URL */
export const GEMINI_BASE_URL =
  process.env.GEMINI_PROXY_BASE ?? "http://23.226.135.149:4000/v1";

/** Wrapper API key（内网共享 key，来自 reference_api_keys 登记） */
export const GEMINI_API_KEY =
  process.env.GEMINI_PROXY_KEY ?? "fq8-1NLtsbVsiJhZaISmNeobvqY0bIZMoafPnKfkuz4";

/**
 * 生产可用的 6 个 Gemini 模型，其他一律禁用。
 * 见 docs/gemini-calling-rules.md §3。
 */
export const ALLOWED_GEMINI_MODELS = [
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-3.1-pro-preview",
  "gemini-3.1-flash-lite-preview",
  "gemini-3-flash-preview",
] as const;

export type GeminiModel = (typeof ALLOWED_GEMINI_MODELS)[number];

/**
 * brain 前端 thinking_mode 开关 → wrapper 的 reasoning_effort 映射。
 * 见 docs/gemini-calling-rules.md §11。
 *
 * - `off`  → `reasoning_effort: "none"`（显式关闭）
 * - `auto` → 不传（wrapper 默认最小化 thinking，秒回）
 * - `on`   → `reasoning_effort: "medium"`
 * - `deep` → `reasoning_effort: "high"`
 */
export type ThinkingMode = "off" | "auto" | "on" | "deep";

const THINKING_MODE_TO_EFFORT: Record<
  ThinkingMode,
  "none" | "low" | "medium" | "high" | null
> = {
  off: "none",
  auto: null,
  on: "medium",
  deep: "high",
};

// ─── 类型 ───

export interface GeminiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CallGeminiOptions {
  model?: GeminiModel;
  thinkingMode?: ThinkingMode;
  temperature?: number;
  maxTokens?: number;
  /** OpenAI 兼容的 response_format，例如 `{ type: "json_object" }` */
  responseFormat?: Record<string, unknown>;
  /** 额外透传字段（谨慎使用，仅 wrapper 明确支持时） */
  extra?: Record<string, unknown>;
  /** 请求超时（毫秒，默认 120s） */
  timeoutMs?: number;
}

export interface GeminiResponse {
  content: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  raw: unknown;
}

// ─── 核心校验 ───

export function isAllowedGeminiModel(model: string): model is GeminiModel {
  return (ALLOWED_GEMINI_MODELS as readonly string[]).includes(model);
}

function assertModelAllowed(model: string): asserts model is GeminiModel {
  if (!isAllowedGeminiModel(model)) {
    throw new Error(
      `[gemini-client] Model not in allow-list: "${model}". ` +
        `Allowed: ${ALLOWED_GEMINI_MODELS.join(", ")}. ` +
        `See docs/gemini-calling-rules.md §3.`,
    );
  }
}

// ─── 主调用入口 ───

/**
 * 统一调用 Gemini Proxy wrapper。
 *
 * 使用示例：
 * ```ts
 * const { content } = await callGemini(
 *   [{ role: "user", content: "你好" }],
 *   { model: "gemini-2.5-flash", thinkingMode: "off" },
 * );
 * ```
 */
export async function callGemini(
  messages: GeminiMessage[],
  options: CallGeminiOptions = {},
): Promise<GeminiResponse> {
  const {
    model = "gemini-2.5-flash",
    thinkingMode = "auto",
    temperature,
    maxTokens,
    responseFormat,
    extra,
    timeoutMs = 120_000,
  } = options;

  assertModelAllowed(model);

  const payload: Record<string, unknown> = {
    model,
    messages,
    stream: false,
  };
  if (temperature !== undefined) payload.temperature = temperature;
  if (maxTokens !== undefined) payload.max_tokens = maxTokens;
  if (responseFormat !== undefined) payload.response_format = responseFormat;

  const effort = THINKING_MODE_TO_EFFORT[thinkingMode];
  if (effort !== null) payload.reasoning_effort = effort;

  if (extra) Object.assign(payload, extra);

  const url = `${GEMINI_BASE_URL}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GEMINI_API_KEY}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (e: unknown) {
    // Node.js fetch 把真实原因放 .cause 里
    const cause =
      e instanceof Error && "cause" in e ? (e as { cause?: unknown }).cause : undefined;
    const detail =
      (cause as { message?: string; code?: string })?.message ??
      (cause as { code?: string })?.code ??
      (e instanceof Error ? e.message : String(e));
    throw new Error(`[gemini-client] Network error reaching ${GEMINI_BASE_URL}: ${detail}`);
  } finally {
    clearTimeout(timer);
  }

  if (!upstream.ok) {
    const errText = await upstream.text();
    throw new Error(
      `[gemini-client] Upstream ${upstream.status}: ${errText.slice(0, 500)}`,
    );
  }

  const data = (await upstream.json()) as {
    choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
    error?: { message?: string };
  };

  if (data.error) {
    throw new Error(`[gemini-client] API error: ${data.error.message ?? "unknown"}`);
  }

  const msg = data.choices?.[0]?.message;
  const content = msg?.content || msg?.reasoning_content || "";

  return {
    content,
    usage: data.usage,
    raw: data,
  };
}

