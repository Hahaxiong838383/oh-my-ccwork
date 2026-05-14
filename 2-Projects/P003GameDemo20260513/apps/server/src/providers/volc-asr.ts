import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

export interface VolcAsrClient {
  start(opts: {
    sampleRate: number;
    onPartial: (text: string) => void;
    onFinal: (text: string) => void;
    onError: (err: Error) => void;
  }): Promise<void>;
  feed(pcm16: Buffer): void;
  finishAudio(): void;
  close(): void;
}

interface AsrStartOptions {
  sampleRate: number;
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (err: Error) => void;
}

const DEFAULT_WS_URL = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel';
const DEFAULT_RESOURCE_ID = 'volc.bigasr.sauc.duration';

class VolcAsrClientImpl implements VolcAsrClient {
  private ws: WebSocket | null = null;
  private opts: AsrStartOptions | null = null;
  private lastPartial = '';
  private lastFinal = '';

  async start(opts: AsrStartOptions): Promise<void> {
    const appId = process.env.VOLC_ASR_APP_ID;
    const accessToken = process.env.VOLC_ASR_ACCESS_TOKEN;
    const resourceId = process.env.VOLC_ASR_RESOURCE_ID ?? DEFAULT_RESOURCE_ID;
    const wsUrl = process.env.VOLC_ASR_WS_URL ?? DEFAULT_WS_URL;

    if (!appId || !accessToken) {
      throw new Error('VOLC_ASR_APP_ID / VOLC_ASR_ACCESS_TOKEN 未配置');
    }

    this.opts = opts;
    const connectId = randomUUID();

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl, {
        headers: {
          'X-Api-App-Key': appId,
          'X-Api-Access-Key': accessToken,
          'X-Api-Resource-Id': resourceId,
          'X-Api-Connect-Id': connectId,
        },
      });
      this.ws = ws;

      const onError = (err: Error): void => {
        opts.onError(err);
      };

      ws.once('open', () => {
        const startPayload = {
          user: { uid: 'k1-demo-user' },
          audio: {
            format: 'pcm',
            codec: 'raw',
            rate: opts.sampleRate,
            bits: 16,
            channel: 1,
          },
          request: {
            model_name: 'bigmodel',
            enable_punc: true,
            enable_itn: true,
          },
        };
        ws.send(buildJsonFrame(0b0001, 0b0000, startPayload));
        resolve();
      });

      ws.on('message', (data, isBinary) => {
        if (!isBinary || !Buffer.isBuffer(data)) return;
        try {
          const parsed = parseAsrFrame(data);
          if (!parsed) return;
          this.handleServerPayload(parsed);
        } catch (err) {
          onError(toError(err));
        }
      });

      ws.once('error', (err) => {
        reject(err);
      });

      ws.on('error', onError);
      ws.on('close', (code, reason) => {
        if (code !== 1000 && code !== 1005) {
          onError(new Error(`ASR 连接关闭 code=${code} reason=${reason.toString()}`));
        }
      });
    });
  }

  feed(pcm16: Buffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || pcm16.length === 0) return;
    this.ws.send(buildAudioFrame(pcm16, 0b0000));
  }

  finishAudio(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // 按流式协议发送最后一帧 + audio_end 通知，兼容不同服务端分支。
    this.ws.send(buildAudioFrame(Buffer.alloc(0), 0b0010));
    this.ws.send(buildJsonFrame(0b0001, 0b0000, { request: { audio_end: true } }));
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

  private handleServerPayload(payload: unknown): void {
    if (!this.opts) return;

    const text = extractText(payload);
    if (!text) return;

    if (isFinalPayload(payload)) {
      if (text !== this.lastFinal) {
        this.lastFinal = text;
        this.opts.onFinal(text);
      }
      return;
    }

    if (text !== this.lastPartial) {
      this.lastPartial = text;
      this.opts.onPartial(text);
    }
  }
}

function buildJsonFrame(messageType: number, flags: number, payload: unknown): Buffer {
  const payloadBuf = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.from([
    (1 << 4) | 1,
    (messageType << 4) | flags,
    (0b0001 << 4) | 0,
    0,
  ]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(payloadBuf.length);
  return Buffer.concat([header, size, payloadBuf]);
}

function buildAudioFrame(audioPayload: Buffer, flags: number): Buffer {
  const header = Buffer.from([
    (1 << 4) | 1,
    (0b0010 << 4) | flags,
    (0b0000 << 4) | 0,
    0,
  ]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(audioPayload.length);
  return Buffer.concat([header, size, audioPayload]);
}

function parseAsrFrame(data: Buffer): unknown {
  if (data.length < 8) return null;
  const headerSize = (data[0] & 0x0f) * 4;
  const payloadSizeOffset = headerSize;
  if (payloadSizeOffset + 4 > data.length) return null;
  const payloadSize = data.readUInt32BE(payloadSizeOffset);
  const payloadStart = payloadSizeOffset + 4;
  const payloadEnd = payloadStart + payloadSize;
  if (payloadEnd > data.length) return null;
  const payload = data.subarray(payloadStart, payloadEnd).toString('utf8').trim();
  if (!payload) return null;
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return null;
  }
}

function extractText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';

  const stack: unknown[] = [payload];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') continue;

    const rec = current as Record<string, unknown>;
    const candidateKeys = ['text', 'utterance', 'transcript', 'result'];
    for (const key of candidateKeys) {
      const value = rec[key];
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }

    for (const value of Object.values(rec)) {
      if (Array.isArray(value)) {
        for (let i = value.length - 1; i >= 0; i -= 1) {
          stack.push(value[i]);
        }
      } else if (value && typeof value === 'object') {
        stack.push(value);
      }
    }
  }

  return '';
}

function isFinalPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const rec = payload as Record<string, unknown>;

  const boolKeys = ['is_final', 'final', 'definite', 'sentence_end', 'audio_end'];
  for (const key of boolKeys) {
    const v = rec[key];
    if (typeof v === 'boolean' && v) return true;
    if (typeof v === 'number' && v === 1) return true;
    if (typeof v === 'string' && ['true', '1', 'final', 'end'].includes(v.toLowerCase())) return true;
  }

  for (const value of Object.values(rec)) {
    if (value && typeof value === 'object' && isFinalPayload(value)) {
      return true;
    }
  }

  return false;
}

function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(String(err));
}

export function createVolcAsrClient(): VolcAsrClient {
  return new VolcAsrClientImpl();
}
