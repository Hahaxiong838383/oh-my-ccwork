import WebSocket from 'ws';
import crypto from 'node:crypto';

/**
 * 讯飞超拟人 TTS 合成客户端（本地人格音频线，合同 CODEX_P003_LOCAL_AUDIO_CONTRACT_v1.1 §6）。
 *
 * 协议与 scripts/xfyun-tts-probe.mjs 同源（WS + HMAC 签名 URL，status:2 一次性全量发送）；
 * 发音人恒取 XFYUN_TTS_VCN = 线上小可音色的唯一锚，产物 mp3(lame)/24000Hz/mono。
 * 失败返回 null（调用方按「该条弃」降级，绝不抛）——licc/额度类错误码原样进日志供排障。
 */

const DEFAULT_HOST = 'cbm01.cn-huabei-1.xf-yun.com';
const DEFAULT_PATH = '/v1/private/mcd9m97e6';

function buildSignedUrl(host: string, path: string, apiKey: string, apiSecret: string): string {
  const date = new Date().toUTCString();
  const sigOrigin = `host: ${host}\ndate: ${date}\nGET ${path} HTTP/1.1`;
  const signature = crypto.createHmac('sha256', apiSecret).update(sigOrigin).digest('base64');
  const authOrigin =
    `api_key="${apiKey}", algorithm="hmac-sha256", ` +
    `headers="host date request-line", signature="${signature}"`;
  const authorization = Buffer.from(authOrigin).toString('base64');
  return `wss://${host}${path}?` + new URLSearchParams({ authorization, date, host });
}

export type XfyunTtsResult = { audio: Buffer; durationMs: number };

const SAMPLE_RATE = 24000;
const BYTES_PER_SEC = SAMPLE_RATE * 2; // s16le mono

/** PCM s16le/24k/mono → 标准 44 字节 RIFF/WAVE 封装（WAV 合同增量 §2；纯函数供单测）。 */
export function pcmToWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); //        fmt chunk size
  header.writeUInt16LE(1, 20); //         audio format = 1 (PCM)
  header.writeUInt16LE(1, 22); //         channels = 1
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(BYTES_PER_SEC, 28); // byte rate
  header.writeUInt16LE(2, 32); //         block align
  header.writeUInt16LE(16, 34); //        bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export type WavInfo = { sampleRate: number; channels: number; bitsPerSample: number; dataBytes: number; durationMs: number };

/** 解析并校验 WAV 头（发布门自检：拼出来的必须能按 Android 严格口径解回去）。非法返回 null。 */
export function parseWavHeader(wav: Buffer): WavInfo | null {
  if (wav.length < 44) return null;
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') return null;
  let pos = 12;
  let fmt: { sampleRate: number; channels: number; bitsPerSample: number } | null = null;
  while (pos + 8 <= wav.length) {
    const id = wav.toString('ascii', pos, pos + 4);
    const size = wav.readUInt32LE(pos + 4);
    if (id === 'fmt ') {
      if (wav.readUInt16LE(pos + 8) !== 1) return null; // 必须 PCM
      fmt = {
        channels: wav.readUInt16LE(pos + 10),
        sampleRate: wav.readUInt32LE(pos + 12),
        bitsPerSample: wav.readUInt16LE(pos + 22),
      };
    } else if (id === 'data') {
      if (!fmt) return null;
      const dataBytes = Math.min(size, wav.length - pos - 8);
      if (dataBytes <= 0) return null;
      const bytesPerSec = (fmt.sampleRate * fmt.channels * fmt.bitsPerSample) / 8;
      return { ...fmt, dataBytes, durationMs: Math.round((dataBytes / bytesPerSec) * 1000) };
    }
    pos += 8 + size + (size % 2); // RIFF 对齐：奇数 chunk 补 1 字节
  }
  return null;
}

/**
 * WAV 直出合成（WAV 合同增量路径）：讯飞 encoding='raw' 直出 PCM s16le/24k/mono（探针+数值特征
 * 已实证）→ server 拼 RIFF 头。零转码零 ffmpeg 依赖，比 MP3 中转少一代有损；duration 由 data
 * 字节数精确导出（dataBytes/48000*1000），无解析歧义。
 */
export async function synthesizeXfyunTtsWav(text: string, timeoutMs = 15000): Promise<XfyunTtsResult | null> {
  const pcm = await synthesizeRaw(text, 'raw', timeoutMs);
  if (!pcm || pcm.length === 0) return null;
  const even = pcm.length % 2 === 0 ? pcm : pcm.subarray(0, pcm.length - 1);
  const audio = pcmToWav(even);
  const durationMs = Math.round((even.length / BYTES_PER_SEC) * 1000);
  console.log(`[local-audio] tts-wav ok bytes=${audio.length} duration=${durationMs}ms`);
  return { audio, durationMs };
}

export async function synthesizeXfyunTts(text: string, timeoutMs = 15000): Promise<XfyunTtsResult | null> {
  const audio = await synthesizeRaw(text, 'lame', timeoutMs);
  if (!audio || audio.length === 0) return null;
  const durationMs = mp3DurationMs(audio);
  console.log(`[local-audio] tts ok bytes=${audio.length} duration=${durationMs}ms`);
  return { audio, durationMs };
}

async function synthesizeRaw(text: string, encoding: 'raw' | 'lame', timeoutMs: number): Promise<Buffer | null> {
  const appId = process.env.XFYUN_APP_ID;
  const apiKey = process.env.XFYUN_API_KEY;
  const apiSecret = process.env.XFYUN_API_SECRET;
  const host = process.env.XFYUN_TTS_HOST || DEFAULT_HOST;
  const path = process.env.XFYUN_TTS_PATH || DEFAULT_PATH;
  const vcn = process.env.XFYUN_TTS_VCN;
  if (!appId || !apiKey || !apiSecret || !vcn) {
    console.log('[local-audio] tts missing-env（XFYUN_* 未配全）');
    return null;
  }

  return new Promise((resolvePromise) => {
    let settled = false;
    const chunks: Buffer[] = [];
    const startedAt = Date.now();
    const finish = (result: Buffer | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* 已关 */
      }
      resolvePromise(result);
    };
    const timer = setTimeout(() => {
      console.log(`[local-audio] tts timeout ${timeoutMs}ms textLen=${text.length}`);
      finish(null);
    }, timeoutMs);

    const ws = new WebSocket(buildSignedUrl(host, path, apiKey, apiSecret));

    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          header: { app_id: appId, status: 2 },
          parameter: {
            oral: { oral_level: 'mid' },
            tts: {
              vcn,
              speed: 50,
              volume: 50,
              pitch: 50,
              bgs: 0,
              reg: 0,
              rdn: 0,
              rhy: 0,
              audio: { encoding, sample_rate: 24000, channels: 1, bit_depth: 16, frame_size: 0 },
            },
          },
          payload: {
            text: {
              encoding: 'utf8',
              compress: 'raw',
              format: 'plain',
              status: 2,
              seq: 0,
              text: Buffer.from(text).toString('base64'),
            },
          },
        }),
      );
    });

    ws.on('message', (raw) => {
      let msg: { header?: { code?: number; message?: string; status?: number }; payload?: { audio?: { audio?: string } } };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.header?.code !== 0) {
        console.log(`[local-audio] tts server code=${msg.header?.code} msg="${msg.header?.message}"`);
        finish(null);
        return;
      }
      const b64 = msg.payload?.audio?.audio;
      if (b64) chunks.push(Buffer.from(b64, 'base64'));
      if (msg.header?.status === 2) {
        const audio = Buffer.concat(chunks);
        if (audio.length === 0) {
          finish(null);
          return;
        }
        console.log(`[local-audio] tts-${encoding} recv bytes=${audio.length} elapsed=${Date.now() - startedAt}ms`);
        finish(audio);
      }
    });

    ws.on('error', (err) => {
      console.log('[local-audio] tts ws error:', String((err as Error)?.message ?? err));
      finish(null);
    });
  });
}

// ── mp3 时长：帧头扫描累加（机上无 ffmpeg；manifest.duration_ms 承诺实测值，合同 §11.2）──

const BITRATE_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATE_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLERATE: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG1
  2: [22050, 24000, 16000], // MPEG2
  0: [11025, 12000, 8000], // MPEG2.5
};

/** 逐帧解析 mp3 时长（Layer3；跳 ID3v2；坏字节向后重同步）。返回四舍五入毫秒。 */
export function mp3DurationMs(buf: Buffer): number {
  let pos = 0;
  // ID3v2 头：'ID3' + ver(2) + flags + syncsafe size(4)
  if (buf.length >= 10 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    pos = 10 + size;
  }
  let durationSec = 0;
  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xff || (buf[pos + 1] & 0xe0) !== 0xe0) {
      pos += 1;
      continue;
    }
    const versionBits = (buf[pos + 1] >> 3) & 0x03; // 3=MPEG1 2=MPEG2 0=MPEG2.5
    const layerBits = (buf[pos + 1] >> 1) & 0x03; // 1=Layer3
    const bitrateIdx = (buf[pos + 2] >> 4) & 0x0f;
    const srIdx = (buf[pos + 2] >> 2) & 0x03;
    const padding = (buf[pos + 2] >> 1) & 0x01;
    if (versionBits === 1 || layerBits !== 1 || bitrateIdx === 0 || bitrateIdx === 15 || srIdx === 3) {
      pos += 1;
      continue;
    }
    const sampleRate = SAMPLERATE[versionBits]?.[srIdx];
    const bitrateKbps = versionBits === 3 ? BITRATE_V1_L3[bitrateIdx] : BITRATE_V2_L3[bitrateIdx];
    if (!sampleRate || !bitrateKbps) {
      pos += 1;
      continue;
    }
    const samplesPerFrame = versionBits === 3 ? 1152 : 576;
    const frameLen = Math.floor(((samplesPerFrame / 8) * bitrateKbps * 1000) / sampleRate) + padding;
    if (frameLen <= 0) {
      pos += 1;
      continue;
    }
    durationSec += samplesPerFrame / sampleRate;
    pos += frameLen;
  }
  return Math.round(durationSec * 1000);
}
