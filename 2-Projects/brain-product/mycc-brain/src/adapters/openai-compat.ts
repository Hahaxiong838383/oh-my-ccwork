/**
 * OpenAI-compatible 通用适配器
 * 支持 Qwen (DashScope) / DeepSeek / Ollama / 任何 OpenAI 格式 API
 * 直接管道转发 SSE，不做格式转换
 */

import type { IncomingMessage, ServerResponse } from "http";

export interface OpenAIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface StreamOptions {
  baseURL: string;
  apiKey: string;
  model: string;
  messages: OpenAIMessage[];
  temperature?: number;
  max_tokens?: number;
  enable_thinking?: boolean; // 默认 false，开启后模型会输出推理过程
  /**
   * 非 OpenAI 标准字段透传（谨慎使用）。
   * 仅在目标 baseURL 确定支持该字段时注入，例如方舟 Coding Plan 的
   * `thinking: { type: "disabled" }` 用于关闭 reasoning_tokens 以降低延迟。
   * 其它第三方 openai-compat endpoint 可能会 400 拒绝，切忌默认启用。
   */
  extraBody?: Record<string, unknown>;
}

export async function streamOpenAICompat(
  opts: StreamOptions,
  res: ServerResponse
): Promise<void> {
  const url = `${opts.baseURL}/chat/completions`;

  const payload: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    stream: true,
    temperature: opts.temperature ?? 0.7,
  };
  if (opts.max_tokens != null) payload.max_tokens = opts.max_tokens;
  if (opts.enable_thinking != null) payload.enable_thinking = opts.enable_thinking;
  // 厂商专属字段透传（例如方舟 Coding Plan 的 thinking: { type: "disabled" }）
  if (opts.extraBody) Object.assign(payload, opts.extraBody);

  const body = JSON.stringify(payload);

  // prompt 大小诊断日志
  const totalChars = opts.messages.reduce((n, m) => n + m.content.length, 0);
  console.log(`[openai-compat] → ${opts.baseURL.split('/v1')[0]} | model=${opts.model} | msgs=${opts.messages.length} | ~${Math.ceil(totalChars / 2)}tok (${totalChars}chars)`);

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body,
    });
  } catch (e: unknown) {
    const cause = e instanceof Error && "cause" in e ? (e as any).cause : undefined;
    const detail = cause?.message ?? cause?.code ?? (e instanceof Error ? e.message : String(e));
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: {
        message: `Network error reaching ${url.split("/v1")[0]}: ${detail}`,
        type: "network_error",
      },
    }));
    return;
  }

  if (!upstream.ok) {
    const err = await upstream.text();
    res.writeHead(upstream.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: {
        message: `Upstream error: ${err}`,
        type: "upstream_error",
        code: upstream.status,
      },
    }));
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const reader = upstream.body?.getReader();
  if (!reader) {
    res.end("data: [DONE]\n\n");
    return;
  }

  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
    }
  } catch (e) {
    // client disconnected
  } finally {
    reader.releaseLock();
    res.end();
  }
}

/** 非流式请求（用于 admin 测试等） */
export async function chatCompletion(
  opts: Omit<StreamOptions, "max_tokens"> & { max_tokens?: number }
): Promise<{ content: string; usage?: { total_tokens: number } }> {
  const url = `${opts.baseURL}/chat/completions`;

  const payload: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    stream: false,
    temperature: opts.temperature ?? 0.7,
  };
  if (opts.max_tokens != null) payload.max_tokens = opts.max_tokens;
  if (opts.enable_thinking != null) payload.enable_thinking = opts.enable_thinking;
  // 厂商专属字段透传（例如方舟 Coding Plan 的 thinking: { type: "disabled" }）
  if (opts.extraBody) Object.assign(payload, opts.extraBody);

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify(payload),
    });
  } catch (e: unknown) {
    // Node.js fetch throws TypeError with .cause for network errors
    const cause = e instanceof Error && "cause" in e ? (e as any).cause : undefined;
    const detail = cause?.message ?? cause?.code ?? (e instanceof Error ? e.message : String(e));
    throw new Error(`Network error reaching ${url.split("/v1")[0]}: ${detail}`);
  }

  if (!upstream.ok) {
    throw new Error(`Upstream ${upstream.status}: ${await upstream.text()}`);
  }

  const data = await upstream.json() as any;
  const msg = data.choices?.[0]?.message;
  // content 为空时的 fallback 优先级：
  //   1. reasoning_content —— 方舟 Coding Plan / DeepSeek R1 的 reasoning 字段
  //   2. reasoning          —— Gemma 4 / 部分 Ollama 模型的 thinking 字段
  // 正常情况下 content 有值；若两者都空，返回空串让上层判定为 0 tokens / 失败。
  const content = msg?.content || "";
  const reasoning = msg?.reasoning_content || msg?.reasoning || "";
  return {
    content: content || reasoning,
    usage: data.usage,
  };
}
