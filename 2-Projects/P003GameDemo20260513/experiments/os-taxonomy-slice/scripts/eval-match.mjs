#!/usr/bin/env node
// eval-match.mjs — P1 命中率评估：复刻 curriculum-kg.ts 匹配逻辑跑 slice-zh
// 指标：召回(首命中id对/域对两级) + 误报率(负样本任何命中) + 延迟 P95
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const zh = JSON.parse(readFileSync(resolve(ROOT, 'slice-zh.json'), 'utf8'));
const posFile = process.argv[2] || resolve(ROOT, 'testset', 'positives.json'); // 可传 holdout.json
const positives = JSON.parse(readFileSync(posFile, 'utf8'));
const negatives = JSON.parse(readFileSync(resolve(ROOT, 'testset', 'negatives.json'), 'utf8'));

const byId = new Map(zh.topics.map((t) => [t.id, t]));

// ==== 匹配器 v2：词表全扫 → 候选集按 (命中词长, centrality) 打分择优 ====
// v1 是现网原版全局长词优先首命中；v2 改进消歧：同候选内更长命中词 > 更高 centrality
const entries = [];
const centrality = new Map(zh.topics.map((t) => [t.id, t.centrality]));
for (const t of zh.topics) {
  entries.push({ term: t.name, id: t.id });
  for (const tr of t.triggers) entries.push({ term: tr, id: t.id });
}
entries.sort((a, b) => b.term.length - a.term.length);

function matchAll(text) {
  const hits = new Map();
  for (const e of entries) {
    if (text.includes(e.term)) {
      const prev = hits.get(e.id);
      if (!prev || e.term.length > prev.length) hits.set(e.id, e.term);
    }
  }
  return hits;
}
// 消歧回退 v1（现网原版全局长词优先首命中）：实测 21 vs 16 优于 centrality 打分版
function matchFirst(text) {
  for (const e of entries) if (text.includes(e.term)) return e;
  return null;
}

// ==== 正样本 ====
const posResults = [];
for (const c of positives) {
  const first = matchFirst(c.utterance);
  const all = matchAll(c.utterance);
  const expected = byId.get(c.id);
  const firstTopic = first ? byId.get(first.id) : null;
  const idHitFirst = first?.id === c.id;
  const idHitAny = all.has(c.id);
  const domainHitFirst = firstTopic && expected && firstTopic.domain === expected.domain;
  posResults.push({
    id: c.id, style: c.style, utterance: c.utterance,
    expectedName: expected?.name, firstHit: first ? `${firstTopic.name}(${first.term})` : null,
    idHitFirst, idHitAny, domainHitFirst: !!domainHitFirst, anyHit: all.size > 0,
  });
}

const pct = (n, d) => `${((n / d) * 100).toFixed(1)}%`;
const stat = (arr) => ({
  n: arr.length,
  idFirst: pct(arr.filter((r) => r.idHitFirst).length, arr.length),
  idAny: pct(arr.filter((r) => r.idHitAny).length, arr.length),
  domainFirst: pct(arr.filter((r) => r.idHitFirst || r.domainHitFirst).length, arr.length),
  anyHit: pct(arr.filter((r) => r.anyHit).length, arr.length),
});

// ==== 负样本（grade: hard=真不该触发 / gray=产品可接受触发，误报率只算 hard） ====
const negResults = negatives.map((c) => {
  const first = matchFirst(c.utterance);
  return { cat: c.cat, grade: c.grade ?? 'hard', utterance: c.utterance, hit: first ? `${byId.get(first.id).name}(${first.term})` : null };
});
const hardNegs = negResults.filter((r) => r.grade === 'hard');
const negHits = hardNegs.filter((r) => r.hit);
const grayHits = negResults.filter((r) => r.grade === 'gray' && r.hit);

// ==== 延迟：全部 150 条 × 重复到 ≥2000 次取 P95 ====
const texts = [...positives.map((c) => c.utterance), ...negatives.map((c) => c.utterance)];
const times = [];
for (let round = 0; round < Math.ceil(2000 / texts.length); round++) {
  for (const tx of texts) {
    const t0 = process.hrtime.bigint();
    matchFirst(tx);
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
}
times.sort((a, b) => a - b);
const p50 = times[Math.floor(times.length * 0.5)].toFixed(3);
const p95 = times[Math.floor(times.length * 0.95)].toFixed(3);

const report = {
  正样本: {
    总召回: stat(posResults),
    直接档: stat(posResults.filter((r) => r.style === 'direct')),
    间接档: stat(posResults.filter((r) => r.style === 'indirect')),
  },
  负样本: {
    hard: { n: hardNegs.length, 误报数: negHits.length, 误报率: pct(negHits.length, hardNegs.length), 明细: negHits },
    gray可接受触发: { n: negResults.filter((r) => r.grade === 'gray').length, 触发数: grayHits.length, 明细: grayHits.map((r) => `${r.utterance} → ${r.hit}`) },
  },
  延迟ms: { p50, p95, 词表规模: entries.length
  },
  验收线: { 召回_首命中id: '≥60%', 误报: '≤5%', P95: '<10ms' },
};
writeFileSync(resolve(ROOT, 'eval-report.json'), JSON.stringify({ report, posResults }, null, 2));
console.log(JSON.stringify(report, null, 2));
