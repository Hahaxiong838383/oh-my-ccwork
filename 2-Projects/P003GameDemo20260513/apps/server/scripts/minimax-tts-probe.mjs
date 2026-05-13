/**
 * MiniMax T2A v2 测试脚本（脱敏版）
 *
 * 端点：POST https://api.minimaxi.com/v1/t2a_v2
 * 文档：https://platform.minimaxi.com/docs（川哥提供 2026-05-13）
 *
 * 测试矩阵：
 *   1. 非流式 baseline（速度 + 完整 mp3 出声试听）
 *   2. 流式 TTFB（4 天 demo 实时性关键）
 *   3. 多音色对比（找适合"小可"IP 的音色）
 *   4. emotion 参数（对接小可情绪维度）
 *
 * 用法：
 *   cd apps/server
 *   node --env-file=.env.local scripts/minimax-tts-probe.mjs
 *
 * 输出：
 *   - 终端：TTFB / 总耗时 / 文件大小 / 字节数
 *   - 文件：/tmp/minimax_tts_<voice>_<mode>_<ts>.mp3 供川哥试听
 */
import fs from 'node:fs';

const API_KEY = process.env.TOKENPLAN_API_KEY;
const BASE_URL = process.env.TOKENPLAN_BASE_URL ?? 'https://api.minimaxi.com/v1';

if (!API_KEY) {
  console.error('[ERR] TOKENPLAN_API_KEY missing in .env.local');
  process.exit(1);
}

const TEST_TEXT = '你好指挥官，我是小可(laughs)，今天有什么计划吗？';

// 候选音色（文档示例 + 适合儿童陪伴的）
const VOICE_CANDIDATES = [
  { id: 'male-qn-qingse', label: '青涩男声 (qingse)', gender: 'M' },
  { id: 'Chinese (Mandarin)_Lyrical_Voice', label: '中文抒情女声', gender: 'F' },
  { id: 'moss_audio_aaa1346a-7ce7-11f0-8e61-2e6e3c7ee85d', label: 'moss 音色 A', gender: '?' },
  { id: 'moss_audio_ce44fc67-7ce3-11f0-8de5-96e35d26fb85', label: 'moss 音色 B', gender: '?' },
];

const MODEL = 'speech-2.8-turbo'; // turbo = 快首包，2.8 支持语气词标签

function buildBody({ stream, voiceId, emotion = 'happy' }) {
  return {
    model: MODEL,
    text: TEST_TEXT,
    stream,
    voice_setting: {
      voice_id: voiceId,
      speed: 1.0,
      vol: 1,
      pitch: 0,
      emotion,
    },
    audio_setting: {
      sample_rate: 32000,
      bitrate: 128000,
      format: 'mp3',
      channel: 1,
    },
  };
}

async function nonStream(voice) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${BASE_URL}/t2a_v2`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(buildBody({ stream: false, voiceId: voice.id })),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      const t = await res.text();
      return { ok: false, code: res.status, err: t.slice(0, 140), ms: Date.now() - t0 };
    }
    const json = await res.json();
    const code = json.base_resp?.status_code;
    const msg = json.base_resp?.status_msg;
    if (code !== 0) return { ok: false, code, err: msg, ms: Date.now() - t0 };
    const hex = json.data?.audio;
    const buf = Buffer.from(hex, 'hex');
    const out = `/tmp/minimax_tts_${sanitize(voice.id)}_nonstream_${Date.now()}.mp3`;
    fs.writeFileSync(out, buf);
    return {
      ok: true,
      ms: Date.now() - t0,
      bytes: buf.length,
      audio_length_ms: json.extra_info?.audio_length,
      file: out,
    };
  } catch (e) {
    return { ok: false, err: e.message, ms: Date.now() - t0 };
  }
}

async function streamTest(voice) {
  const t0 = Date.now();
  let firstChunkAt = null;
  let chunks = 0;
  const audioBufs = [];

  try {
    const res = await fetch(`${BASE_URL}/t2a_v2`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(buildBody({ stream: true, voiceId: voice.id })),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      const t = await res.text();
      return { ok: false, code: res.status, err: t.slice(0, 140), ms: Date.now() - t0 };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        try {
          const evt = JSON.parse(data);
          const hex = evt.data?.audio;
          const status = evt.data?.status;
          if (hex && hex.length > 0) {
            if (firstChunkAt === null) firstChunkAt = Date.now();
            audioBufs.push(Buffer.from(hex, 'hex'));
            chunks += 1;
          }
          if (status === 2) {
            // 最后一帧，结束
          }
        } catch {}
      }
    }
    const merged = Buffer.concat(audioBufs);
    const out = `/tmp/minimax_tts_${sanitize(voice.id)}_stream_${Date.now()}.mp3`;
    fs.writeFileSync(out, merged);
    return {
      ok: true,
      ttfb_ms: firstChunkAt ? firstChunkAt - t0 : null,
      total_ms: Date.now() - t0,
      chunks,
      bytes: merged.length,
      file: out,
    };
  } catch (e) {
    return { ok: false, err: e.message, ms: Date.now() - t0 };
  }
}

function sanitize(s) {
  return String(s).replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30);
}

// =========================================================================
console.log(`====== MiniMax T2A v2 测试 (model=${MODEL}) ======`);
console.log(`text="${TEST_TEXT}"\n`);

console.log('--- 1. 非流式 baseline ---');
for (const v of VOICE_CANDIDATES) {
  const r = await nonStream(v);
  if (r.ok) {
    console.log(
      `[OK ] ${v.label.padEnd(28)} total=${String(r.ms).padStart(5)}ms ` +
        `audio_len=${r.audio_length_ms}ms bytes=${r.bytes}  ${r.file}`,
    );
  } else {
    console.log(`[ERR] ${v.label.padEnd(28)} code=${r.code ?? '-'} ms=${r.ms} ${r.err}`);
  }
}

console.log('\n--- 2. 流式 TTFB（实时性核心指标） ---');
for (const v of VOICE_CANDIDATES) {
  const r = await streamTest(v);
  if (r.ok) {
    console.log(
      `[OK ] ${v.label.padEnd(28)} TTFB=${String(r.ttfb_ms).padStart(5)}ms ` +
        `total=${String(r.total_ms).padStart(5)}ms chunks=${r.chunks} bytes=${r.bytes}  ${r.file}`,
    );
  } else {
    console.log(`[ERR] ${v.label.padEnd(28)} code=${r.code ?? '-'} ms=${r.ms} ${r.err}`);
  }
}

console.log('\n====== 试听命令（macOS） ======');
console.log('ls -t /tmp/minimax_tts_*.mp3 | head -5 | xargs -n1 afplay');
