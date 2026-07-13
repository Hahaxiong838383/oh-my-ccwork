#!/usr/bin/env node
// extract-slice.mjs — 从 os-taxonomy 提取小可低龄陪伴域切片
// 规则（川哥拍板 2026-07-13）：ageRangeStart <= 8 且 subject ∈ 五个陪伴域学科
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TAXONOMY = resolve(ROOT, '..', 'os-taxonomy', 'data');

const SUBJECTS = new Set([
  'Life Skills',
  'Personal & Social Development',
  'Learning to Learn',
  'Science',
  'Computing',
]);
const MAX_AGE_START = 8;

const topicsFile = JSON.parse(readFileSync(resolve(TAXONOMY, 'topics.json'), 'utf8'));
const depsFile = JSON.parse(readFileSync(resolve(TAXONOMY, 'dependencies.json'), 'utf8'));

const slice = topicsFile.topics.filter(
  (t) => t.ageRangeStart <= MAX_AGE_START && SUBJECTS.has(t.subject)
);
const sliceIds = new Set(slice.map((t) => t.id));

// 只收两端都在切片内的边（跨界边意味着先修在切片外，护栏拿不到，记数但不收）
const inner = [];
let crossing = 0;
for (const d of depsFile.dependencies) {
  const a = sliceIds.has(d.topicId);
  const b = sliceIds.has(d.prerequisiteId);
  if (a && b) inner.push(d);
  else if (a || b) crossing++;
}

// 翻译负载字段统计（估 token 用）
let charCount = 0;
for (const t of slice) {
  charCount += t.name.length + t.description.length + t.assessmentPrompt.length;
  for (const e of t.evidence) charCount += e.length;
}
for (const d of inner) charCount += d.reason.length;

const out = {
  version: 'xiaoke-slice-v0.1',
  source: 'withmarbleapp/os-taxonomy v1 (2026-07-08)',
  license:
    'Marble Skill Taxonomy © Generative Spark, Inc. · ODbL 1.0 (database) + CC BY-SA 4.0 (content) · 中文译版按 ODbL/CC BY-SA share-alike 开放',
  rule: `ageRangeStart <= ${MAX_AGE_START} && subject in [${[...SUBJECTS].join(', ')}]`,
  topicCount: slice.length,
  edgeCount: inner.length,
  topics: slice,
  dependencies: inner,
};

mkdirSync(resolve(ROOT), { recursive: true });
writeFileSync(resolve(ROOT, 'slice-en.json'), JSON.stringify(out, null, 2));

const bySubject = {};
for (const t of slice) bySubject[t.subject] = (bySubject[t.subject] || 0) + 1;
console.log(JSON.stringify({
  topics: slice.length,
  innerEdges: inner.length,
  crossingEdgesDropped: crossing,
  bySubject,
  translatableChars: charCount,
}, null, 2));
