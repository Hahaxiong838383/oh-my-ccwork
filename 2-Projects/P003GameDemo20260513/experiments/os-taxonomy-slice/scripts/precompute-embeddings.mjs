#!/usr/bin/env node
// precompute-embeddings.mjs — 376 主题向量预计算（硅基流动 bge-large-zh-v1.5，passage 侧无前缀）
// 主题文本 = name + domain + description + 触发词拼接（提高与孩子口语的语义接触面）
// 输出 topics-embeddings.json: { model, dim, ids: [...], vectors: [[...], ...] }（与 slice-zh 顺序一致）
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const zh = JSON.parse(readFileSync(resolve(ROOT, 'slice-zh.json'), 'utf8'));
const KEY = process.env.SILICONFLOW_API_KEY;
if (!KEY) { console.error('缺 SILICONFLOW_API_KEY'); process.exit(1); }

const MODEL = 'BAAI/bge-large-zh-v1.5';
const texts = zh.topics.map((t) =>
  `${t.name}。${t.domain}。${t.description} ${t.triggers.join(' ')}`.slice(0, 480)
);

const BATCH = 32;
const vectors = [];
for (let i = 0; i < texts.length; i += BATCH) {
  const batch = texts.slice(i, i + BATCH);
  let ok = false;
  for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
    try {
      const res = await fetch('https://api.siliconflow.cn/v1/embeddings', {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, input: batch }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
      const data = await res.json();
      if (data.data.length !== batch.length) throw new Error('条数不符');
      // 归一化（点积即余弦）
      for (const d of data.data.sort((a, b) => a.index - b.index)) {
        const v = d.embedding;
        const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
        vectors.push(v.map((x) => +(x / norm).toFixed(6)));
      }
      ok = true;
      console.log(`[${i}-${i + batch.length}] ✓`);
    } catch (e) {
      console.error(`[${i}] 第${attempt}次: ${e.message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (!ok) process.exit(1);
}

writeFileSync(resolve(ROOT, 'topics-embeddings.json'), JSON.stringify({
  model: MODEL, dim: vectors[0].length, count: vectors.length,
  ids: zh.topics.map((t) => t.id), vectors,
}));
console.log(`完成: ${vectors.length} 向量 × ${vectors[0].length} 维`);
