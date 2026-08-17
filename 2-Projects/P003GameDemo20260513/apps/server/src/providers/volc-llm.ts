import type { ChatHistoryTurn } from './gemini-llm.js';
import type { DeepseekLlmClient } from './deepseek-llm.js';

/**
 * 火山方舟 Coding 网关 LLM（doubao-seed-2.0-lite，2026-08-17 P1 接入）：
 * OpenAI 兼容 /chat/completions SSE，形态与 DeepSeek 官方一致，接口复用 DeepseekLlmClient。
 * ⚠️ doubao-seed 系列默认开 thinking（首块全是 reasoning_content，speakable 首声被拖长：
 * 64.90 实测开思考首块 2112ms / 关闭后 418-540ms）——必须显式 thinking:disabled。
 * 用途：与 DeepSeek 组成大脑内双路赛马（race-llm.ts），首个可见 token 胜。
 */

const DEFAULT_SYSTEM_PROMPT =
  '你是儿童陪伴机器人小可（K1）。用户是 5-12 岁孩子，叫他"指挥官"。语气温暖、活泼、有耐心。' +
  '日常聊天保持简短自然（30-50 字）；讲故事/科普可以讲完整（200-500 字，分段叙述）。';

const DEFAULT_TEMPERATURE = 1.0;
function getTemperature(): number {
  const raw = process.env.LLM_TEMPERATURE;
  if (raw === undefined || raw.trim() === '') return DEFAULT_TEMPERATURE;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_TEMPERATURE;
}

class VolcLlmClientImpl implements DeepseekLlmClient {
  private activeAbort: AbortController | null = null;

  async streamChat(opts: {
    systemPrompt: string;
    userText: string;
    history?: ChatHistoryTurn[];
    onDelta: (delta: string) => void;
    onDone: (fullText: string) => void;
    onError: (err: Error) => void;
  }): Promise<void> {
    const baseUrl =
      process.env.VOLC_LLM_BASE_URL || 'https://ark.cn-beijing.volces.com/api/coding/v3';
    const apiKey = process.env.VOLC_LLM_API_KEY;
    const model = process.env.VOLC_LLM_MODEL ?? 'doubao-seed-2.0-lite';

    if (!apiKey) {
      throw new Error('VOLC_LLM_API_KEY 未配置');
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
            ...(opts.history ?? []),
            { role: 'user', content: opts.userText },
          ],
          stream: true,
          temperature: getTemperature(),
          thinking: { type: 'disabled' },
          max_tokens: 8192,
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`火山 LLM 请求失败 status=${res.status} ${errText.slice(0, 200)}`);
      }

      if (!res.body) {
        throw new Error('火山 LLM 流响应体为空');
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
            if (!delta) continue; // reasoning_content 等非 content 字段一律不入正文
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

export function createVolcLlmClient(): DeepseekLlmClient {
  return new VolcLlmClientImpl();
}
