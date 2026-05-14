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
          text: '你好，指挥官，欢迎回到方舟。',
          speaker: VOICE,
          audio_params: {
            format: 'mp3',
            sample_rate: 24000,
          },
        },
      };
      ws.send(buildFrame(0b0001, 0b0100, 200, sessionId, JSON.stringify(taskReq)));
      console.log('[volc-tts] → task_request (event=200, text=你好指挥官...)');

      // 4. finish_session（event=102）
      setTimeout(() => {
        ws.send(buildFrame(0b0001, 0b0100, 102, sessionId, JSON.stringify({})));
        console.log('[volc-tts] → finish_session (event=102)');
      }, 200);
    }, 100);
  }, 100);
});

ws.on('message', (data) => {
  if (Buffer.isBuffer(data) && data.length >= 4) {
    const messageType = (data[1] >> 4) & 0xf;
    const flags = data[1] & 0xf;
    const isAudio = messageType === 0b1011; // audio-only server response

    if (isAudio) {
      // header(4) + event(4) + session_size(4) + session_str + payload_size(4) + payload
      // 简化：直接计算 audio 字节数
      if (firstAudioChunkAt === null) {
        firstAudioChunkAt = Date.now();
        console.log(`[volc-tts] ← first audio chunk (TTFB ${firstAudioChunkAt - startedAt}ms)`);
      }
      totalAudioBytes += data.length;
      return;
    }

    // 控制消息：找 JSON body
    try {
      // 找 payload JSON：从 data 末尾往前找最后一个完整 JSON
      const tail = data.slice(8).toString('utf8');
      const lastBraceIdx = tail.lastIndexOf('{');
      if (lastBraceIdx !== -1) {
        const jsonStr = tail.slice(lastBraceIdx);
        console.log(`[volc-tts] ← ctrl mt=${messageType} flags=${flags.toString(2)}: ${jsonStr.slice(0, 300)}`);
      } else {
        console.log(`[volc-tts] ← ctrl mt=${messageType} flags=${flags.toString(2)} (${data.length} bytes)`);
      }
    } catch {
      console.log(`[volc-tts] ← ctrl mt=${messageType} (${data.length} bytes)`);
    }
  }
});

ws.on('error', (err) => {
  console.error('[volc-tts] error:', err.message);
});

ws.on('close', (code, reason) => {
  closed = true;
  const totalMs = Date.now() - startedAt;
  console.log(`[volc-tts] close code=${code} reason=${reason?.toString()}`);
  console.log(`[volc-tts] summary: total=${totalMs}ms audio_bytes=${totalAudioBytes} TTFB=${firstAudioChunkAt ? firstAudioChunkAt - startedAt : 'N/A'}ms`);
  process.exit(0);
});

// 8s 超时
setTimeout(() => {
  if (!closed) {
    console.log('[volc-tts] (probe timeout, closing)');
    ws.close();
  }
}, 8000);
