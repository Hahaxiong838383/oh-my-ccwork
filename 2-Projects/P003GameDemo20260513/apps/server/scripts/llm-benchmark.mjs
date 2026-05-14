#!/usr/bin/env node
/**
 * llm-benchmark.mjs —— LLM 多模型对比测试
 *
 * 测试 5 个候选模型 × 2 个 prompt（日常 + 讲故事），统计：
 *   - TTFT（首 token 延迟）
 *   - 总响应时长
 *   - 输出字数
 *   - 是否被截断
 *   - 文案质量（人工看）
 *
 * 用法：
 *   cd apps/server && NO_PROXY=* node --env-file=.env.local scripts/llm-benchmark.mjs
 */

import { performance } from 'node:perf_hooks';

const PROXY_URL = process.env.GEMINI_PROXY_URL;
const API_KEY = process.env.GEMINI_API_KEY;
if (!PROXY_URL || !API_KEY) {
  console.error('GEMINI_PROXY_URL / GEMINI_API_KEY 未配置');
  process.exit(1);
}

const SYSTEM_PROMPT =
  '你是儿童陪伴机器人小可（K1）。用户是 5-12 岁孩子，叫他"指挥官"。语气温暖、活泼、有耐心。' +
  '日常聊天保持简短自然（30-50 字）；讲故事/科普可以讲完整（200-500 字，分段叙述）。';

const MODELS = [
  { name: 'gemini-2.5-flash-lite', maxTokens: 65535 },
  { name: 'gemini-2.5-flash', maxTokens: 65535 },
  { name: 'gemini-3.1-flash-lite-preview', maxTokens: 65535 },
  { name: 'gemini-3-flash-preview', maxTokens: 65535 },
  { name: 'MiniMax-M2.7-highspeed', maxTokens: 8192 },
];

const PROMPTS = [
  { id: 'daily', text: '小可你好，今天天气真不错！' },
  { id: 'story', text: '给我讲一个小猫去月亮上玩的故事，要完整有趣。' },
];

async function streamOne(model, userText) {
  const t0 = performance.now();
  let ttft = -1;
  let fullText = '';
  let chunkCount = 0;

  const res = await fetch(`${PROXY_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: model.name,
      stream: true,
      temperature: 0.6,
      max_tokens: model.maxTokens,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userText },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    return { error: `HTTP ${res.status}: ${errText.slice(0, 200)}` };
  }
  if (!res.body) return { error: 'no body' };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) continue;
      const chunk = line.slice(5).trim();
      if (!chunk || chunk === '[DONE]') continue;
      try {
        const evt = JSON.parse(chunk);
        const delta = evt.choices?.[0]?.delta?.content;
        if (!delta) continue;
        if (ttft < 0) ttft = performance.now() - t0;
        fullText += delta;
        chunkCount += 1;
      } catch {
        // ignore
      }
    }
  }

  const totalMs = performance.now() - t0;
  return { ttftMs: ttft, totalMs, fullText, chunkCount };
}

async function main() {
  console.log('=== LLM Benchmark ===\n');
  const results = [];
  for (const prompt of PROMPTS) {
    console.log(`\n📝 Prompt[${prompt.id}]: ${prompt.text}\n`);
    for (const model of MODELS) {
      process.stdout.write(`  ${model.name.padEnd(40)} `);
      try {
        const r = await streamOne(model, prompt.text);
        if (r.error) {
          console.log(`❌ ${r.error}`);
          results.push({ prompt: prompt.id, model: model.name, error: r.error });
          continue;
        }
        const charCount = r.fullText.length;
        const ttftS = (r.ttftMs / 1000).toFixed(2);
        const totalS = (r.totalMs / 1000).toFixed(2);
        console.log(`TTFT ${ttftS}s / total ${totalS}s / ${charCount}字 / ${r.chunkCount}chunks`);
        results.push({
          prompt: prompt.id,
          model: model.name,
          ttftMs: Math.round(r.ttftMs),
          totalMs: Math.round(r.totalMs),
          chars: charCount,
          chunks: r.chunkCount,
          preview: r.fullText.slice(0, 80),
          full: r.fullText,
        });
      } catch (err) {
        console.log(`💥 ${err.message}`);
        results.push({ prompt: prompt.id, model: model.name, error: err.message });
      }
    }
  }

  console.log('\n\n=== 完整输出 ===\n');
  for (const r of results) {
    if (r.error) continue;
    console.log(`\n--- [${r.prompt}] ${r.model} (${r.chars}字, TTFT ${r.ttftMs}ms / total ${r.totalMs}ms) ---`);
    console.log(r.full);
  }
}

main().catch((err) => {
  console.error('benchmark crashed:', err);
  process.exit(1);
});
