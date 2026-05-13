/**
 * Gemini 代理双路验证（脱敏版）
 *
 * 验证内容：
 *   A. OpenAI 兼容 HTTP 流式 chat：POST {GEMINI_PROXY_URL}/chat/completions
 *      → 确认代理基本工作，所有 6 个模型可用性
 *   B. Gemini Live WS（实时双向语音流）：尝试在代理上接 ws
 *      → 关键判断：4 天 demo 能否直接走 Gemini Live
 *
 * 用法：
 *   cd apps/server
 *   node --env-file=.env.local scripts/gemini-probe.mjs
 *
 * 凭据：仅从 process.env 读，源码内零明文
 */
import WebSocket from 'ws';

const PROXY_URL = process.env.GEMINI_PROXY_URL;
const API_KEY = process.env.GEMINI_API_KEY;
const MODELS = (process.env.GEMINI_MODELS ?? '').split(',').filter(Boolean);
const LIVE_MODEL = process.env.GEMINI_LIVE_MODEL ?? 'gemini-live-2.5-flash-preview';

if (!PROXY_URL || !API_KEY) {
  console.error('[ERR] GEMINI_PROXY_URL or GEMINI_API_KEY missing in .env.local');
  process.exit(1);
}

// =========================================================================
// A. OpenAI 兼容 chat 流式
// =========================================================================
async function probeChatStream(model) {
  const t0 = Date.now();
  let firstTokenAt = null;
  let tokens = 0;
  let collected = '';

  try {
    const res = await fetch(`${PROXY_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: '你是儿童陪伴机器人小可。简短回答。' },
          { role: 'user', content: '用一句话欢迎指挥官回家。' },
        ],
        stream: true,
        max_tokens: 80,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      return { model, ok: false, code: res.status, err: text.slice(0, 120), ms: Date.now() - t0 };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const evt = JSON.parse(data);
          const delta = evt.choices?.[0]?.delta?.content;
          if (delta) {
            if (firstTokenAt === null) firstTokenAt = Date.now();
            collected += delta;
            tokens += 1;
          }
        } catch {}
      }
    }
    return {
      model,
      ok: true,
      ttft_ms: firstTokenAt ? firstTokenAt - t0 : null,
      total_ms: Date.now() - t0,
      tokens,
      reply: collected.slice(0, 80),
    };
  } catch (e) {
    return { model, ok: false, err: e.message, ms: Date.now() - t0 };
  }
}

// =========================================================================
// B. Gemini Live WS：尝试两种路径
// =========================================================================
async function probeLiveOnProxy() {
  // 把 PROXY_URL 转 ws
  const wsUrl = PROXY_URL.replace(/^http/, 'ws')
    .replace(/\/v1$/, '/v1/realtime')
    + `?model=${encodeURIComponent(LIVE_MODEL)}`;
  return tryLiveWs(wsUrl, 'proxy realtime path');
}

async function probeLiveOnOfficial() {
  // 官方原生 Live endpoint（看本机能否直连 Google + 代理 API key 是否有效）
  const wsUrl =
    `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${API_KEY}`;
  return tryLiveWs(wsUrl, 'official Google');
}

function tryLiveWs(wsUrl, label) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let resolved = false;
    const done = (r) => {
      if (resolved) return;
      resolved = true;
      try { ws.close(); } catch {}
      resolve({ label, url: wsUrl.replace(/key=[^&]+/, 'key=***'), ...r });
    };
    let ws;
    try {
      ws = new WebSocket(wsUrl, {
        headers: wsUrl.startsWith('ws://23')
          ? { Authorization: `Bearer ${API_KEY}` }
          : undefined,
      });
    } catch (e) {
      done({ ok: false, err: `ctor: ${e.message}`, ms: Date.now() - t0 });
      return;
    }

    ws.on('open', () => {
      // 发送 BidiGenerateContent setup 帧
      ws.send(
        JSON.stringify({
          setup: {
            model: `models/${LIVE_MODEL}`,
            generationConfig: { responseModalities: ['TEXT'] },
          },
        }),
      );
    });

    ws.on('message', (raw) => {
      const text = raw.toString();
      done({ ok: true, ms: Date.now() - t0, first_msg: text.slice(0, 200) });
    });

    ws.on('error', (e) => done({ ok: false, err: e.message, ms: Date.now() - t0 }));
    setTimeout(() => done({ ok: false, err: 'timeout', ms: Date.now() - t0 }), 8000);
  });
}

// =========================================================================
// 主流程
// =========================================================================
console.log('====== A. OpenAI 兼容 HTTP 流式 chat ======');
console.log(`proxy: ${PROXY_URL}`);
for (const m of MODELS) {
  const r = await probeChatStream(m);
  if (r.ok) {
    console.log(
      `[OK ] ${m.padEnd(36)} TTFT=${String(r.ttft_ms).padStart(4)}ms total=${String(r.total_ms).padStart(4)}ms tokens=${r.tokens}  reply="${r.reply}"`,
    );
  } else {
    console.log(`[ERR] ${m.padEnd(36)} code=${r.code} ms=${r.ms} ${r.err}`);
  }
}

console.log('\n====== B. Gemini Live WS（实时音频双向流） ======');
console.log('尝试 1：通过代理');
const r1 = await probeLiveOnProxy();
console.log(`  url: ${r1.url}`);
console.log(`  result: ok=${r1.ok} ms=${r1.ms} ${r1.ok ? `first_msg="${r1.first_msg}"` : `err="${r1.err}"`}`);

console.log('\n尝试 2：直连 Google 官方（看本机网络 + key 是否有效）');
const r2 = await probeLiveOnOfficial();
console.log(`  url: ${r2.url}`);
console.log(`  result: ok=${r2.ok} ms=${r2.ms} ${r2.ok ? `first_msg="${r2.first_msg}"` : `err="${r2.err}"`}`);

console.log('\n====== 结论 ======');
if (r1.ok) {
  console.log('✅ 代理透传 Gemini Live WS：可作为 V0.4 主线/实验线');
} else if (r2.ok) {
  console.log('⚠️  代理不透传 Live WS，但本机直连官方 OK：可考虑后端不走代理');
} else {
  console.log('❌ Live WS 两路都不通：4 天 demo 不上 Gemini Live，仅用 OpenAI 兼容 chat');
}
