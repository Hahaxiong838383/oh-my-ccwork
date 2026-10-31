import type { ChatHistoryTurn } from './gemini-llm.js';

/**
 * MiniMax LLM provider（OpenAI 兼容端点 https://api.minimaxi.com/v1/chat/completions）。
 *
 * ⚠️ MiniMax M 系列（含 M2.7-highspeed）是 reasoning 模型，且 reasoning **关不掉**
 * （实测 reasoning_effort:none 无效，reasoning_tokens 照旧）。思考过程以 <think>...</think>
 * 内联在 content 里——语音场景绝不能把思考念给孩子，所以本 provider 流式剥离 <think> 段，
 * 只把 </think> 之后的正文往下游（TTS）发。
 *
 * 结构对齐 deepseek-llm.ts / gemini-llm.ts（同 streamChat 签名），可被 pipeline 工厂切换。
 */
export interface MinimaxLlmClient {
  streamChat(opts: {
    systemPrompt: string;
    userText: string;
    history?: ChatHistoryTurn[];
    onDelta: (delta: string) => void;
    onDone: (fullText: string) => void;
    onError: (err: Error) => void;
  }): Promise<void>;
}

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

/**
 * 流式剥离 <think>...</think> 的状态机。处理三种情形：
 * 1) 有 reasoning（以 <think> 开头）：丢弃 think 段，只从 </think> 之后开始发正文
 * 2) 无 reasoning（不以 <think> 开头）：全部直发
 * 3) 标签被切在多个 chunk：靠 buffer 累积到能判定为止
 */
export class ThinkStripper {
  private buffer = '';
  private passthrough = false; // 已越过 </think>，后续 delta 直发
  private decided = false; // 已判定有无 think

  feed(delta: string, emit: (s: string) => void): void {
    if (this.passthrough) {
      emit(delta);
      return;
    }
    this.buffer += delta;

    if (!this.decided) {
      const head = this.buffer.replace(/^\s+/, '');
      if (head.startsWith('<think>')) {
        this.decided = true; // 进入 think，等 </think>
      } else if ('<think>'.startsWith(head)) {
        return; // head 还是 <think> 的前缀（没收全），继续累积
      } else {
        // 明确不是 <think> 开头 → 无 reasoning，全部直发
        this.decided = true;
        this.passthrough = true;
        emit(this.buffer);
        this.buffer = '';
        return;
      }
    }

    const end = this.buffer.indexOf('</think>');
    if (end >= 0) {
      const rest = this.buffer.slice(end + '</think>'.length).replace(/^\s+/, '');
      this.passthrough = true;
      this.buffer = '';
      if (rest) emit(rest);
    }
    // 否则还在 think 内，继续等 </think>
  }
}

/** 非流式剥离（给 extractor 等一次性拿完整 content 的场景用）。 */
export function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^\s+/, '').trim();
}

class MinimaxLlmClientImpl implements MinimaxLlmClient {
  private activeAbort: AbortController | null = null;

  async streamChat(opts: {
    systemPrompt: string;
    userText: string;
    history?: ChatHistoryTurn[];
    onDelta: (delta: string) => void;
    onDone: (fullText: string) => void;
    onError: (err: Error) => void;
  }): Promise<void> {
    const baseUrl = process.env.MINIMAX_BASE_URL || 'https://api.minimaxi.com/v1';
    const apiKey = process.env.MINIMAX_API_KEY;
    const model = process.env.MINIMAX_MODEL ?? 'MiniMax-M2.7-highspeed';
    const maxTokens = Number(process.env.MINIMAX_MAX_TOKENS) || 4096;

    if (!apiKey) {
      throw new Error('MINIMAX_API_KEY 未配置');
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
          max_tokens: maxTokens,
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`MiniMax 请求失败 status=${res.status} ${errText.slice(0, 200)}`);
      }
      if (!res.body) {
        throw new Error('MiniMax 流响应体为空');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';
      const stripper = new ThinkStripper();
      const emit = (s: string) => {
        fullText += s;
        opts.onDelta(s);
      };

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
            stripper.feed(delta, emit); // 剥离 <think> 后才 onDelta
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

export function createMinimaxLlmClient(): MinimaxLlmClient {
  return new MinimaxLlmClientImpl();
}
