#!/usr/bin/env node
// sample-review.mjs — 从终版切片随机抽 30 条生成中英对照抽检包（固定种子可复现）
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const en = JSON.parse(readFileSync(resolve(ROOT, 'slice-en.json'), 'utf8'));
const zh = JSON.parse(readFileSync(resolve(ROOT, 'slice-zh.json'), 'utf8'));
const enById = new Map(en.topics.map((t) => [t.id, t]));

// 固定种子的 LCG，保证抽样可复现
let seed = 20260713;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const idx = new Set();
while (idx.size < 30) idx.add(Math.floor(rand() * zh.topics.length));

const lines = [
  '# 小可陪伴域切片 · 30 条随机抽检包（seed=20260713 可复现）',
  '',
  `> 数据：${zh.topicCount} 主题 / ${zh.edgeCount} 边 · grok-4.5 主翻 + codex 质检修复 97 处`,
  '> 审法：重点看 ①中文自然度（像不像给孩子/家长说的话）②知识保真 ③触发词是否孩子口语。',
  '> 验收线：不合格 < 3 条（10%）。',
  '',
];

let n = 0;
for (const i of [...idx].sort((a, b) => a - b)) {
  const t = zh.topics[i];
  const e = enById.get(t.id);
  n++;
  lines.push(`## ${n}. ${t.name}（${t.subject} · ${t.ageRangeStart}-${t.ageRangeEnd}岁 · \`${t.id}\`）`);
  lines.push('');
  lines.push(`**EN**: ${e.name} — ${e.description}`);
  lines.push('');
  lines.push(`**中文描述**: ${t.description}`);
  lines.push('');
  lines.push(`**掌握证据**:`);
  t.evidence.forEach((ev, j) => lines.push(`  ${j + 1}. ${ev}（EN: ${e.evidence[j] ?? '—'}）`));
  lines.push('');
  lines.push(`**评估提问**: ${t.assessmentPrompt}`);
  lines.push(`  （EN: ${e.assessmentPrompt}）`);
  lines.push('');
  lines.push(`**触发词**: ${t.triggers.join(' · ')}`);
  lines.push('');
  lines.push('---');
  lines.push('');
}

writeFileSync(resolve(ROOT, 'sample-review-30.md'), lines.join('\n'));
console.log(`抽检包已生成: sample-review-30.md（${n} 条）`);
