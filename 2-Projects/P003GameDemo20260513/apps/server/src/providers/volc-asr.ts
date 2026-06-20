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
  private isOpen = false;
  private pendingChunks: Buffer[] = [];
  private pendingFinish = false;

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
            // ── 火山大模型 ASR server VAD（docs/25 块5，让火山在连续流里主动按句尾吐 definite=true）──
            // ⚠️ 全部【待真机 DEBUG_ASR 实测】：火山 sauc/bigmodel 的 VAD 参数名/默认值在官方 JS 文档
            // 渲染不出，下面是市场调研给的候选名。现状 start 握手是工作的（只发 model_name/enable_punc/
            // enable_itn），新增字段是增量——火山对未知 request 字段通常忽略而非拒连，所以「加错名」最坏是
            // 不生效（继续走前端 audio.end EOF 兜底），不会断 ASR。每个字段都给 env 覆盖，真机看 DEBUG 日志
            // 确认火山真实接收的字段名后，按需删/改/调阈值，不必改代码重部署。
            // vad_segment_duration：语义切句的最大静音（ms）。默认 ~3000ms 对儿童太长（停顿久 → 一直不判停）；
            // 调到 ~1000-1200ms 让火山更早判「这句说完了」。儿童吐字慢、句间停顿长，别低于 1000ms（否则半句被切）。
            ...envIntField('vad_segment_duration', 'VOLC_ASR_VAD_SEGMENT_MS', 1200),
            // end_window_size：句尾静音判定窗（ms，另一候选名）。与 vad_segment_duration 二选一生效，两个都发
            // 让火山取它认识的那个。儿童设 ~800-1000ms。
            ...envIntField('end_window_size', 'VOLC_ASR_END_WINDOW_MS', 1000),
            // force_to_speech_time：开头强制判为语音的最小时长（ms），避免气口/呼吸被当语音误触发判停。
            ...envIntField('force_to_speech_time', 'VOLC_ASR_FORCE_SPEECH_MS', 0),
            // enable_ddc：语义顺滑（去口癖/重复）。可能影响 definite 时机，默认不开，留 env 开关实测对比。
            ...(process.env.VOLC_ASR_ENABLE_DDC === '1' ? { enable_ddc: true } : {}),
          },
        };
        if (process.env.DEBUG_ASR === '1') {
          console.log('[asr.start] request=', JSON.stringify(startPayload.request));
        }
        ws.send(buildJsonFrame(0b0001, 0b0000, startPayload));
        this.isOpen = true;
        // flush 任何在 open 前缓存的 audio chunks
        for (const chunk of this.pendingChunks) {
          ws.send(buildAudioFrame(chunk, 0b0000));
        }
        this.pendingChunks = [];
        if (this.pendingFinish) {
          this.pendingFinish = false;
          ws.send(buildAudioFrame(Buffer.alloc(0), 0b0010));
          ws.send(buildJsonFrame(0b0001, 0b0000, { request: { audio_end: true } }));
        }
        resolve();
      });

      ws.on('message', (data, isBinary) => {
        if (!isBinary || !Buffer.isBuffer(data)) return;
        try {
          const flags = data[1] & 0x0f;
          const isLast = (flags & 0b0010) !== 0;
          if (process.env.DEBUG_ASR === '1') {
            console.log(`[asr.raw] mt=${(data[1] >> 4) & 0xf} flags=${flags} isLast=${isLast} len=${data.length}`);
          }
          const parsed = parseAsrFrame(data);
          if (process.env.DEBUG_ASR === '1') {
            console.log('[asr.parsed]', JSON.stringify(parsed)?.slice(0, 200));
          }
          if (!parsed) return;
          this.handleServerPayload(parsed, isLast);
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
    if (pcm16.length === 0) return;
    if (!this.ws) return;
    // ws 还在 connecting：缓存到 open 后 flush
    if (!this.isOpen || this.ws.readyState !== WebSocket.OPEN) {
      this.pendingChunks.push(pcm16);
      return;
    }
    this.ws.send(buildAudioFrame(pcm16, 0b0000));
  }

  finishAudio(): void {
    if (!this.ws) return;
    if (!this.isOpen || this.ws.readyState !== WebSocket.OPEN) {
      this.pendingFinish = true;
      return;
    }
    this.ws.send(buildAudioFrame(Buffer.alloc(0), 0b0010));
    this.ws.send(buildJsonFrame(0b0001, 0b0000, { request: { audio_end: true } }));
  }

  close(): void {
    this.isOpen = false;
    this.pendingChunks = [];
    this.pendingFinish = false;
    if (!this.ws) return;
    try {
      this.ws.close();
    } catch {
      // ignore
    }
    this.ws = null;
  }

  private handleServerPayload(payload: unknown, framedAsLast = false): void {
    if (!this.opts) return;

    const text = extractText(payload);

    // ── 火山 server VAD 实测日志（docs/25 块5）──
    // 川哥真机说话时，server 控制台靠这行判断「火山到底有没有主动吐句尾事件 + 延迟多少」：
    //   definite=true / sentence_end=true 且 framedAsLast=false → 火山 server VAD 在「连续流」里主动判停（方案生效，VAD 参数对了）。
    //   全程只有 framedAsLast=true 才 final → 火山没主动判停，仍由前端 audio.end EOF 驱动（VAD 参数没生效，按字段名继续调）。
    // detectEndpointSignals 把判停相关字段从嵌套 payload 里挖出来平铺打印（绕过 [asr.parsed] 200 字截断会漏掉深层 definite 的坑）。
    if (process.env.DEBUG_ASR === '1') {
      const sig = detectEndpointSignals(payload);
      console.log(
        `[asr.vad] t=${Date.now()} framedAsLast=${framedAsLast} ` +
          `definite=${sig.definite} is_final=${sig.is_final} sentence_end=${sig.sentence_end} ` +
          `utterances=${sig.utterances} textLen=${text.length} → ${
            framedAsLast || isFinalPayload(payload) ? 'FINAL' : 'partial'
          }${sig.definite && !framedAsLast ? ' [火山主动判停✓]' : ''}`,
      );
    }

    // 帧标志为 isLast 或 payload 含 final 字段 → final（即使 text 为空，也通知 pipeline 结束这一轮）
    if (framedAsLast || isFinalPayload(payload)) {
      if (text !== this.lastFinal || text === '') {
        this.lastFinal = text;
        this.opts.onFinal(text);
      }
      return;
    }

    if (!text) return;
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
  const flags = data[1] & 0x0f;
  // 火山 ASR v3：flags & 0b0001 = MsgTypeFlagWithEvent，在 payload_size 前多 4 字节 sequence_number
  // flags & 0b0100 = MsgTypeFlagWithConnectionId（罕见），暂不处理
  let cursor = headerSize;
  if (flags & 0b0001) {
    // 跳过 4 字节 sequence_number
    if (cursor + 4 > data.length) return null;
    cursor += 4;
  }
  if (cursor + 4 > data.length) return null;
  const payloadSize = data.readUInt32BE(cursor);
  const payloadStart = cursor + 4;
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

/**
 * 火山 ASR start payload 的可选 int 字段构造器（docs/25 块5）。
 * env 给数值 → 用 env；env 未设 → 用 defaultMs；最终值 <=0 → 返回空对象（该字段不发，等于关闭）。
 * 让川哥真机不改代码、只调 env 即可开关/调阈值每个 VAD 候选参数（参数名真实性 DEBUG_ASR 实测）。
 */
function envIntField(field: string, envKey: string, defaultMs: number): Record<string, number> {
  const raw = process.env[envKey];
  let value = defaultMs;
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n)) value = Math.trunc(n);
  }
  if (value <= 0) return {};
  return { [field]: value };
}

/**
 * 从（可能嵌套的）火山 ASR payload 里挖出判停相关信号，平铺成可打印对象（DEBUG_ASR 用，docs/25 块5）。
 * 不参与判停逻辑（判停仍由 isFinalPayload 决定），纯观测——让川哥真机日志一眼看出火山吐了哪些字段。
 * 只读不改输入（工程红线：不可变）。
 */
function detectEndpointSignals(payload: unknown): {
  definite: boolean;
  is_final: boolean;
  sentence_end: boolean;
  utterances: number;
} {
  const out = { definite: false, is_final: false, sentence_end: false, utterances: 0 };
  if (!payload || typeof payload !== 'object') return out;

  const stack: unknown[] = [payload];
  const seen = new Set<unknown>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const rec = current as Record<string, unknown>;

    if (isTruthyFlag(rec.definite)) out.definite = true;
    if (isTruthyFlag(rec.is_final) || isTruthyFlag(rec.final)) out.is_final = true;
    if (isTruthyFlag(rec.sentence_end)) out.sentence_end = true;
    if (Array.isArray(rec.utterances)) out.utterances = Math.max(out.utterances, rec.utterances.length);

    for (const value of Object.values(rec)) {
      if (Array.isArray(value)) {
        for (const v of value) stack.push(v);
      } else if (value && typeof value === 'object') {
        stack.push(value);
      }
    }
  }
  return out;
}

function isTruthyFlag(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v === 1;
  if (typeof v === 'string') return ['true', '1', 'final', 'end'].includes(v.toLowerCase());
  return false;
}

function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(String(err));
}

export function createVolcAsrClient(): VolcAsrClient {
  return new VolcAsrClientImpl();
}
