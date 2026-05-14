#!/usr/bin/env node
/**
 * volc-asr-probe.mjs —— 火山引擎流式 ASR 大模型版 API Key 探针
 *
 * 测试目标：用 API Key 模式建立 WebSocket 连接 + 发起一次 full audio query
 * 验证：
 *   - WebSocket 可连通
 *   - 鉴权是否通过
 *   - 服务是否真开通
 *
 * 不发真音频，只发协议握手帧看返回。
 *
 * 文档：https://www.volcengine.com/docs/6561/1354869
 * 运行：node --env-file=.env.local scripts/volc-asr-probe.mjs
 */

import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';

const APP_ID = process.env.VOLC_ASR_APP_ID;
const ACCESS_TOKEN = process.env.VOLC_ASR_ACCESS_TOKEN;
const WS_URL = process.env.VOLC_ASR_WS_URL ?? 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel';
const RESOURCE_ID = process.env.VOLC_ASR_RESOURCE_ID ?? 'volc.bigasr.sauc.duration';

if (!APP_ID || !ACCESS_TOKEN) {
  console.error('[ERR] VOLC_ASR_APP_ID / VOLC_ASR_ACCESS_TOKEN 未配置');
  process.exit(1);
}

const connectId = randomUUID();
console.log('[volc-asr] →', WS_URL);
console.log('[volc-asr] resource:', RESOURCE_ID);
console.log('[volc-asr] connect_id:', connectId);
console.log('[volc-asr] app_id:', APP_ID);
console.log('[volc-asr] access_token:', ACCESS_TOKEN.slice(0, 8) + '...');

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

ws.on('upgrade', (res) => {
  console.log(`[volc-asr] upgrade response status=${res.statusCode}`);
  for (const k of Object.keys(res.headers ?? {})) {
    if (k.toLowerCase().startsWith('x-tt') || k.toLowerCase().startsWith('x-api')) {
      console.log(`  ${k}: ${res.headers[k]}`);
    }
  }
});

ws.on('unexpected-response', (_req, res) => {
  console.log(`[volc-asr] ❌ unexpected-response status=${res.statusCode}`);
  console.log('  response headers:');
  for (const k of Object.keys(res.headers ?? {})) {
    if (
      k.toLowerCase().startsWith('x-tt') ||
      k.toLowerCase().startsWith('x-api') ||
      k.toLowerCase() === 'content-type'
    ) {
      console.log(`    ${k}: ${res.headers[k]}`);
    }
  }
  let body = '';
  res.on('data', (chunk) => (body += chunk));
  res.on('end', () => {
    console.log('  response body:', body.slice(0, 800));
    process.exit(1);
  });
});

ws.on('open', () => {
  const elapsedMs = Date.now() - startedAt;
  console.log(`[volc-asr] ✅ open (${elapsedMs}ms)`);

  // 发一个最简单的 full request 配置帧
  // 火山 ASR v3 协议：二进制 header(4 bytes) + 配置 JSON
  // 这里发个最小握手包看服务端反应
  const requestPayload = {
    user: { uid: 'demo-probe' },
    audio: {
      format: 'wav',
      codec: 'raw',
      rate: 16000,
      bits: 16,
      channel: 1,
    },
    request: {
      model_name: 'bigmodel',
      enable_punc: true,
    },
  };

  const payloadStr = JSON.stringify(requestPayload);
  const payloadBuf = Buffer.from(payloadStr, 'utf8');

  // 协议头：4 byte header (version=1, header_size=1, message_type=full_client_request=0b0001, message_type_specific_flags=0, serialization_method=JSON=0b0001, compression_type=none=0, reserved=0)
  // bytes:
  //   [0] protocol_version (4 bits) | header_size (4 bits)
  //   [1] message_type (4 bits) | message_type_specific_flags (4 bits)
  //   [2] serialization_method (4 bits) | compression_type (4 bits)
  //   [3] reserved
  const header = Buffer.from([
    (1 << 4) | 1,           // version=1, header=1
    (0b0001 << 4) | 0b0000, // full_client_request, no flags
    (0b0001 << 4) | 0b0000, // JSON serialization, no compression
    0,                       // reserved
  ]);
  const payloadSize = Buffer.alloc(4);
  payloadSize.writeUInt32BE(payloadBuf.length);

  const frame = Buffer.concat([header, payloadSize, payloadBuf]);
  console.log(`[volc-asr] → sending full_client_request, payload ${payloadBuf.length} bytes`);
  ws.send(frame);
});

ws.on('message', (data, isBinary) => {
  if (isBinary && Buffer.isBuffer(data)) {
    console.log(`[volc-asr] ← binary ${data.length} bytes`);
    // 解析协议头
    if (data.length >= 4) {
      const version = (data[0] >> 4) & 0xf;
      const headerSize = data[0] & 0xf;
      const messageType = (data[1] >> 4) & 0xf;
      console.log(`  version=${version}, header=${headerSize}, message_type=${messageType}`);
      // 试图提取 JSON 部分
      try {
        const headerBytes = headerSize * 4;
        const body = data.slice(headerBytes + 4); // 加 4 字节 payload size
        const txt = body.toString('utf8');
        console.log('  body:', txt.slice(0, 400));
      } catch { /* */ }
    }
  } else {
    console.log('[volc-asr] ← text:', String(data).slice(0, 400));
  }
});

ws.on('error', (err) => {
  console.error('[volc-asr] error:', err.message);
  closed = true;
});

ws.on('close', (code, reason) => {
  closed = true;
  console.log(`[volc-asr] close code=${code} reason=${reason?.toString()}`);
  process.exit(code === 1000 || code === 1006 ? 0 : 1);
});

// 5s 后主动断开
setTimeout(() => {
  if (!closed) {
    console.log('[volc-asr] (probe timeout, closing)');
    ws.close();
  }
}, 5000);
