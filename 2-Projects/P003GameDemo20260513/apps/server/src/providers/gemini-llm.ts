export interface GeminiLlmClient {
  streamChat(opts: {
    systemPrompt: string;
    userText: string;
    onDelta: (delta: string) => void;
    onDone: (fullText: string) => void;
    onError: (err: Error) => void;
  }): Promise<void>;
}

const DEFAULT_SYSTEM_PROMPT = '你是儿童陪伴机器人小可（K1）。用户是 5-12 岁孩子，叫他"指挥官"。简短、温暖、活泼。每次回复 ≤30 字。';
const DEFAULT_MODEL = 'gemini-2.5-flash-lite';

class GeminiLlmClientImpl implements GeminiLlmClient {
  private activeAbort: AbortController | null = null;

  async streamChat(opts: {
    systemPrompt: string;
    userText: string;
    onDelta: (delta: string) => void;
    onDone: (fullText: string) => void;
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
          temperature: 0.6,
          max_tokens: 120,
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

export function createGeminiLlmClient(): GeminiLlmClient {
  return new GeminiLlmClientImpl();
}
