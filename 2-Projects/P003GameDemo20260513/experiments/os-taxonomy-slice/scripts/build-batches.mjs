#!/usr/bin/env node
// build-batches.mjs — 把 slice-en.json 切成翻译批次（主题批 + reason 批）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const slice = JSON.parse(readFileSync(resolve(ROOT, 'slice-en.json'), 'utf8'));

const TOPIC_BATCH = 15;
const REASON_BATCH = 60;

const dirTopics = resolve(ROOT, 'batches', 'topics');
const dirReasons = resolve(ROOT, 'batches', 'reasons');
mkdirSync(dirTopics, { recursive: true });
mkdirSync(dirReasons, { recursive: true });

// 主题批：只带翻译需要的字段，省 token
let tb = 0;
for (let i = 0; i < slice.topics.length; i += TOPIC_BATCH) {
  const batch = slice.topics.slice(i, i + TOPIC_BATCH).map((t) => ({
    id: t.id,
    subject: t.subject,
    domain: t.domain,
    ageRange: `${t.ageRangeStart}-${t.ageRangeEnd}`,
    name: t.name,
    description: t.description,
    evidence: t.evidence,
    assessmentPrompt: t.assessmentPrompt,
  }));
  writeFileSync(
    resolve(dirTopics, `batch-${String(tb).padStart(3, '0')}.json`),
    JSON.stringify(batch, null, 2)
  );
  tb++;
}

// reason 批：id 对 = `${topicId}→${prerequisiteId}`
let rb = 0;
for (let i = 0; i < slice.dependencies.length; i += REASON_BATCH) {
  const batch = slice.dependencies.slice(i, i + REASON_BATCH).map((d) => ({
    key: `${d.topicId}→${d.prerequisiteId}`,
    reason: d.reason,
  }));
  writeFileSync(
    resolve(dirReasons, `batch-${String(rb).padStart(3, '0')}.json`),
    JSON.stringify(batch, null, 2)
  );
  rb++;
}

console.log(`topics: ${tb} batches × ≤${TOPIC_BATCH} · reasons: ${rb} batches × ≤${REASON_BATCH}`);
