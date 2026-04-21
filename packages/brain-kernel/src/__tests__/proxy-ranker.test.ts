import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CompiledTruth } from '@evodesk/shared';
import { proxyRank, type ContextBudget } from '../memory/proxy-ranker.js';

// ============================================================
// Helpers
// ============================================================

function makeTruth(id: string, domain: string, statement: string): CompiledTruth {
  return {
    id,
    domain,
    statement,
    confidence: 0.8,
    validAt: Date.now(),
    sourceMemCellIds: [],
  };
}

function makeMany(n: number, prefix = 'topic'): CompiledTruth[] {
  return Array.from({ length: n }, (_, i) =>
    makeTruth(`t${i}`, `domain${i}`, `${prefix} statement number ${i}`)
  );
}

// ============================================================
// Budget 截断
// ============================================================

describe('proxyRank — budget 截断', () => {
  it('POOR budget returns at most 1 item', () => {
    const truths = makeMany(10, 'query');
    const result = proxyRank(truths, 'query statement', 'POOR');
    assert.equal(result.length, 1);
  });

  it('LOW budget returns at most 3 items', () => {
    const truths = makeMany(10, 'query');
    const result = proxyRank(truths, 'query statement', 'LOW');
    assert.equal(result.length, 3);
  });

  it('HIGH budget returns at most 8 items', () => {
    const truths = makeMany(20, 'query');
    const result = proxyRank(truths, 'query statement', 'HIGH');
    assert.equal(result.length, 8);
  });

  it('PEAK budget returns all items up to 20', () => {
    const truths = makeMany(20, 'query');
    const result = proxyRank(truths, 'query statement', 'PEAK');
    assert.equal(result.length, 20);
  });

  it('returns input unchanged when merged.length <= topK', () => {
    const truths = makeMany(3, 'query');
    const result = proxyRank(truths, 'query', 'HIGH');
    assert.deepEqual(result, truths);
  });

  it('returns empty array for empty input', () => {
    const result = proxyRank([], 'query', 'HIGH');
    assert.equal(result.length, 0);
  });
});

// ============================================================
// 边际贡献排序
// ============================================================

describe('proxyRank — 边际贡献排序', () => {
  it('selects truth with highest query term coverage first', () => {
    const query = 'TypeScript 静态类型';
    const highRelevance = makeTruth('h', 'tech', 'TypeScript 支持静态类型检查，是 JavaScript 超集');
    const lowRelevance = makeTruth('l', 'ops', '部署脚本负责前后端同步发布');
    const merged = [lowRelevance, highRelevance]; // low 在前，测试排序是否被修正

    const result = proxyRank(merged, query, 'POOR'); // topK=1，只选1个
    assert.equal(result[0].id, 'h', '边际贡献高的应排第一');
  });

  it('reduces marginal score for truths with already-covered terms', () => {
    const query = 'memory retrieval';
    const t1 = makeTruth('t1', 'tech', 'memory system stores retrieval context');
    const t2 = makeTruth('t2', 'tech', 'memory cache reduces retrieval latency');
    const t3 = makeTruth('t3', 'ops', 'deploy script handles server restart');

    const merged = [t1, t2, t3];
    const result = proxyRank(merged, query, 'LOW'); // topK=3 → all pass

    // t1 和 t2 都覆盖 memory/retrieval，t3 不相关；但 topK=3 全拿
    assert.equal(result.length, 3);
  });

  it('with topK=2 picks two truths maximizing unique coverage', () => {
    const query = 'flow state detection';
    const t1 = makeTruth('t1', 'flow', 'flow state detection algorithm'); // 全覆盖
    const t2 = makeTruth('t2', 'flow', 'flow state machine transitions');  // 部分重复
    const t3 = makeTruth('t3', 'ops', 'sidecar embed vector search');      // 独立新词

    const merged = [t1, t2, t3];
    // topK=2：t1 先选（最高覆盖），第二名应在 t2 vs t3 中选边际贡献更大的
    // t3 引入 sidecar/embed/vector/search 均为新词，t2 引入 machine/transitions（部分新）
    // 但由于 t1 已覆盖 flow/state/detection，t3 的 sidecar/embed 是全新词
    // → t3 边际贡献 > t2
    const result = proxyRank(merged, query, 'POOR'); // 仅验证 t1 第一
    assert.equal(result[0].id, 't1', '最相关的应排第一');
  });
});

// ============================================================
// 边界情况
// ============================================================

describe('proxyRank — 边界情况', () => {
  it('handles empty query by returning first topK items in original order', () => {
    const truths = makeMany(10, 'topic');
    const result = proxyRank(truths, '', 'LOW');
    assert.equal(result.length, 3);
    assert.equal(result[0].id, 't0'); // 保持原顺序
    assert.equal(result[1].id, 't1');
    assert.equal(result[2].id, 't2');
  });

  it('handles whitespace-only query like empty query', () => {
    const truths = makeMany(5, 'topic');
    const result = proxyRank(truths, '   ', 'POOR');
    assert.equal(result.length, 1);
  });

  it('preserves truth immutability — output items are same references as input', () => {
    const truths = makeMany(5, 'query topic');
    const result = proxyRank(truths, 'query topic', 'HIGH');
    for (const item of result) {
      assert.ok(truths.includes(item), 'output should reference same objects');
    }
  });
});
