#!/usr/bin/env node
// merge-validate.mjs — 合并翻译批次 → slice-zh.json，并做切片级校验
// 校验：覆盖完整性(376主题/594边全有译文) + 引用完整性 + 触发词跨主题冲突
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const en = JSON.parse(readFileSync(resolve(ROOT, 'slice-en.json'), 'utf8'));

const loadDir = (dir) => {
  const out = [];
  for (const f of readdirSync(dir).sort()) {
    if (f.endsWith('.json')) out.push(...JSON.parse(readFileSync(resolve(dir, f), 'utf8')));
  }
  return out;
};

const zhTopics = loadDir(resolve(ROOT, 'batches-out', 'topics'));
const zhReasons = loadDir(resolve(ROOT, 'batches-out', 'reasons'));

const errors = [];
const zhById = new Map(zhTopics.map((t) => [t.id, t]));
const zhByKey = new Map(zhReasons.map((r) => [r.key, r]));

// 1. 覆盖完整性
for (const t of en.topics) if (!zhById.has(t.id)) errors.push(`主题 ${t.id}(${t.name}) 缺译文`);
for (const d of en.dependencies) {
  const k = `${d.topicId}→${d.prerequisiteId}`;
  if (!zhByKey.has(k)) errors.push(`边 ${k} 缺 reason 译文`);
}
if (zhTopics.length !== en.topics.length)
  errors.push(`主题译文数 ${zhTopics.length} != ${en.topics.length}`);

// 2. 触发词跨主题冲突：同一触发词命中过多主题 = 过泛，会乱注入
const trigMap = new Map();
for (const t of zhTopics) {
  for (const tr of t.triggers || []) {
    if (!trigMap.has(tr)) trigMap.set(tr, []);
    trigMap.get(tr).push(t.id);
  }
}
const conflicts = [...trigMap.entries()]
  .filter(([, ids]) => ids.length >= 3)
  .sort((a, b) => b[1].length - a[1].length);

// 3. 组装最终数据（中英对照 + 运行时字段）
const topics = en.topics.map((t) => {
  const zh = zhById.get(t.id) || {};
  return {
    id: t.id,
    type: t.type,
    subject: t.subject,
    domain: t.domain,
    name: zh.name ?? null,
    nameEn: t.name,
    description: zh.description ?? null,
    ageRangeStart: t.ageRangeStart,
    ageRangeEnd: t.ageRangeEnd,
    centrality: t.centrality,
    evidence: zh.evidence ?? [],
    assessmentPrompt: zh.assessmentPrompt ?? null,
    triggers: zh.triggers ?? [],
  };
});
const dependencies = en.dependencies.map((d) => ({
  topicId: d.topicId,
  prerequisiteId: d.prerequisiteId,
  strength: d.strength,
  reason: zhByKey.get(`${d.topicId}→${d.prerequisiteId}`)?.reason ?? null,
}));

const out = {
  version: 'xiaoke-slice-zh-v0.1',
  source: en.source,
  license: en.license,
  rule: en.rule,
  topicCount: topics.length,
  edgeCount: dependencies.length,
  topics,
  dependencies,
};
writeFileSync(resolve(ROOT, 'slice-zh.json'), JSON.stringify(out, null, 2));

console.log(JSON.stringify({
  topics: topics.length,
  edges: dependencies.length,
  errors: errors.length,
  triggerTotal: trigMap.size,
  conflictTriggers: conflicts.slice(0, 15).map(([tr, ids]) => `${tr}(${ids.length})`),
}, null, 2));
if (errors.length) { console.error(errors.slice(0, 20).join('\n')); process.exit(1); }
