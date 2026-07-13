#!/usr/bin/env node
// expand-triggers.mjs — grok 全量补场景化触发词 → 校验合并进 slice-zh.json
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const en = JSON.parse(readFileSync(resolve(ROOT, 'slice-en.json'), 'utf8'));
const zh = JSON.parse(readFileSync(resolve(ROOT, 'slice-zh.json'), 'utf8'));
const tpl = readFileSync(resolve(ROOT, 'prompts', 'expand-triggers.md'), 'utf8');
const enById = new Map(en.topics.map((t) => [t.id, t]));

const BLACKLIST = new Set(['为什么','怎么办','是什么','什么样','真的吗','长什么样','不会做','东西','喜欢','老师','玩具','开心','睡觉','声音','朋友','下雨','石头','分类','公平','能量','死了','大声']);

// 防 LLM 抄错 id（mt__ 双下划线被 normalize 成单下划线，三连挂实锤）：批内用序号 idx 回传，脚本端映射
const items = zh.topics.map((t) => {
  const e = enById.get(t.id);
  return { id: t.id, en: { name: e.name, description: e.description, evidence: e.evidence }, existingTriggers: t.triggers };
});

const BATCH = 15;
const dirOut = resolve(ROOT, 'batches-expand');
mkdirSync(dirOut, { recursive: true });
const addById = new Map();

for (let b = 0; b * BATCH < items.length; b++) {
  const outFile = resolve(dirOut, `exp-${String(b).padStart(3, '0')}.json`);
  const batch = items.slice(b * BATCH, (b + 1) * BATCH);
  if (existsSync(outFile)) {
    for (const r of JSON.parse(readFileSync(outFile, 'utf8'))) addById.set(r.id, r.add);
    continue;
  }
  // 喂给 LLM 的批不含真实 id，只有 idx
  const llmBatch = batch.map((it, i) => ({ idx: i, en: it.en, existingTriggers: it.existingTriggers }));
  const prompt = tpl.replace('{{BATCH_JSON}}', JSON.stringify(llmBatch, null, 1));
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
      if (arr.length !== batch.length) throw new Error(`条数不符`);
      const mapped = arr.map((r, i) => {
        if (r.idx !== i) throw new Error(`idx 错位 @${i}`);
        if (!Array.isArray(r.add)) throw new Error(`add 非数组 @${i}`);
        return { id: batch[i].id, add: r.add };
      });
      writeFileSync(outFile, JSON.stringify(mapped, null, 2));
      for (const r of mapped) addById.set(r.id, r.add);
      console.log(`[exp-${b}] ✓`);
      done = true;
    } catch (e) { console.error(`[exp-${b}] 第${attempt}次失败: ${String(e.message).slice(0, 100)}`); }
  }
  if (!done) { console.error(`[exp-${b}] 三次失败`); process.exit(1); }
}

// 合并：规则过滤（黑名单/单字/长度/去重），每主题触发词硬上限 12
const zhSingle = /^[一-鿿]$/;
let added = 0, rejected = 0;
for (const t of zh.topics) {
  const add = addById.get(t.id) || [];
  const seen = new Set(t.triggers);
  for (const x of add) {
    const ok = typeof x === 'string' && !zhSingle.test(x) && !BLACKLIST.has(x)
      && ((/[一-鿿]/.test(x) && x.length >= 2 && x.length <= 8) || /^[A-Za-z][A-Za-z0-9 ]{0,5}$/.test(x))
      && !seen.has(x) && t.triggers.length < 12;
    if (ok) { t.triggers.push(x); seen.add(x); added++; } else rejected++;
  }
}
writeFileSync(resolve(ROOT, 'slice-zh.json'), JSON.stringify(zh, null, 2));
console.log(JSON.stringify({ 新增触发词: added, 规则拒绝: rejected, 主题均值: (zh.topics.reduce((s, t) => s + t.triggers.length, 0) / zh.topics.length).toFixed(1) }, null, 2));
