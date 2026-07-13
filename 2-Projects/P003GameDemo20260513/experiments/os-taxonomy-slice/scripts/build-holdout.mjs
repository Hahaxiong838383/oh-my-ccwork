#!/usr/bin/env node
// build-holdout.mjs — holdout 验证集：从首轮未覆盖主题抽 50 个造新话语（终检防过拟合）
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const en = JSON.parse(readFileSync(resolve(ROOT, 'slice-en.json'), 'utf8'));
const firstRound = new Set(JSON.parse(readFileSync(resolve(ROOT, 'testset', 'positives.json'), 'utf8')).map((c) => c.id));

const pool = en.topics.filter((t) => !firstRound.has(t.id));
let seed = 20260714; // 不同种子
const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const idx = new Set();
while (idx.size < 50) idx.add(Math.floor(rand() * pool.length));
const picked = [...idx].map((i) => pool[i]);

const PROMPT_HEAD = readFileSync(resolve(ROOT, 'scripts', 'build-testset.mjs'), 'utf8')
  .match(/const PROMPT_HEAD = `([\s\S]*?)`;/)[1];

const dirOut = resolve(ROOT, 'testset');
mkdirSync(dirOut, { recursive: true });
const BATCH = 25;
const cases = [];
for (let b = 0; b * BATCH < picked.length; b++) {
  const outFile = resolve(dirOut, `holdout-batch-${b}.json`);
  const batch = picked.slice(b * BATCH, (b + 1) * BATCH).map((t, i) => ({
    id: t.id,
    style: (b * BATCH + i) % 2 === 0 ? 'direct' : 'indirect',
    en: { name: t.name, description: t.description, ageRange: `${t.ageRangeStart}-${t.ageRangeEnd}` },
  }));
  if (existsSync(outFile)) { cases.push(...JSON.parse(readFileSync(outFile, 'utf8'))); continue; }
  const prompt = PROMPT_HEAD + JSON.stringify(batch, null, 1);
  let done = false;
  for (let attempt = 1; attempt <= 3 && !done; attempt++) {
    try {
      const raw = execFileSync('omp', ['-p', '--model', 'xai-oauth/grok-4.5', '--thinking', 'low',
        '--auto-approve', '--no-extensions', '--no-skills', '--no-rules', prompt], {
        encoding: 'utf8', timeout: 300000,
        env: { ...process.env, PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}` },
      });
      const blocks = [...raw.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
      let text = null;
      for (let i = blocks.length - 1; i >= 0; i--) { const t = blocks[i].trim(); if (t.startsWith('[')) { text = t; break; } }
      const arr = JSON.parse(text);
      if (arr.length !== batch.length) throw new Error('条数不符');
      for (let i = 0; i < arr.length; i++) if (arr[i].id !== batch[i].id) throw new Error(`id 错位`);
      writeFileSync(outFile, JSON.stringify(arr, null, 2));
      cases.push(...arr);
      console.log(`[holdout-${b}] ✓`);
      done = true;
    } catch (e) { console.error(`[holdout-${b}] 第${attempt}次失败: ${String(e.message).slice(0, 100)}`); }
  }
  if (!done) process.exit(1);
}
writeFileSync(resolve(dirOut, 'holdout.json'), JSON.stringify(cases, null, 2));
console.log(`holdout 共 ${cases.length} 条`);
