#!/usr/bin/env node
/**
 * volc-tts-probe.mjs —— 火山引擎 TTS v3 双向流式探针
 *
 * 复用 ASR 同应用的 APP_ID + Access Token。
 * 协议：WebSocket + 4 字节 header + 4 字节 size + JSON payload
 *
 * 文档：https://www.volcengine.com/docs/6561/79821
 * 运行：node --env-file=.env.local scripts/volc-tts-probe.mjs
 */

import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ID = process.env.VOLC_TTS_APP_ID;
const ACCESS_TOKEN = process.env.VOLC_TTS_ACCESS_TOKEN;
const WS_URL = process.env.VOLC_TTS_WS_URL ?? 'wss://openspeech.bytedance.com/api/v3/tts/bidirection';
const RESOURCE_ID = process.env.VOLC_TTS_RESOURCE_ID ?? 'volc.service_type.10029';
const VOICE = process.env.VOLC_TTS_VOICE_TYPE ?? 'BV001_streaming';

if (!APP_ID || !ACCESS_TOKEN) {
  console.error('[ERR] VOLC_TTS_APP_ID / VOLC_TTS_ACCESS_TOKEN 未配置');
  process.exit(1);
}

const connectId = randomUUID();
console.log('[volc-tts] →', WS_URL);
console.log('[volc-tts] resource:', RESOURCE_ID);
console.log('[volc-tts] connect_id:', connectId);
console.log('[volc-tts] app_id:', APP_ID);
console.log('[volc-tts] voice:', VOICE);

const startedAt = Date.now();
const ws = new WebSocket(WS_URL, {
  headers: {
    'X-Api-App-Key': APP_ID,
    'X-Api-Access-Key': ACCESS_TOKEN,
    'X-Api-Resource-Id': RESOURCE_ID,
    'X-Api-Connect-Id': connectId,
  },
});

let closed = false;
let firstAudioChunkAt = null;
let totalAudioBytes = 0;
const audioChunks = [];
const TEXT = process.env.VOLC_TTS_TEXT ?? '你好，指挥官！欢迎回到方舟。我是小可，今天我们一起开始今天的探索旅程吧。';
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, '..', 'audio-samples');
mkdirSync(OUTPUT_DIR, { recursive: true });
const VOICE_LABEL = (process.env.VOLC_TTS_VOICE_TYPE ?? 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
const outputPath = join(OUTPUT_DIR, `tts-${VOICE_LABEL}-${Date.now()}.mp3`);

ws.on('upgrade', (res) => {
  console.log(`[volc-tts] upgrade status=${res.statusCode}`);
});

ws.on('unexpected-response', (_req, res) => {
  console.log(`[volc-tts] ❌ status=${res.statusCode}`);
  let body = '';
  res.on('data', (c) => (body += c));
  res.on('end', () => {
    console.log('  body:', body.slice(0, 500));
    process.exit(1);
  });
});

/**
 * 火山 TTS v3 双向流协议帧：
 *   header(4) + event(4 big-endian int32) + [session_id_size(4) + session_id_utf8] + payload_size(4) + payload
 *
 * 注意：start_connection (event=1) 不含 session_id 段。
 */
function buildFrame(messageType, flags, eventId, sessionId, payloadJsonStr) {
  const payload = Buffer.from(payloadJsonStr, 'utf8');
  const header = Buffer.from([
    (1 << 4) | 1,
    (messageType << 4) | flags,
    (0b0001 << 4) | 0b0000,
    0,
  ]);
  const eventBuf = Buffer.alloc(4);
  eventBuf.writeInt32BE(eventId);

  const parts = [header, eventBuf];

  if (sessionId !== null) {
    const sessionBuf = Buffer.from(sessionId, 'utf8');
    const sessionSize = Buffer.alloc(4);
    sessionSize.writeUInt32BE(sessionBuf.length);
    parts.push(sessionSize, sessionBuf);
  }

  const payloadSize = Buffer.alloc(4);
  payloadSize.writeUInt32BE(payload.length);
  parts.push(payloadSize, payload);

  return Buffer.concat(parts);
}

ws.on('open', () => {
  const elapsedMs = Date.now() - startedAt;
  console.log(`[volc-tts] ✅ open (${elapsedMs}ms)`);

  const sessionId = randomUUID();

  // 1. start_connection（event=1，无 session_id）
  ws.send(buildFrame(0b0001, 0b0100, 1, null, JSON.stringify({})));
  console.log('[volc-tts] → start_connection (event=1)');

  // 2. start_session（event=100，含 session_id + speaker）
  setTimeout(() => {
    const startSession = {
      user: { uid: 'probe-user' },
      namespace: 'BidirectionalTTS',
      req_params: {
        speaker: VOICE,
        audio_params: {
          format: 'mp3',
          sample_rate: 24000,
        },
      },
    };
    ws.send(buildFrame(0b0001, 0b0100, 100, sessionId, JSON.stringify(startSession)));
    console.log('[volc-tts] → start_session (event=100)');

    // 3. task_request 发文本（event=200）
    setTimeout(() => {
      const taskReq = {
        namespace: 'BidirectionalTTS',
        req_params: {
          text: TEXT,
          speaker: VOICE,
          audio_params: {
            format: 'mp3',
            sample_rate: 24000,
          },
        },
      };
      ws.send(buildFrame(0b0001, 0b0100, 200, sessionId, JSON.stringify(taskReq)));
      console.log(`[volc-tts] → task_request (event=200, text="${TEXT.slice(0, 20)}...")`);

      // 4. finish_session（event=102）
      setTimeout(() => {
        ws.send(buildFrame(0b0001, 0b0100, 102, sessionId, JSON.stringify({})));
        console.log('[volc-tts] → finish_session (event=102)');
      }, 200);
    }, 100);
  }, 100);
});

function parseFrame(data) {
  // header(4) + event(4) + [session_size(4) + session]? + payload_size(4) + payload
  const headerSize = (data[0] & 0xf) * 4;
  const messageType = (data[1] >> 4) & 0xf;
  const flags = data[1] & 0xf;
  let cursor = headerSize;

  // event 字段（4 bytes）
  if (cursor + 4 > data.length) return { messageType, flags, event: null, payload: Buffer.alloc(0) };
  const event = data.readInt32BE(cursor);
  cursor += 4;

  // 试读 session_size + session_id（如果有的话）
  // 启发式：如果剩余 ≥ 8 bytes，先读 4 字节当 sessionSize，再判断它合理性
  if (cursor + 4 <= data.length) {
    const maybeSessionSize = data.readUInt32BE(cursor);
    if (maybeSessionSize >= 0 && maybeSessionSize < 256 && cursor + 4 + maybeSessionSize + 4 <= data.length) {
      // 看起来合理：跳过 session
      cursor += 4 + maybeSessionSize;
    }
  }

  // payload_size
  if (cursor + 4 > data.length) return { messageType, flags, event, payload: Buffer.alloc(0) };
  const payloadSize = data.readUInt32BE(cursor);
  cursor += 4;
  const payload = data.slice(cursor, cursor + payloadSize);
  return { messageType, flags, event, payload };
}

ws.on('message', (data) => {
  if (!Buffer.isBuffer(data) || data.length < 16) return;
  let frame;
  try {
    frame = parseFrame(data);
  } catch (err) {
    console.log('[volc-tts] ← parse error:', err.message);
    return;
  }

  const isAudio = frame.messageType === 0b1011;
  if (isAudio) {
    if (firstAudioChunkAt === null) {
      firstAudioChunkAt = Date.now();
      console.log(`[volc-tts] ← first audio chunk (TTFB ${firstAudioChunkAt - startedAt}ms, ${frame.payload.length} bytes)`);
    }
    audioChunks.push(frame.payload);
    totalAudioBytes += frame.payload.length;
    return;
  }

  // 控制消息
  try {
    const txt = frame.payload.toString('utf8');
    console.log(`[volc-tts] ← ctrl mt=${frame.messageType} event=${frame.event}: ${txt.slice(0, 300)}`);
  } catch {
    console.log(`[volc-tts] ← ctrl mt=${frame.messageType} event=${frame.event} (${frame.payload.length} bytes binary)`);
  }
});

ws.on('error', (err) => {
  console.error('[volc-tts] error:', err.message);
});

ws.on('close', (code, reason) => {
  closed = true;
  const totalMs = Date.now() - startedAt;
  console.log(`[volc-tts] close code=${code} reason=${reason?.toString()}`);
  console.log(`[volc-tts] summary: total=${totalMs}ms audio_bytes=${totalAudioBytes} TTFB=${firstAudioChunkAt ? firstAudioChunkAt - startedAt : 'N/A'}ms chunks=${audioChunks.length}`);

  if (audioChunks.length > 0) {
    const merged = Buffer.concat(audioChunks);
    writeFileSync(outputPath, merged);
    console.log(`[volc-tts] 🎧 saved mp3: ${outputPath}`);
    console.log(`[volc-tts]    file size: ${merged.length} bytes`);
  } else {
    console.log('[volc-tts] ⚠️ 没收到音频，未保存');
  }
  process.exit(0);
});

const TIMEOUT_MS = Number(process.env.VOLC_TTS_PROBE_TIMEOUT_MS ?? 8000);
setTimeout(() => {
  if (!closed) {
    console.log(`[volc-tts] (probe timeout ${TIMEOUT_MS}ms, closing)`);
    ws.close();
  }
}, TIMEOUT_MS);
