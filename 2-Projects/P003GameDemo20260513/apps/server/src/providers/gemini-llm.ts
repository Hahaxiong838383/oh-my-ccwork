type GeminiUsage = { totalTokens: number; promptTokens: number; completionTokens: number };

export interface GeminiLlmClient {
  streamChat(opts: {
    systemPrompt: string;
    userText: string;
    onDelta: (delta: string) => void;
    onDone: (fullText: string, usage?: GeminiUsage) => void;
    onError: (err: Error) => void;
  }): Promise<void>;
}

const DEFAULT_SYSTEM_PROMPT =
  '你是儿童陪伴机器人小可（K1）。用户是 5-12 岁孩子，叫他"指挥官"。语气温暖、活泼、有耐心。' +
  '日常聊天保持简短自然（30-50 字）；讲故事/科普可以讲完整（200-500 字，分段叙述）。';
const DEFAULT_MODEL = 'gemini-2.5-flash-lite';

/**
 * 各模型 max_tokens 上限（实测，部分来自 reference_gemini_proxy memory）：
 * - gemini-2.5-pro: 32768（Google 上限）
 * - gemini-2.5-flash / 2.5-flash-lite / 3.x 系列: 65535（Vertex AI exclusive [1,65536)）
 * - MiniMax-M2.7-highspeed: 8192（OpenAI 兼容默认）
 * - 未知模型: 8192（保守安全值）
 */
function getMaxTokensForModel(model: string): number {
  const lower = model.toLowerCase();
  if (lower.includes('minimax')) return 8192;
  if (lower.includes('gemini-2.5-pro')) return 32768;
  if (lower.startsWith('gemini-2.5') || lower.startsWith('gemini-3')) return 65535;
  return 8192;
}

/**
 * 采样温度（可调旋钮）：默认 1.0 —— 让相同 prompt 每次话术有差异，
 * 避免"提前录制感"。需要更稳/更发散时改 .env.local 的 LLM_TEMPERATURE 即可，
 * 不必改代码。非法值回退 1.0。
 */
const DEFAULT_TEMPERATURE = 1.0;
function getTemperature(): number {
  const raw = process.env.LLM_TEMPERATURE;
  if (raw === undefined || raw.trim() === '') return DEFAULT_TEMPERATURE;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_TEMPERATURE;
}

class GeminiLlmClientImpl implements GeminiLlmClient {
  private activeAbort: AbortController | null = null;

  async streamChat(opts: {
    systemPrompt: string;
    userText: string;
    onDelta: (delta: string) => void;
    onDone: (fullText: string, usage?: GeminiUsage) => void;
    onError: (err: Error) => void;
  }): Promise<void> {
    const proxyUrl = process.env.GEMINI_PROXY_URL;
    const apiKey = process.env.GEMINI_API_KEY;
    const model = process.env.GEMINI_DEFAULT_MODEL ?? DEFAULT_MODEL;

    if (!proxyUrl || !apiKey) {
      throw new Error('GEMINI_PROXY_URL / GEMINI_API_KEY 未配置');
    }

    this.abort();
    this.activeAbort = new AbortController();

    const controller = this.activeAbort;
    const systemPrompt = opts.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT;

    try {
      const res = await fetch(`${proxyUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          stream: true,
          stream_options: { include_usage: true },
          temperature: getTemperature(),
          // 按模型动态取上限：2.5-pro 32768 / 2.5+3.x 系列 65535 / MiniMax 8192
          max_tokens: getMaxTokensForModel(model),
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: opts.userText },
          ],
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Gemini 请求失败 status=${res.status} ${errText.slice(0, 240)}`);
      }

      if (!res.body) {
        throw new Error('Gemini 流响应体为空');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';
      let lastUsage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith('data:')) continue;

          const chunk = line.slice(5).trim();
          if (!chunk || chunk === '[DONE]') continue;

          try {
            const evt = JSON.parse(chunk) as {
              choices?: Array<{ delta?: { content?: string } }>;
              usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
            };
            if (evt.usage) lastUsage = evt.usage;
            const delta = evt.choices?.[0]?.delta?.content;
            if (!delta) continue;
            fullText += delta;
            opts.onDelta(delta);
          } catch {
            // ignore parse noise chunk
          }
        }
      }

      opts.onDone(
        fullText.trim(),
        lastUsage
          ? {
              totalTokens: lastUsage.total_tokens ?? 0,
              promptTokens: lastUsage.prompt_tokens ?? 0,
              completionTokens: lastUsage.completion_tokens ?? 0,
            }
          : undefined,
      );
    } catch (err) {
      if (controller.signal.aborted) return;
      opts.onError(toError(err));
    } finally {
      if (this.activeAbort === controller) {
        this.activeAbort = null;
      }
    }
  }

  abort(): void {
    if (!this.activeAbort) return;
    this.activeAbort.abort();
    this.activeAbort = null;
  }
}

function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(String(err));
}

export function createGeminiLlmClient(): GeminiLlmClient {
  return new GeminiLlmClientImpl();
}
