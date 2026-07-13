#!/usr/bin/env node
// apply-fixes.mjs — 把 qc-report.json 的修复建议全量应用到 batches-out/topics
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const report = JSON.parse(readFileSync(resolve(ROOT, 'qc-report.json'), 'utf8'));
const dir = resolve(ROOT, 'batches-out', 'topics');

// id → 批文件索引
const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
const fileData = new Map(files.map((f) => [f, JSON.parse(readFileSync(resolve(dir, f), 'utf8'))]));
const locate = new Map();
for (const [f, arr] of fileData) arr.forEach((t, i) => locate.set(t.id, { f, i }));

const zhSingle = /^[一-鿿]$/;
let applied = 0, skipped = [], singleDropped = 0;

for (const entry of report) {
  const loc = locate.get(entry.id);
  if (!loc) { skipped.push(`${entry.id}: 不在切片中`); continue; }
  const topic = fileData.get(loc.f)[loc.i];
  for (const issue of entry.issues) {
    const { field, fix } = issue;
    if (fix == null) { skipped.push(`${entry.id}/${field}: fix 为空`); continue; }
    if (field === 'evidence' || field === 'triggers') {
      if (!Array.isArray(fix)) { skipped.push(`${entry.id}/${field}: fix 非数组`); continue; }
      let val = fix;
      if (field === 'triggers') {
        const before = val.length;
        val = val.filter((x) => !zhSingle.test(x));
        singleDropped += before - val.length;
        if (val.length < 3) { skipped.push(`${entry.id}/triggers: 修复后不足3个，保留原值`); continue; }
      }
      if (field === 'evidence' && val.length !== topic.evidence.length)
        { skipped.push(`${entry.id}/evidence: fix 条数 ${val.length} != 原 ${topic.evidence.length}，保留原值`); continue; }
      topic[field] = val;
    } else {
      if (typeof fix !== 'string') { skipped.push(`${entry.id}/${field}: fix 非字符串`); continue; }
      if (field === 'assessmentPrompt' && topic.assessmentPrompt.includes('{{name}}') && !fix.includes('{{name}}'))
        { skipped.push(`${entry.id}/assessmentPrompt: fix 丢占位符，保留原值`); continue; }
      topic[field] = fix;
    }
    applied++;
  }
}

for (const [f, arr] of fileData) writeFileSync(resolve(dir, f), JSON.stringify(arr, null, 2));
console.log(JSON.stringify({ applied, singleCharDropped: singleDropped, skipped }, null, 2));
