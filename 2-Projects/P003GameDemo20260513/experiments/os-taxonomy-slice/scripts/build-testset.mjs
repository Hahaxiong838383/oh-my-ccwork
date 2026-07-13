#!/usr/bin/env node
// build-testset.mjs — 分层抽 100 主题，grok 基于英文原文造孩子话语（direct/indirect 两档）
// 防近亲繁殖：输入只给英文 name+description，绝不给中文译名/触发词
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const en = JSON.parse(readFileSync(resolve(ROOT, 'slice-en.json'), 'utf8'));

// 分层配额（总 100）
const QUOTA = { Science: 60, 'Personal & Social Development': 15, 'Life Skills': 10, 'Learning to Learn': 8, Computing: 7 };

let seed = 20260713;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;

const picked = [];
for (const [subj, q] of Object.entries(QUOTA)) {
  const pool = en.topics.filter((t) => t.subject === subj);
  const idx = new Set();
  while (idx.size < Math.min(q, pool.length)) idx.add(Math.floor(rand() * pool.length));
  for (const i of idx) picked.push(pool[i]);
}
console.log(`抽样 ${picked.length} 主题`);

const PROMPT_HEAD = `# 任务：模拟中国孩子对 AI 语音伙伴说的话

你是儿童语言专家。下面每个条目是一个英文知识点（面向 5-8 岁）。为每个知识点写一句**中国孩子（5-8 岁）对 AI 语音伙伴"小可"说的话**，孩子在生活场景中自然聊到了这个话题。

规则：
1. 真实孩子口吻：短句、口语、可带语气词（"呀""诶""为什么"），8-30 字。是 ASR 转写风格（无标点也行，但要通顺）。
2. style 交替："direct"（话里可以出现该话题的日常说法）和 "indirect"（**禁止出现知识点名称的直译词**，纯场景化引出，比如知识点是"影子的形成"，indirect 可以是"我走到哪里它就跟到哪里 太阳一躲起来它就不见了"）。输入里我已给每条指定 style。
3. 话语必须是孩子视角的真实生活场景（幼儿园/家里/公园/吃饭/玩耍），不是背书。
4. 只输出 JSON 数组包在 \`\`\`json 里：{ "id": "...", "style": "...", "utterance": "..." }，数量顺序 id 与输入一致。

## 输入

`;

const dirOut = resolve(ROOT, 'testset');
mkdirSync(dirOut, { recursive: true });

const BATCH = 20;
const cases = [];
for (let b = 0; b * BATCH < picked.length; b++) {
  const outFile = resolve(dirOut, `pos-batch-${b}.json`);
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
      if (arr.length !== batch.length) throw new Error(`条数 ${arr.length}!=${batch.length}`);
      for (let i = 0; i < arr.length; i++) {
        if (arr[i].id !== batch[i].id) throw new Error(`id 错位 @${i}`);
        if (!arr[i].utterance || !/[一-鿿]/.test(arr[i].utterance)) throw new Error(`话语无效 @${arr[i].id}`);
      }
      writeFileSync(outFile, JSON.stringify(arr, null, 2));
      cases.push(...arr);
      console.log(`[pos-${b}] ✓ ${arr.length} 条`);
      done = true;
    } catch (e) { console.error(`[pos-${b}] 第${attempt}次失败: ${String(e.message).slice(0, 100)}`); }
  }
  if (!done) { console.error(`[pos-${b}] 三次失败，退出`); process.exit(1); }
}

writeFileSync(resolve(dirOut, 'positives.json'), JSON.stringify(cases, null, 2));
console.log(`正样本总计 ${cases.length} 条 → testset/positives.json`);
