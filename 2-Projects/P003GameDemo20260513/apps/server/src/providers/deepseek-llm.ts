export interface DeepseekLlmClient {
  streamChat(opts: {
    systemPrompt: string;
    userText: string;
    onDelta: (delta: string) => void;
    onDone: (fullText: string) => void;
    onError: (err: Error) => void;
  }): Promise<void>;
}

const DEFAULT_SYSTEM_PROMPT =
  '你是儿童陪伴机器人小可（K1）。用户是 5-12 岁孩子，叫他"指挥官"。语气温暖、活泼、有耐心。' +
  '日常聊天保持简短自然（30-50 字）；讲故事/科普可以讲完整（200-500 字，分段叙述）。';

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

class DeepseekLlmClientImpl implements DeepseekLlmClient {
  private activeAbort: AbortController | null = null;

  async streamChat(opts: {
    systemPrompt: string;
    userText: string;
    onDelta: (delta: string) => void;
    onDone: (fullText: string) => void;
    onError: (err: Error) => void;
  }): Promise<void> {
    const baseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';
    const apiKey = process.env.DEEPSEEK_API_KEY;
    const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash';

    if (!apiKey) {
      throw new Error('DEEPSEEK_API_KEY 未配置');
    }

    this.abort();
    this.activeAbort = new AbortController();

    const controller = this.activeAbort;
    const systemPrompt = opts.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT;

    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: opts.userText },
          ],
          stream: true,
          temperature: getTemperature(),
          // DeepSeek 官方默认即为非思考模式（低延迟），不要添加任何 thinking/reasoning 字段
          max_tokens: 8192,
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`DeepSeek 请求失败 status=${res.status} ${errText.slice(0, 200)}`);
      }

      if (!res.body) {
        throw new Error('DeepSeek 流响应体为空');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';

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
            };
            const delta = evt.choices?.[0]?.delta?.content;
            if (!delta) continue;
            fullText += delta;
            opts.onDelta(delta);
          } catch {
            // ignore parse noise chunk
          }
        }
      }

      opts.onDone(fullText.trim());
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

export function createDeepseekLlmClient(): DeepseekLlmClient {
  return new DeepseekLlmClientImpl();
}
