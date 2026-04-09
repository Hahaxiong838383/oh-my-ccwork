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

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        stream: false,
        temperature: opts.temperature ?? 0.7,
        ...(opts.max_tokens != null && { max_tokens: opts.max_tokens }),
        ...(opts.enable_thinking != null && { enable_thinking: opts.enable_thinking }),
      }),
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
  // Gemma 4 thinking 模式：正文在 content，思考在 reasoning
  // 当 content 为空但有 reasoning 时，用 reasoning（模型还在"想"没输出正文）
  const content = msg?.content || "";
  const reasoning = msg?.reasoning || "";
  return {
    content: content || reasoning,
    usage: data.usage,
  };
}
