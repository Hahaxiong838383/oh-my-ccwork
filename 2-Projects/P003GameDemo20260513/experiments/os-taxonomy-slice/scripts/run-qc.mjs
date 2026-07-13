#!/usr/bin/env node
// run-qc.mjs — codex 全量质检：英中对照分批 → omp codex 网关链 → 汇总问题清单
// 用法: node run-qc.mjs [起始批次号]
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const en = JSON.parse(readFileSync(resolve(ROOT, 'slice-en.json'), 'utf8'));
// 直接读主题译文批次（不等 reasons 合并，qc 只审主题）
const zhDir = resolve(ROOT, 'batches-out', 'topics');
const zhTopicsRaw = readdirSync(zhDir).sort().filter((f) => f.endsWith('.json'))
  .flatMap((f) => JSON.parse(readFileSync(resolve(zhDir, f), 'utf8')));
const enMeta = new Map(en.topics.map((t) => [t.id, t]));
const zh = { topics: zhTopicsRaw.map((t) => ({ ...t, ageRangeStart: enMeta.get(t.id)?.ageRangeStart, ageRangeEnd: enMeta.get(t.id)?.ageRangeEnd })) };
const tpl = readFileSync(resolve(ROOT, 'prompts', 'qc-topics.md'), 'utf8');

const enById = new Map(en.topics.map((t) => [t.id, t]));
const BATCH = 25;
const outDir = resolve(ROOT, 'qc-out');
mkdirSync(outDir, { recursive: true });

// codex 降级链（engine-ops 2026-06-16 主次序）
const MODELS = ['codex-api2/gpt-5.5', 'codex-api3/gpt-5.5', 'codex-api/gpt-5.5', 'openai-codex/gpt-5.4'];

const pairs = zh.topics.map((t) => {
  const e = enById.get(t.id);
  return {
    id: t.id, ageRange: `${t.ageRangeStart}-${t.ageRangeEnd}`,
    en: { name: e.name, description: e.description, evidence: e.evidence, assessmentPrompt: e.assessmentPrompt },
    zh: { name: t.name, description: t.description, evidence: t.evidence, assessmentPrompt: t.assessmentPrompt, triggers: t.triggers },
  };
});

const start = parseInt(process.argv[2] || '0', 10);
const totalBatches = Math.ceil(pairs.length / BATCH);
const allIssues = [];
let failedBatches = [];

for (let b = start; b < totalBatches; b++) {
  const outFile = resolve(outDir, `qc-${String(b).padStart(3, '0')}.json`);
  if (existsSync(outFile)) { allIssues.push(...JSON.parse(readFileSync(outFile, 'utf8'))); continue; }
  const batch = pairs.slice(b * BATCH, (b + 1) * BATCH);
  const prompt = tpl.replace('{{BATCH_JSON}}', JSON.stringify(batch, null, 1));
  let done = false;
  for (const model of MODELS) {
    try {
      const raw = execFileSync('omp', ['-p', '--model', model, '--thinking', 'medium',
        '--auto-approve', '--no-extensions', '--no-skills', '--no-rules', prompt], {
        encoding: 'utf8', timeout: 420000,
        env: { ...process.env, PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}` },
      });
      const blocks = [...raw.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
      let text = null;
      for (let i = blocks.length - 1; i >= 0; i--) {
        const t = blocks[i].trim();
        if (t.startsWith('[')) { text = t; break; }
      }
      if (!text) { const s = raw.indexOf('['), e2 = raw.lastIndexOf(']'); if (s !== -1 && e2 > s) text = raw.slice(s, e2 + 1); }
      const issues = JSON.parse(text ?? 'null');
      if (!Array.isArray(issues)) throw new Error('非数组');
      for (const it of issues) if (!enById.has(it.id)) throw new Error(`未知 id ${it.id}`);
      writeFileSync(outFile, JSON.stringify(issues, null, 2));
      allIssues.push(...issues);
      console.log(`[qc-${b}] ✓ ${model} → ${issues.length} 条问题`);
      done = true; break;
    } catch (e) {
      console.error(`[qc-${b}] ${model} 失败: ${String(e.message).slice(0, 120)}，降级`);
    }
  }
  if (!done) failedBatches.push(b);
}

writeFileSync(resolve(ROOT, 'qc-report.json'), JSON.stringify(allIssues, null, 2));
const byLevel = {};
for (const t of allIssues) for (const i of t.issues) byLevel[i.level] = (byLevel[i.level] || 0) + 1;
console.log(JSON.stringify({
  batches: totalBatches, failedBatches,
  topicsWithIssues: allIssues.length, issuesByLevel: byLevel,
  issueRate: `${((allIssues.length / pairs.length) * 100).toFixed(1)}%`,
}, null, 2));
process.exit(failedBatches.length ? 1 : 0);
