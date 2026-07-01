import { stripThink } from './providers/minimax-llm.js';

/**
 * 非流式 LLM 调用，给 memory / onboarding 抽取用。按 LLM_PROVIDER 选端点（与主对话同源）：
 * - minimax  → api.minimaxi.com（reasoning 模型，content 内联 <think>，用 stripThink 剥离）
 * - deepseek → api.deepseek.com（V4 关 thinking）
 * - 其它/默认 → GEMINI_PROXY_URL 代理
 * 任何失败返回 null（抽取是旁路，绝不阻断语音主链路）。
 */
export async function callExtractionLlm(
  system: string,
  user: string,
  opts: { maxTokens?: number; timeoutMs?: number } = {},
): Promise<string | null> {
  const provider = (process.env.LLM_PROVIDER || '').toLowerCase();
  const body: Record<string, unknown> = {
    stream: false,
    temperature: 0,
    max_tokens: opts.maxTokens ?? 512,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };

  let baseUrl: string | undefined;
  let apiKey: string | undefined;
  if (provider === 'minimax') {
    baseUrl = process.env.MINIMAX_BASE_URL || 'https://api.minimaxi.com/v1';
    apiKey = process.env.MINIMAX_API_KEY;
    body.model = process.env.MINIMAX_MODEL ?? 'MiniMax-M2.7-highspeed';
  } else if (provider === 'deepseek') {
    baseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';
    apiKey = process.env.DEEPSEEK_API_KEY;
    body.model = process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash';
    body.thinking = { type: 'disabled' };
  } else {
    baseUrl = process.env.GEMINI_PROXY_URL;
    apiKey = process.env.GEMINI_API_KEY;
    body.model = process.env.GEMINI_DEFAULT_MODEL ?? 'gemini-2.5-flash-lite';
  }
  if (!baseUrl || !apiKey) return null;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8000);
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      signal: ctrl.signal,
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    return content == null ? null : stripThink(content); // reasoning 模型剥离 <think>；无 think 时 no-op
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
