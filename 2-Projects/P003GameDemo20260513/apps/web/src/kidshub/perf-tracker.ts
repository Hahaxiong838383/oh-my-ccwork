/**
 * 单轮响应耗时跟踪（调试流 perf 条目数据源）
 *
 * 计时锚点（前端视角，含网络往返）：
 *   voice 轮：松手停止录音 → asr.final → 首条 llm.delta → 首段 tts.audio
 *   trigger 轮（开场白）：发出 chat.trigger → 首条 llm.delta → 首段 tts.audio
 * 模块级单态：同一时刻只有一轮在途（barge-in 语义保证），demo 够用。
 */
export type TurnKind = 'voice' | 'trigger';

interface TurnPerf {
  kind: TurnKind;
  t0: number;
  asrFinalAt: number | null;
  llmFirstAt: number | null;
  ttsFirstAt: number | null;
  reported: boolean;
}

let current: TurnPerf | null = null;

export function perfStartTurn(kind: TurnKind): void {
  current = {
    kind,
    t0: performance.now(),
    asrFinalAt: null,
    llmFirstAt: null,
    ttsFirstAt: null,
    reported: false,
  };
}

export function perfMarkAsrFinal(): void {
  if (current && current.asrFinalAt === null) current.asrFinalAt = performance.now();
}

export function perfMarkLlmFirst(): void {
  if (current && current.llmFirstAt === null) current.llmFirstAt = performance.now();
}

/**
 * 首段 TTS 音频到达：返回本轮汇总（每轮只报一次），由调用方写入调试流。
 */
export function perfMarkTtsFirstAndReport(): string | null {
  if (!current || current.reported) return null;
  if (current.ttsFirstAt === null) current.ttsFirstAt = performance.now();
  current.reported = true;

  const ms = (a: number | null, b: number | null) =>
    a !== null && b !== null ? `${Math.round(b - a)}ms` : '—';
  const { kind, t0, asrFinalAt, llmFirstAt, ttsFirstAt } = current;

  if (kind === 'voice') {
    return `⏱ ASR ${ms(t0, asrFinalAt)} · LLM TTFT ${ms(asrFinalAt, llmFirstAt)} · TTS首包 ${ms(llmFirstAt, ttsFirstAt)} · 端到端 ${ms(t0, ttsFirstAt)}`;
  }
  return `⏱ 开场白 · LLM TTFT ${ms(t0, llmFirstAt)} · TTS首包 ${ms(llmFirstAt, ttsFirstAt)} · 端到端 ${ms(t0, ttsFirstAt)}`;
}

export function perfReset(): void {
  current = null;
}
