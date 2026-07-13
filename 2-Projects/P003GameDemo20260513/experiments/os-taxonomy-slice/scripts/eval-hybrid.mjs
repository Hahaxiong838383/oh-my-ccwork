#!/usr/bin/env node
// eval-hybrid.mjs — L1 触发词 + L2 语义层混检离线评估，扫阈值定参
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const zh = JSON.parse(readFileSync(resolve(ROOT, 'slice-zh.json'), 'utf8'));
const emb = JSON.parse(readFileSync(resolve(ROOT, 'topics-embeddings.json'), 'utf8'));
const holdout = JSON.parse(readFileSync(resolve(ROOT, 'testset', 'holdout.json'), 'utf8'));
const negatives = JSON.parse(readFileSync(resolve(ROOT, 'testset', 'negatives.json'), 'utf8'));
const KEY = process.env.SILICONFLOW_API_KEY;
const QUERY_PREFIX = '为这个句子生成表示以用于检索相关文章：';

const byId = new Map(zh.topics.map((t) => [t.id, t]));
const idxOf = new Map(emb.ids.map((id, i) => [id, i]));

// L1 触发词层（现网 v1 逻辑）
const entries = [];
for (const t of zh.topics) {
  entries.push({ term: t.name, id: t.id });
  for (const tr of t.triggers) entries.push({ term: tr, id: t.id });
}
entries.sort((a, b) => b.term.length - a.term.length);
const l1 = (text) => { for (const e of entries) if (text.includes(e.term)) return e.id; return null; };

// 批量算 query 向量
async function embedBatch(texts) {
  const out = [];
  for (let i = 0; i < texts.length; i += 32) {
    const res = await fetch('https://api.siliconflow.cn/v1/embeddings', {
      method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: emb.model, input: texts.slice(i, i + 32).map((t) => QUERY_PREFIX + t) }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    for (const d of data.data.sort((a, b) => a.index - b.index)) {
      const norm = Math.sqrt(d.embedding.reduce((s, x) => s + x * x, 0));
      out.push(d.embedding.map((x) => x / norm));
    }
  }
  return out;
}

const l2top = (qv) => {
  let bi = -1, bs = -Infinity;
  for (let i = 0; i < emb.vectors.length; i++) {
    let s = 0;
    const v = emb.vectors[i];
    for (let d = 0; d < v.length; d++) s += v[d] * qv[d];
    if (s > bs) { bs = s; bi = i; }
  }
  return { id: emb.ids[bi], score: bs };
};

console.log('计算 query 向量（holdout 50 + 负样本 49）…');
const posVecs = await embedBatch(holdout.map((c) => c.utterance));
const negVecs = await embedBatch(negatives.map((c) => c.utterance));

const posEval = holdout.map((c, i) => {
  const l1Hit = l1(c.utterance);
  const l2Hit = l2top(posVecs[i]);
  return { ...c, l1Hit, l2Hit };
});
const negEval = negatives.map((c, i) => ({ ...c, l1Hit: l1(c.utterance), l2Hit: l2top(negVecs[i]) }));

const pct = (n, d) => `${((n / d) * 100).toFixed(0)}%`;
console.log('\n阈值 | 混检召回id | 混检域正确 | 间接档id | hard误报 | L2贡献(在L1空手时救回)');
for (const TH of [0.35, 0.4, 0.45, 0.5, 0.55, 0.6]) {
  const hybrid = (r) => r.l1Hit ?? (r.l2Hit.score >= TH ? r.l2Hit.id : null);
  let idHit = 0, domHit = 0, indirectId = 0, indirectN = 0, l2saved = 0;
  for (const r of posEval) {
    const h = hybrid(r);
    const exp = byId.get(r.id);
    if (h === r.id) idHit++;
    if (h && (h === r.id || byId.get(h)?.domain === exp.domain)) domHit++;
    if (r.style === 'indirect') { indirectN++; if (h === r.id) indirectId++; }
    if (!r.l1Hit && r.l2Hit.score >= TH && r.l2Hit.id === r.id) l2saved++;
  }
  const hardNegs = negEval.filter((r) => r.grade === 'hard');
  const fp = hardNegs.filter((r) => hybrid(r) !== null).length;
  console.log(`${TH} | ${pct(idHit, posEval.length)} | ${pct(domHit, posEval.length)} | ${pct(indirectId, indirectN)} | ${fp}/${hardNegs.length}=${pct(fp, hardNegs.length)} | +${l2saved}`);
}

writeFileSync(resolve(ROOT, 'eval-hybrid-detail.json'), JSON.stringify({ posEval: posEval.map((r) => ({ ...r, l2Hit: { id: r.l2Hit.id, name: byId.get(r.l2Hit.id)?.name, score: +r.l2Hit.score.toFixed(3) } })), negEval: negEval.map((r) => ({ cat: r.cat, grade: r.grade, utterance: r.utterance, l1Hit: r.l1Hit, l2: { name: byId.get(r.l2Hit.id)?.name, score: +r.l2Hit.score.toFixed(3) } })) }, null, 2));
console.log('\n明细已写 eval-hybrid-detail.json');
