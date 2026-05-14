#!/usr/bin/env node
/**
 * volc-doubao-tts2-probe.mjs —— Doubao-TTS 2.0 API Key 鉴权多组合探针
 *
 * 川哥提供：API Key 名 + UUID secret，不带 ASR/TTS 子应用 APP_ID。
 * 目标：试出哪种 endpoint + header 组合能跑通 doubao-tts 2.0。
 *
 * 运行：node --env-file=.env.local scripts/volc-doubao-tts2-probe.mjs
 */

import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';

const API_KEY_NAME = process.env.VOLC_API_KEY_NAME;
const API_KEY = process.env.VOLC_API_KEY;

if (!API_KEY) {
  console.error('[ERR] VOLC_API_KEY 未配置');
  process.exit(1);
}

const ENDPOINTS = [
  'wss://openspeech.bytedance.com/api/v3/tts/bidirection',
  'wss://openspeech.bytedance.com/api/v3/tts/unidirection',
  'wss://openspeech.bytedance.com/api/v1/tts/ws_binary',
];

// 资源 ID 候选（doubao tts 2.0 可能用新 resource）
const RESOURCES = [
  'volc.service_type.10029',     // 当前用的大模型 TTS
  'volc.megatts.default',
  'volc.tts.default',
  'volc.doubao.tts.v2',
];

// 鉴权 header 组合
const AUTH_MODES = [
  { name: 'mode_A_access_key_only', headers: () => ({
    'X-Api-Access-Key': API_KEY,
  })},
  { name: 'mode_B_bearer', headers: () => ({
    'Authorization': `Bearer ${API_KEY}`,
  })},
  { name: 'mode_C_app_key_name + access_key_secret', headers: () => ({
    'X-Api-App-Key': API_KEY_NAME ?? '',
    'X-Api-Access-Key': API_KEY,
  })},
];

async function tryOne(endpoint, resourceId, mode) {
  return new Promise((resolve) => {
    const connectId = randomUUID();
    const headers = {
      ...mode.headers(),
      'X-Api-Resource-Id': resourceId,
      'X-Api-Connect-Id': connectId,
    };

    const ws = new WebSocket(endpoint, { headers });
    let resolved = false;

    const finish = (status) => {
      if (resolved) return;
      resolved = true;
      try { ws.close(); } catch {}
      resolve(status);
    };

    ws.on('upgrade', (res) => {
      if (res.statusCode === 101) {
        // 升级成功，立刻 close
        setTimeout(() => finish({ ok: true, code: 101 }), 50);
      }
    });

    ws.on('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        finish({ ok: false, code: res.statusCode, body: body.slice(0, 200) });
      });
    });

    ws.on('error', (err) => {
      finish({ ok: false, code: 'ERR', body: err.message.slice(0, 200) });
    });

    setTimeout(() => finish({ ok: false, code: 'TIMEOUT', body: '' }), 4000);
  });
}

async function main() {
  console.log('Doubao-TTS 2.0 API Key 探针（' + ENDPOINTS.length + ' endpoints × ' + RESOURCES.length + ' resources × ' + AUTH_MODES.length + ' auth modes = ' + (ENDPOINTS.length * RESOURCES.length * AUTH_MODES.length) + ' combos）');
  console.log('---');

  for (const endpoint of ENDPOINTS) {
    for (const resourceId of RESOURCES) {
      for (const mode of AUTH_MODES) {
        const result = await tryOne(endpoint, resourceId, mode);
        const label = `${endpoint.split('/').slice(-2).join('/')} | ${resourceId} | ${mode.name}`;
        if (result.ok) {
          console.log(`✅ ${label}  → 101 OK`);
        } else {
          const tag = result.code === 'TIMEOUT' ? '⌛' : result.code === 401 ? '🔒' : result.code === 404 ? '🚫' : result.code === 400 ? '⚠️' : '❌';
          console.log(`${tag} ${label}  → ${result.code} ${result.body.slice(0, 100)}`);
        }
      }
    }
  }
}

main();
