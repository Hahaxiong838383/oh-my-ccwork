/**
 * TokenPlan 代理（含 MiniMax 2.7）探测脚本（脱敏版）
 *
 * 关注点：
 *   1. 哪个 endpoint 真能用（TokenPlan 几个常见地址）
 *   2. /v1/models 返回的可用模型清单
 *   3. MiniMax 系列模型 chat 流式 TTFT + 中文输出质量
 *   4. 是否支持 audio (speech/transcriptions) —— 决定能不能做 TTS/STT
 *
 * 用法：cd apps/server && node --env-file=.env.local scripts/tokenplan-probe.mjs
 */
const API_KEY = process.env.TOKENPLAN_API_KEY;
if (!API_KEY) {
  console.error('[ERR] TOKENPLAN_API_KEY missing in .env.local');
  process.exit(1);
}

// 候选 base URL（按概率排）
const BASE_CANDIDATES = [
  process.env.TOKENPLAN_BASE_URL,
  'https://api.tokenplan.com/v1',
  'https://tokenplan.com/v1',
  'https://www.tokenplan.com/v1',
  'https://api.tokenplan.ai/v1',
  'https://tokenplan.ai/v1',
].filter(Boolean);

// MiniMax 系列模型候选名
const MODEL_CANDIDATES = [
  'MiniMax-M2.7',
  'MiniMax-M2',
  'MiniMax-Text-01',
  'minimax-text-01',
  'abab6.5s-chat',
  'abab7-chat',
];

async function probeBase(base) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      return { base, ok: false, code: res.status, ms: Date.now() - t0 };
    }
    const data = await res.json();
    const list = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
    return { base, ok: true, count: list.length, ms: Date.now() - t0, list };
  } catch (e) {
    return { base, ok: false, err: e.message, ms: Date.now() - t0 };
  }
}

async function chatStream(base, model) {
  const t0 = Date.now();
  let firstTokenAt = null;
  let tokens = 0;
  let collected = '';

  try {
    const res = await fetch(`${base}/chat/completions`, {
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
      signal: AbortSignal.timeout(15000),
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
      reply: collected.slice(0, 100),
    };
  } catch (e) {
    return { model, ok: false, err: e.message, ms: Date.now() - t0 };
  }
}

async function probeAudioSpeech(base) {
  // OpenAI 兼容 TTS：/v1/audio/speech
  const t0 = Date.now();
  try {
    const res = await fetch(`${base}/audio/speech`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: 'speech-01',
        voice: 'female-shaonv',
        input: '测试',
        response_format: 'mp3',
      }),
      signal: AbortSignal.timeout(10000),
    });
    return { ok: res.ok, code: res.status, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, err: e.message, ms: Date.now() - t0 };
  }
}

// ============================================================
console.log('====== 1. 探测可用 base URL ======');
let workingBase = null;
let modelList = [];
for (const base of BASE_CANDIDATES) {
  const r = await probeBase(base);
  if (r.ok) {
    console.log(`[OK ] ${base.padEnd(40)} models=${r.count} ms=${r.ms}`);
    if (!workingBase) {
      workingBase = base;
      modelList = r.list;
    }
  } else {
    console.log(`[ERR] ${base.padEnd(40)} code=${r.code ?? '-'} ms=${r.ms} ${r.err ?? ''}`);
  }
}

if (!workingBase) {
  console.error('\n❌ 没有可用 base URL，请确认 TokenPlan 平台地址');
  process.exit(1);
}

console.log(`\n====== 2. 模型清单 (base=${workingBase}) ======`);
const minimaxModels = modelList.filter((m) =>
  String(m.id ?? m.name ?? '').toLowerCase().includes('minimax'),
);
const allIds = modelList.map((m) => m.id ?? m.name).filter(Boolean);
console.log(`总模型数: ${allIds.length}`);
console.log(`含 minimax: ${minimaxModels.length}`);
console.log('MiniMax 系列:');
for (const m of minimaxModels) console.log(`  - ${m.id ?? m.name}`);
if (minimaxModels.length === 0) {
  console.log('  (清单中未直接命中 minimax，下面将盲测候选名)');
  console.log('前 20 个模型 ID 样本:');
  for (const id of allIds.slice(0, 20)) console.log(`  - ${id}`);
}

console.log(`\n====== 3. MiniMax chat 流式测试 (base=${workingBase}) ======`);
const tryModels = [
  ...new Set([
    ...minimaxModels.map((m) => m.id ?? m.name),
    ...MODEL_CANDIDATES,
  ]),
];
for (const m of tryModels) {
  const r = await chatStream(workingBase, m);
  if (r.ok) {
    console.log(
      `[OK ] ${m.padEnd(28)} TTFT=${String(r.ttft_ms ?? '-').padStart(5)}ms total=${String(r.total_ms).padStart(5)}ms tokens=${r.tokens}  reply="${r.reply}"`,
    );
  } else {
    console.log(`[ERR] ${m.padEnd(28)} code=${r.code ?? '-'} ms=${r.ms} ${r.err}`);
  }
}

console.log(`\n====== 4. TTS 能力探测 (audio/speech) ======`);
const ttsR = await probeAudioSpeech(workingBase);
console.log(`  ok=${ttsR.ok} code=${ttsR.code ?? '-'} ms=${ttsR.ms} ${ttsR.err ?? ''}`);
if (ttsR.ok) {
  console.log('  ✅ 代理可能支持 OpenAI 兼容 TTS');
} else if (ttsR.code === 404) {
  console.log('  ⚠️  代理不支持 /audio/speech（聚合平台一般只代理 chat）');
} else if (ttsR.code === 400 || ttsR.code === 422) {
  console.log('  ⚠️  接口存在但参数被拒（可能需要不同的 model/voice 名）');
}
