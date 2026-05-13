/**
 * 讯飞超拟人 TTS 诊断脚本（脱敏版）
 *
 * 用法：
 *   1. 把 .env.example 复制为 .env.local 并填入凭据
 *   2. cd apps/server && node --env-file=.env.local scripts/xfyun-tts-probe.mjs
 *
 * 输出：
 *   - 终端日志（连接耗时 / TTFB / 总耗时 / 字节数 / 错误码）
 *   - /tmp/xfyun_probe_<ts>.mp3（成功时落盘 mp3 试听）
 *
 * 注意：本脚本不在源码里出现任何明文凭据，全部从 process.env 读取。
 */
import WebSocket from 'ws';
import crypto from 'node:crypto';
import fs from 'node:fs';

const APP_ID = process.env.XFYUN_APP_ID;
const API_KEY = process.env.XFYUN_API_KEY;
const API_SECRET = process.env.XFYUN_API_SECRET;
const HOST = process.env.XFYUN_TTS_HOST ?? 'cbm01.cn-huabei-1.xf-yun.com';
const PATH = process.env.XFYUN_TTS_PATH ?? '/v1/private/mcd9m97e6';
const VCN = process.env.XFYUN_TTS_VCN ?? 'x6_lingxiaoxuan_pro';
const TEST_TEXT = process.argv[2] ?? '你好指挥官，我是小可，今天有什么计划吗？';

if (!APP_ID || !API_KEY || !API_SECRET) {
  console.error('[ERR] 凭据未配置。请填 apps/server/.env.local，参考 .env.example');
  process.exit(1);
}

function buildSignedUrl() {
  const date = new Date().toUTCString();
  const sigOrigin = `host: ${HOST}\ndate: ${date}\nGET ${PATH} HTTP/1.1`;
  const signature = crypto.createHmac('sha256', API_SECRET).update(sigOrigin).digest('base64');
  const authOrigin =
    `api_key="${API_KEY}", algorithm="hmac-sha256", ` +
    `headers="host date request-line", signature="${signature}"`;
  const authorization = Buffer.from(authOrigin).toString('base64');
  return `wss://${HOST}${PATH}?` + new URLSearchParams({ authorization, date, host: HOST });
}

const url = buildSignedUrl();
console.log(`[INFO] vcn=${VCN} text="${TEST_TEXT}"`);
console.log('[INFO] connecting...');

const ws = new WebSocket(url);
const audioChunks = [];
const startedAt = Date.now();
let firstChunkAt = null;
let frameCount = 0;

ws.on('open', () => {
  console.log(`[INFO] open after ${Date.now() - startedAt}ms`);
  ws.send(
    JSON.stringify({
      header: { app_id: APP_ID, status: 2 },
      parameter: {
        oral: { oral_level: 'mid' },
        tts: {
          vcn: VCN,
          speed: 50,
          volume: 50,
          pitch: 50,
          bgs: 0,
          reg: 0,
          rdn: 0,
          rhy: 0,
          audio: {
            encoding: 'lame',
            sample_rate: 24000,
            channels: 1,
            bit_depth: 16,
            frame_size: 0,
          },
        },
      },
      payload: {
        text: {
          encoding: 'utf8',
          compress: 'raw',
          format: 'plain',
          status: 2,
          seq: 0,
          text: Buffer.from(TEST_TEXT).toString('base64'),
        },
      },
    }),
  );
});

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.header?.code !== 0) {
    console.error(
      `[ERR ] server code=${msg.header?.code} msg="${msg.header?.message}" sid=${msg.header?.sid}`,
    );
    ws.close();
    return;
  }
  if (firstChunkAt === null) {
    firstChunkAt = Date.now();
    console.log(`[OK  ] TTFB ${firstChunkAt - startedAt}ms`);
  }
  frameCount += 1;
  const audioB64 = msg.payload?.audio?.audio;
  if (audioB64) audioChunks.push(Buffer.from(audioB64, 'base64'));
  if (msg.header?.status === 2) {
    const total = Buffer.concat(audioChunks);
    const outPath = `/tmp/xfyun_probe_${Date.now()}.mp3`;
    fs.writeFileSync(outPath, total);
    console.log(
      `[DONE] frames=${frameCount} bytes=${total.length} ` +
        `total=${Date.now() - startedAt}ms -> ${outPath}`,
    );
    ws.close();
  }
});

ws.on('error', (err) => {
  console.error('[ERR ] ws error:', err.message);
  process.exit(1);
});
ws.on('close', () => process.exit(0));

setTimeout(() => {
  console.error('[ERR ] timeout 20s');
  process.exit(1);
}, 20000);
