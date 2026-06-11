import type WebSocket from 'ws';
import { createGeminiLlmClient, type GeminiLlmClient } from './providers/gemini-llm.js';
import { createVolcAsrClient, type VolcAsrClient } from './providers/volc-asr.js';
import { createVolcTtsClient, type VolcTtsClient } from './providers/volc-tts.js';
import { createExpressionFilter, stripExpressionTag } from './expression-filter.js';

export type ClientMessage =
  | { type: 'session.start'; sampleRate: number }
  | { type: 'audio.chunk'; pcm16: ArrayBuffer }
  | { type: 'audio.end' }
  | { type: 'barge.in' }
  | { type: 'tts.say'; text: string }
  | { type: 'session.config'; systemPrompt: string }
  // 文本直入 LLM 管线（绕过 ASR）：工作台开场触发指令用，走完整 LLM→TTS 流
  | { type: 'chat.trigger'; text: string };

export type ServerMessage =
  | { type: 'asr.partial'; text: string }
  | { type: 'asr.final'; text: string }
  | { type: 'llm.delta'; text: string }
  | { type: 'llm.done'; text: string }
  | { type: 'tts.audio'; mp3Base64: string }
  | { type: 'tts.sentence_break' }
  | { type: 'tts.end' }
  | { type: 'session.config.ack'; chars: number }
  | { type: 'debug.prompt_assembled'; systemPrompt: string; userText: string }
  // LLM 在回复开头用【表情：xxx】选的表情（server 解析剥离后单发，驱动前端小可形象）
  | { type: 'avatar.expression'; name: string }
  | { type: 'error'; code: string; message: string };

const DEFAULT_SYSTEM_PROMPT =
  '你是儿童陪伴机器人小可（K1）。用户是 5-12 岁孩子，叫他"指挥官"。语气温暖、活泼、有耐心。' +
  '日常聊天保持简短自然（30-50 字）；如果指挥官请你讲故事、科普知识、详细解释，可以讲完整（200-500 字，分段叙述）。' +
  '不要刻意凑字数，自然就好。';

export class VoicePipeline {
  private readonly ws: WebSocket;
  private asr: VolcAsrClient | null = null;
  private tts: VolcTtsClient | null = null;
  private readonly llm: GeminiLlmClient & { abort?: () => void };
  private activeTurn = 0;
  // KidsHub-AI 工作台下发的完整 system prompt（组装在前端做，server 只存只用）
  private sessionSystemPrompt: string | null = null;

  constructor(ws: WebSocket) {
    this.ws = ws;
    this.llm = createGeminiLlmClient() as GeminiLlmClient & { abort?: () => void };
  }

  handleClientMessage(msg: ClientMessage): void {
    switch (msg.type) {
      case 'session.start':
        this.startAsr(msg.sampleRate);
        return;
      case 'audio.chunk':
        if (!this.asr) {
          this.sendError('ASR_NOT_READY', 'ASR 未启动');
          return;
        }
        this.asr.feed(Buffer.from(msg.pcm16));
        return;
      case 'audio.end':
        this.asr?.finishAudio();
        return;
      case 'barge.in':
        this.bargein();
        return;
      case 'tts.say':
        console.log('[pipeline] tts.say received:', msg.text.slice(0, 30));
        this.speakDirect(msg.text);
        return;
      case 'session.config':
        this.sessionSystemPrompt = msg.systemPrompt;
        this.send({ type: 'session.config.ack', chars: msg.systemPrompt.length });
        return;
      case 'chat.trigger':
        console.log('[pipeline] chat.trigger received:', msg.text.slice(0, 30));
        this.startLlmAndTts(msg.text);
        return;
      default:
        this.sendError('BAD_MESSAGE', '未知客户端消息');
    }
  }

  bargein(): void {
    this.activeTurn += 1;

    if (typeof this.llm.abort === 'function') {
      this.llm.abort();
    }

    if (this.tts) {
      this.tts.close();
      this.tts = null;
    }
  }

  close(): void {
    this.bargein();
    this.asr?.close();
    this.asr = null;
  }

  private async startAsr(sampleRate: number): Promise<void> {
    try {
      this.asr?.close();
      this.asr = createVolcAsrClient();
      await this.asr.start({
        sampleRate,
        onPartial: (text) => {
          this.send({ type: 'asr.partial', text });
        },
        onFinal: (text) => {
          this.send({ type: 'asr.final', text });
          if (text.trim()) {
            this.startLlmAndTts(text);
          } else {
            // 用户没说话 → 立刻发 tts.end，让 client 重置 voiceStatus 到 idle
            this.send({ type: 'tts.end' });
          }
        },
        onError: (err) => {
          this.sendError('ASR_ERROR', err.message);
        },
      });
    } catch (err) {
      this.sendError('ASR_START_FAILED', toError(err).message);
    }
  }

  private async startLlmAndTts(userText: string): Promise<void> {
    const finalText = userText.trim();
    if (!finalText) return;

    this.bargein();
    const turn = this.activeTurn;
    let endSent = false;

    // 整个流程任何环节失败都必须发 tts.end，前端不能卡 thinking
    const ensureEnd = () => {
      if (endSent || turn !== this.activeTurn) return;
      endSent = true;
      this.send({ type: 'tts.end' });
    };

    try {
      // 错误后断开 TTS 输入流并防止 onAudio 继续吐音频包（codex P1 finding）
      const closeTtsAfterError = () => {
        if (this.tts) {
          this.tts.close();
          this.tts = null;
        }
      };

      try {
        this.tts = createVolcTtsClient();
        await this.tts.start({
          onAudio: (chunk) => {
            if (turn !== this.activeTurn || endSent) return;
            this.send({ type: 'tts.audio', mp3Base64: chunk.toString('base64') });
          },
          onSentenceBreak: () => {
            // 句末标点信号 → 让客户端 flush 当前段播放，实现字幕与 TTS 同步
            if (turn !== this.activeTurn || endSent) return;
            this.send({ type: 'tts.sentence_break' });
          },
          onSentenceEnd: () => {
            if (turn !== this.activeTurn) return;
            if (endSent) return;
            endSent = true;
            this.send({ type: 'tts.end' });
          },
          onError: (err) => {
            this.sendError('TTS_ERROR', err.message);
            ensureEnd();
            closeTtsAfterError();
          },
        });
      } catch (err) {
        this.sendError('TTS_START_FAILED', toError(err).message);
        this.tts = null;
        ensureEnd();
        return;
      }

      const systemPrompt = this.sessionSystemPrompt ?? DEFAULT_SYSTEM_PROMPT;
      // 工作台调试流依赖：回发本轮真实使用的 prompt（所见即所发）
      this.send({ type: 'debug.prompt_assembled', systemPrompt, userText: finalText });

      // 回复开头的【表情：xxx】标记：解析→发 avatar.expression，剥离后才喂 TTS/llm.delta
      const exprFilter = createExpressionFilter();
      const emitFiltered = (piece: { text: string; expression?: string }) => {
        if (piece.expression) {
          this.send({ type: 'avatar.expression', name: piece.expression });
        }
        if (piece.text) {
          this.send({ type: 'llm.delta', text: piece.text });
          this.tts?.feed(piece.text);
        }
      };

      await this.llm.streamChat({
        systemPrompt,
        userText: finalText,
        onDelta: (delta) => {
          if (turn !== this.activeTurn) return;
          emitFiltered(exprFilter.feed(delta));
        },
        onDone: (fullText) => {
          if (turn !== this.activeTurn) return;
          // 兜底：整条回复只有标记/标记未闭合时，缓冲区剩余在这里放行
          emitFiltered(exprFilter.flush());
          this.send({ type: 'llm.done', text: stripExpressionTag(fullText).text });
          this.tts?.finish();
        },
        onError: (err) => {
          this.sendError('LLM_ERROR', err.message);
          ensureEnd();
          closeTtsAfterError();
        },
      });
    } catch (err) {
      // streamChat 同步 throw（如 env 缺失）走这里，避免 unhandled rejection
      this.sendError('LLM_FATAL', toError(err).message);
      ensureEnd();
      if (this.tts) {
        this.tts.close();
        this.tts = null;
      }
    }
  }

  private async speakDirect(text: string): Promise<void> {
    const finalText = text.trim();
    if (!finalText) {
      this.send({ type: 'tts.end' });
      return;
    }

    // 先中断正在进行的会话，避免语音叠加
    this.bargein();
    const turn = this.activeTurn;
    let endSent = false;

    const ensureEnd = () => {
      if (endSent || turn !== this.activeTurn) return;
      endSent = true;
      this.send({ type: 'tts.end' });
    };

    const closeTtsAfterError = () => {
      if (this.tts) {
        this.tts.close();
        this.tts = null;
      }
    };

    try {
      if (!this.tts) {
        this.tts = createVolcTtsClient();
      }
      await this.tts.start({
        onAudio: (chunk) => {
          if (turn !== this.activeTurn || endSent) return;
          this.send({ type: 'tts.audio', mp3Base64: chunk.toString('base64') });
        },
        onSentenceBreak: () => {
          if (turn !== this.activeTurn || endSent) return;
          this.send({ type: 'tts.sentence_break' });
        },
        onSentenceEnd: () => {
          if (turn !== this.activeTurn || endSent) return;
          endSent = true;
          this.send({ type: 'tts.end' });
        },
        onError: (err) => {
          this.sendError('TTS_ERROR', err.message);
          ensureEnd();
          closeTtsAfterError();
        },
      });
    } catch (err) {
      this.sendError('TTS_START_FAILED', toError(err).message);
      this.tts = null;
      ensureEnd();
      return;
    }

    this.tts.feed(finalText);
    this.tts.finish();
  }

  private send(msg: ServerMessage): void {
    if (this.ws.readyState !== 1) return;
    this.ws.send(JSON.stringify(msg));
  }

  private sendError(code: string, message: string): void {
    this.send({ type: 'error', code, message });
  }
}

function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(String(err));
}
