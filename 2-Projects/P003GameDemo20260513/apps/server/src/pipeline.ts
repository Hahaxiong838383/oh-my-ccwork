import type WebSocket from 'ws';
import { createGeminiLlmClient, type GeminiLlmClient } from './providers/gemini-llm.js';
import { createVolcAsrClient, type VolcAsrClient } from './providers/volc-asr.js';
import { createVolcTtsClient, type VolcTtsClient } from './providers/volc-tts.js';

export type ClientMessage =
  | { type: 'session.start'; sampleRate: number }
  | { type: 'audio.chunk'; pcm16: ArrayBuffer }
  | { type: 'audio.end' }
  | { type: 'barge.in' };

export type ServerMessage =
  | { type: 'asr.partial'; text: string }
  | { type: 'asr.final'; text: string }
  | { type: 'llm.delta'; text: string }
  | { type: 'llm.done'; text: string }
  | { type: 'tts.audio'; mp3Base64: string }
  | { type: 'tts.end' }
  | { type: 'error'; code: string; message: string };

const DEFAULT_SYSTEM_PROMPT =
  '你是儿童陪伴机器人小可（K1）。用户是 5-12 岁孩子，叫他"指挥官"。简短、温暖、活泼。每次回复 ≤30 字。';

export class VoicePipeline {
  private readonly ws: WebSocket;
  private asr: VolcAsrClient | null = null;
  private tts: VolcTtsClient | null = null;
  private readonly llm: GeminiLlmClient & { abort?: () => void };
  private activeTurn = 0;

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
          this.startLlmAndTts(text);
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

    try {
      this.tts = createVolcTtsClient();
      await this.tts.start({
        onAudio: (chunk) => {
          if (turn !== this.activeTurn) return;
          this.send({ type: 'tts.audio', mp3Base64: chunk.toString('base64') });
        },
        onSentenceEnd: () => {
          if (turn !== this.activeTurn) return;
          this.send({ type: 'tts.end' });
        },
        onError: (err) => {
          this.sendError('TTS_ERROR', err.message);
        },
      });
    } catch (err) {
      this.sendError('TTS_START_FAILED', toError(err).message);
      this.tts = null;
      return;
    }

    await this.llm.streamChat({
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      userText: finalText,
      onDelta: (delta) => {
        if (turn !== this.activeTurn) return;
        this.send({ type: 'llm.delta', text: delta });
        this.tts?.feed(delta);
      },
      onDone: (fullText) => {
        if (turn !== this.activeTurn) return;
        this.send({ type: 'llm.done', text: fullText });
        this.tts?.finish();
      },
      onError: (err) => {
        this.sendError('LLM_ERROR', err.message);
      },
    });
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
