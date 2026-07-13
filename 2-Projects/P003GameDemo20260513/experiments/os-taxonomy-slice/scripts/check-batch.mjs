#!/usr/bin/env node
// check-batch.mjs <原批次.json> <omp原始输出.txt> <净化输出.json> [--reasons]
// 从 omp 输出提取 ```json 块并严格校验；通过则写净化 JSON，失败 exit 1
import { readFileSync, writeFileSync } from 'node:fs';

const [, , srcPath, rawPath, outPath, mode] = process.argv;
const isReasons = mode === '--reasons';

const src = JSON.parse(readFileSync(srcPath, 'utf8'));
const raw = readFileSync(rawPath, 'utf8');

// 提取最后一个 ```json ... ``` 块（模型有时会先复述示例）；没有代码块则尝试整体截取 [ ... ]
let jsonText = null;
const blocks = [...raw.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
for (let i = blocks.length - 1; i >= 0; i--) {
  const b = blocks[i].trim();
  if (b.startsWith('[')) { jsonText = b; break; }
}
if (!jsonText) {
  const s = raw.indexOf('['), e = raw.lastIndexOf(']');
  if (s !== -1 && e > s) jsonText = raw.slice(s, e + 1);
}
if (!jsonText) { console.error('FAIL: 输出中未找到 JSON 数组'); process.exit(1); }

let out;
try { out = JSON.parse(jsonText); } catch (e) {
  console.error(`FAIL: JSON 解析失败 — ${e.message}`); process.exit(1);
}
if (!Array.isArray(out)) { console.error('FAIL: 不是数组'); process.exit(1); }
if (out.length !== src.length) {
  console.error(`FAIL: 条数不符 ${out.length} != ${src.length}`); process.exit(1);
}

const errs = [];
const zhRe = /[一-鿿]/;
for (let i = 0; i < src.length; i++) {
  const s = src[i], o = out[i];
  const tag = isReasons ? s.key : s.id;
  if (isReasons) {
    if (o.key !== s.key) errs.push(`${tag}: key 不符`);
    if (typeof o.reason !== 'string' || !zhRe.test(o.reason)) errs.push(`${tag}: reason 缺失或非中文`);
    continue;
  }
  if (o.id !== s.id) { errs.push(`第${i}条: id 不符 ${o.id} != ${s.id}`); continue; }
  for (const f of ['name', 'description', 'assessmentPrompt']) {
    if (typeof o[f] !== 'string' || !zhRe.test(o[f])) errs.push(`${tag}: ${f} 缺失或非中文`);
  }
  if (!Array.isArray(o.evidence) || o.evidence.length !== s.evidence.length)
    errs.push(`${tag}: evidence 条数不符`);
  else if (o.evidence.some((e) => !zhRe.test(e))) errs.push(`${tag}: evidence 含非中文条目`);
  if (!Array.isArray(o.triggers) || o.triggers.length < 3 || o.triggers.length > 8)
    errs.push(`${tag}: triggers 数量 ${o.triggers?.length} 不在 3-8`);
  else {
    for (const t of o.triggers) {
      // 合法：中文/混合 2-8 字，或纯英文专名缩写 1-6 字符（AI/Siri/NPC 孩子真会说）
      const isZhOk = typeof t === 'string' && zhRe.test(t) && t.length >= 2 && t.length <= 8;
      const isEnOk = typeof t === 'string' && /^[A-Za-z][A-Za-z0-9 ]{0,5}$/.test(t);
      if (!isZhOk && !isEnOk)
        errs.push(`${tag}: 触发词「${t}」不合规(中文2-8字或英文专名1-6字符)`);
    }
  }
  if (s.assessmentPrompt.includes('{{name}}') && !o.assessmentPrompt.includes('{{name}}'))
    errs.push(`${tag}: assessmentPrompt 丢失 {{name}} 占位符`);
}

if (errs.length) {
  console.error(`FAIL: ${errs.length} 处问题\n` + errs.slice(0, 12).join('\n'));
  process.exit(1);
}
writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`OK: ${out.length} 条通过`);
