import type { ChatHistoryTurn } from './gemini-llm.js';
import type { DeepseekLlmClient } from './deepseek-llm.js';
import { createDeepseekLlmClient } from './deepseek-llm.js';
import { createVolcLlmClient } from './volc-llm.js';

/**
 * 大脑内双路 LLM 赛马（2026-08-17 P1，_run_race 家族第三个实现：Python FastLLM →
 * rust stream_chat_race → 本 node 版）：DeepSeek 主 + 火山 doubao 并发，
 * **首个可见 delta 的路 claim 胜**，败者立即 abort；胜者之后的回调原样透传；
 * 双路全败才对外 onError。价值 = 取 min 削尾（DeepSeek 晚高峰 1.3-40s 抖动 /
 * doubao 偶发 1.7s 长尾，两路同时抖概率极低），且人设/记忆/过滤天然覆盖两路
 * ——设备线不再出现底模自称（「字节跳动的人工智能」2026-08-17 真机实证）。
 * won_by=fallback 不是故障信号：健康时 doubao 更快也会赢。
 */
type ClientFactory = () => DeepseekLlmClient;

class RaceLlmClientImpl implements DeepseekLlmClient {
  private main: DeepseekLlmClient | null = null;
  private fb: DeepseekLlmClient | null = null;

  constructor(
    private readonly mainFactory: ClientFactory,
    private readonly fbFactory: ClientFactory,
  ) {}

  async streamChat(opts: {
    systemPrompt: string;
    userText: string;
    history?: ChatHistoryTurn[];
    onDelta: (delta: string) => void;
    onDone: (fullText: string) => void;
    onError: (err: Error) => void;
  }): Promise<void> {
    this.abort();
    const main = this.mainFactory();
    const fb = this.fbFactory();
    this.main = main;
    this.fb = fb;

    let winner: 'main' | 'fallback' | null = null;
    let failures = 0;
    let lastErr: Error | null = null;
    let settledOut = false; // 已对外 onDone/onError 过（防双发）
    const t0 = Date.now();

    const wrap = (tag: 'main' | 'fallback', loser: DeepseekLlmClient) => ({
      onDelta: (delta: string): void => {
        if (winner === null) {
          winner = tag;
          console.log(`[race] won_by=${tag} ttft_ms=${Date.now() - t0}`);
          loser.abort();
        }
        if (winner === tag) opts.onDelta(delta);
      },
      onDone: (fullText: string): void => {
        if (winner === tag && !settledOut) {
          settledOut = true;
          opts.onDone(fullText);
        }
        // 无 winner 的 onDone（空回复流）不透传：等另一路；双终结兜底在 allSettled 后
      },
      onError: (err: Error): void => {
        failures += 1;
        lastErr = err;
        if (winner === tag && !settledOut) {
          settledOut = true; // 胜者中途死：如实上报（外层有人设兜底文案）
          opts.onError(err);
          return;
        }
        if (winner === null && failures >= 2 && !settledOut) {
          settledOut = true;
          console.log(`[race] 双路全败: ${err.message}`);
          opts.onError(err);
        }
        // 未定胜负的单路失败：静默，让另一路继续跑
      },
    });

    const run = (
      client: DeepseekLlmClient,
      tag: 'main' | 'fallback',
      loser: DeepseekLlmClient,
    ): Promise<void> => {
      const w = wrap(tag, loser);
      return client
        .streamChat({ ...opts, onDelta: w.onDelta, onDone: w.onDone, onError: w.onError })
        .catch((e: unknown) => {
          // streamChat 本体 throw（如 key 未配）与 onError 同等对待
          w.onError(e instanceof Error ? e : new Error(String(e)));
        });
    };

    await Promise.allSettled([run(main, 'main', fb), run(fb, 'fallback', main)]);
    // 兜底：两路都终结但从未对外发过（如双路空回复流）→ 以空回复收尾，绝不让调用方悬挂
    if (!settledOut) {
      settledOut = true;
      if (winner === null && lastErr) opts.onError(lastErr);
      else opts.onDone('');
    }
    this.main = null;
    this.fb = null;
  }

  abort(): void {
    this.main?.abort();
    this.fb?.abort();
    this.main = null;
    this.fb = null;
  }
}

export function createRaceLlmClient(
  mainFactory: ClientFactory = createDeepseekLlmClient,
  fbFactory: ClientFactory = createVolcLlmClient,
): DeepseekLlmClient {
  return new RaceLlmClientImpl(mainFactory, fbFactory);
}
