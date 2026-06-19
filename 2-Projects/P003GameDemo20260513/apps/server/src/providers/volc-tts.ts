import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

export interface VolcTtsClient {
  start(opts: {
    onAudio: (chunk: Buffer) => void;
    /**
     * 句开始信号（event 350 TTSSentenceStart），payload 带**该句文本**。
     * 电影字幕式句级 cue 的权威来源：350 在该句音频之前到达，后续 audio 归属此句。
     */
    onSentenceStart?: (text: string) => void;
    /** 句末标点信号（中段，event 351），客户端用来 flush 当前段播放，与字幕同步 */
    onSentenceBreak?: () => void;
    /** 整流真正结束（event 152 SessionFinished 或 ws.close） */
    onSentenceEnd: () => void;
    onError: (err: Error) => void;
  }): Promise<void>;
  feed(text: string): void;
  finish(): void;
  close(): void;
}

interface TtsStartOptions {
  onAudio: (chunk: Buffer) => void;
  onSentenceStart?: (text: string) => void;
  onSentenceBreak?: () => void;
  onSentenceEnd: () => void;
  onError: (err: Error) => void;
}

const DEFAULT_WS_URL = 'wss://openspeech.bytedance.com/api/v3/tts/bidirection';
const DEFAULT_RESOURCE = 'volc.service_type.10029';
const DEFAULT_VOICE = 'zh_female_tianmeixiaoyuan_moon_bigtts';

const EVENT_START_CONNECTION = 1;
const EVENT_START_SESSION = 100;
const EVENT_FINISH_SESSION = 102;
const EVENT_TASK_REQUEST = 200;
// 注：Doubao-TTS 2.0 event 351 是「句末标点中段」（每个逗号/句号都会发），
// 不是流结束。真正的流结束是 event 152 (SessionFinished) 或 ws.close。
// 之前误把 351 当 stream end → 第一个标点就锁死后续 audio chunk = 老板"只播指挥官"bug。
const EVENT_TTS_SENTENCE_START = 350;
const EVENT_TTS_SENTENCE_END_MID = 351;
const EVENT_SESSION_FINISHED = 152;

class VolcTtsClientImpl implements VolcTtsClient {
  private ws: WebSocket | null = null;
  private opts: TtsStartOptions | null = null;
  private sessionId = randomUUID();
  private sentenceEndSent = false;

  async start(opts: TtsStartOptions): Promise<void> {
    const apiKey = process.env.VOLC_API_KEY;
    const wsUrl = process.env.VOLC_TTS_WS_URL ?? DEFAULT_WS_URL;
    const resourceId = process.env.VOLC_TTS_RESOURCE_ID ?? DEFAULT_RESOURCE;

    if (!apiKey) {
      throw new Error('VOLC_API_KEY 未配置');
    }

    this.opts = opts;
    this.sentenceEndSent = false;
    this.sessionId = randomUUID();

    await new Promise<void>((resolve, reject) => {
      const connectId = randomUUID();
      // Doubao-TTS 2.0 API Key 鉴权：用小写 x-api-key（不是 X-Api-Access-Key，那是应用模式）
      const ws = new WebSocket(wsUrl, {
        headers: {
          'x-api-key': apiKey,
          'X-Api-Resource-Id': resourceId,
          'X-Api-Connect-Id': connectId,
        },
      });
      this.ws = ws;

      ws.once('open', () => {
        ws.send(buildTtsFrame(EVENT_START_CONNECTION, null, {}));
        ws.send(
          buildTtsFrame(EVENT_START_SESSION, this.sessionId, {
            user: { uid: 'k1-demo-user' },
            namespace: 'BidirectionalTTS',
            req_params: {
              speaker: process.env.VOLC_TTS_VOICE_TYPE ?? DEFAULT_VOICE,
              audio_params: {
                format: 'mp3',
                sample_rate: 24000,
              },
            },
          }),
        );
        resolve();
      });

      ws.on('message', (data) => {
        if (!Buffer.isBuffer(data) || data.length < 12) return;

        try {
          const parsed = parseTtsFrame(data);
          if (!parsed) return;
          if (process.env.DEBUG_TTS === '1') {
            console.log(`[tts.recv] mt=${parsed.messageType} event=${parsed.event} payload=${parsed.payload.length}B`);
            if (parsed.payload.length > 0 && parsed.messageType !== 0b1011) {
              console.log(`  payload utf8: ${parsed.payload.toString('utf8').slice(0, 200)}`);
            }
          }

          if (parsed.messageType === 0b1011 && parsed.payload.length > 0) {
            opts.onAudio(parsed.payload);
            return;
          }

          // 真正的整流结束：event 152 SessionFinished
          if (parsed.event === EVENT_SESSION_FINISHED) {
            this.emitSentenceEndOnce();
            return;
          }

          // event 350 是「句开始」（TTSSentenceStart），payload JSON 带该句 text。
          // 在该句音频之前到达 → 电影字幕式句级 cue 的权威文本来源。
          // 总是回调（即使 text 解析为空）：让 pipeline 推进 sentenceIndex，
          // 防 350 schema 变化/解析失败时后续 audio 错绑到上一句（codex P1）。
          if (parsed.event === EVENT_TTS_SENTENCE_START) {
            const json = tryParseJson(parsed.payload) as { text?: string } | null;
            const text = typeof json?.text === 'string' ? json.text : '';
            opts.onSentenceStart?.(text);
            return;
          }

          // event 351 是「句末标点中段」（每个标点都会发），不是流结束
          // 触发 onSentenceBreak 让客户端 flush 当前段播放，实现字幕与 TTS 同步
          if (parsed.event === EVENT_TTS_SENTENCE_END_MID) {
            opts.onSentenceBreak?.();
            return;
          }

          // 兜底：JSON payload 含明确的 session_finished / tts_done 才触发
          // （避免误把中段 sentence_end JSON 当流结束）
          const json = tryParseJson(parsed.payload);
          if (!json) return;
          if (containsStreamEnd(json)) {
            this.emitSentenceEndOnce();
          }
        } catch (err) {
          opts.onError(toError(err));
        }
      });

      ws.once('error', (err) => {
        reject(err);
      });

      ws.on('error', (err) => {
        opts.onError(err);
      });

      ws.on('close', (code, reason) => {
        if (code !== 1000 && code !== 1005) {
          opts.onError(new Error(`TTS 连接关闭 code=${code} reason=${reason.toString()}`));
        }
        this.emitSentenceEndOnce();
      });
    });
  }

  feed(text: string): void {
    const trimmed = text.trim();
    if (!trimmed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.ws.send(
      buildTtsFrame(EVENT_TASK_REQUEST, this.sessionId, {
        namespace: 'BidirectionalTTS',
        req_params: {
          text: trimmed,
          speaker: process.env.VOLC_TTS_VOICE_TYPE ?? DEFAULT_VOICE,
          audio_params: {
            format: 'mp3',
            sample_rate: 24000,
          },
        },
      }),
    );
  }

  finish(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.emitSentenceEndOnce();
      return;
    }
    this.ws.send(buildTtsFrame(EVENT_FINISH_SESSION, this.sessionId, {}));
  }

  close(): void {
    if (!this.ws) return;
    try {
      this.ws.close();
    } catch {
      // ignore
    }
    this.ws = null;
  }

  private emitSentenceEndOnce(): void {
    if (this.sentenceEndSent) return;
    this.sentenceEndSent = true;
    this.opts?.onSentenceEnd();
  }
}

function buildTtsFrame(eventId: number, sessionId: string | null, payload: unknown): Buffer {
  const payloadBuf = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.from([
    (1 << 4) | 1,
    (0b0001 << 4) | 0b0100,
    (0b0001 << 4) | 0,
    0,
  ]);

  const eventBuf = Buffer.alloc(4);
  eventBuf.writeInt32BE(eventId);

  const parts: Buffer[] = [header, eventBuf];

  if (sessionId !== null) {
    const sessionBuf = Buffer.from(sessionId, 'utf8');
    const sessionSize = Buffer.alloc(4);
    sessionSize.writeUInt32BE(sessionBuf.length);
    parts.push(sessionSize, sessionBuf);
  }

  const payloadSize = Buffer.alloc(4);
  payloadSize.writeUInt32BE(payloadBuf.length);
  parts.push(payloadSize, payloadBuf);

  return Buffer.concat(parts);
}

function parseTtsFrame(data: Buffer): {
  messageType: number;
  event: number;
  payload: Buffer;
} | null {
  if (data.length < 12) return null;

  const headerSize = (data[0] & 0x0f) * 4;
  const messageType = (data[1] >> 4) & 0x0f;
  let cursor = headerSize;

  if (cursor + 4 > data.length) return null;
  const event = data.readInt32BE(cursor);
  cursor += 4;

  if (cursor + 4 <= data.length) {
    const maybeSessionSize = data.readUInt32BE(cursor);
    if (maybeSessionSize >= 0 && maybeSessionSize < 512 && cursor + 4 + maybeSessionSize + 4 <= data.length) {
      cursor += 4 + maybeSessionSize;
    }
  }

  if (cursor + 4 > data.length) return null;
  const payloadSize = data.readUInt32BE(cursor);
  cursor += 4;

  const payloadEnd = cursor + payloadSize;
  if (payloadEnd > data.length) return null;

  return {
    messageType,
    event,
    payload: data.subarray(cursor, payloadEnd),
  };
}

/**
 * 只匹配「整流结束」类型的 JSON 标志，排除中段 sentence_end。
 * 中段 sentence_end 是 Doubao-TTS 2.0 每个标点都发的中间状态。
 */
function containsStreamEnd(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const rec = payload as Record<string, unknown>;

  // 注意：不要匹配 'sentence_end'，那是中段标点信号
  const tags = ['session_finished', 'tts_done', 'audio_end', 'all_done'];
  for (const [k, v] of Object.entries(rec)) {
    const key = k.toLowerCase();
    if (tags.includes(key)) {
      if (v === true || v === 1 || v === '1') return true;
      if (typeof v === 'string' && ['true', 'end', 'done', 'completed'].includes(v.toLowerCase())) return true;
    }
    if (typeof v === 'string' && /session_finished|tts_done|all_done/i.test(v)) {
      return true;
    }
    if (v && typeof v === 'object' && containsStreamEnd(v)) {
      return true;
    }
  }

  return false;
}

function tryParseJson(buf: Buffer): unknown {
  const text = buf.toString('utf8').trim();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(String(err));
}

export function createVolcTtsClient(): VolcTtsClient {
  return new VolcTtsClientImpl();
}
