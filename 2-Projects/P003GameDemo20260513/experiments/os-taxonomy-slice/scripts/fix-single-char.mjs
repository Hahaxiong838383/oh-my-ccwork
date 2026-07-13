#!/usr/bin/env node
// fix-single-char.mjs <batch号...> — 从 raw 输出提取 JSON，删掉单字中文触发词后重新过校验
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

for (const b of process.argv.slice(2)) {
  const raw = readFileSync(resolve(ROOT, 'batches-raw', 'topics', `batch-${b}.txt`), 'utf8');
  const blocks = [...raw.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  let text = null;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const t = blocks[i].trim();
    if (t.startsWith('[')) { text = t; break; }
  }
  const arr = JSON.parse(text);
  let dropped = [];
  for (const t of arr) {
    const before = t.triggers.length;
    t.triggers = t.triggers.filter((x) => !(/^[一-鿿]$/.test(x)));
    if (t.triggers.length < before) dropped.push(`${t.id}(-${before - t.triggers.length})`);
    if (t.triggers.length < 3) console.error(`⚠️ ${t.id} 删后仅剩 ${t.triggers.length} 个触发词`);
  }
  const fixed = resolve(ROOT, 'batches-raw', 'topics', `batch-${b}.fixed.txt`);
  writeFileSync(fixed, '```json\n' + JSON.stringify(arr, null, 2) + '\n```\n');
  // 重新过正式校验
  execFileSync('node', [resolve(ROOT, 'scripts', 'check-batch.mjs'),
    resolve(ROOT, 'batches', 'topics', `batch-${b}.json`), fixed,
    resolve(ROOT, 'batches-out', 'topics', `batch-${b}.json`)], { stdio: 'inherit' });
  console.log(`[batch-${b}] 单字清理: ${dropped.join(' ') || '无'}`);
}
