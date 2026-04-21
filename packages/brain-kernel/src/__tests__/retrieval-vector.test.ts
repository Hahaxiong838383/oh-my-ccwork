/**
 * 四路召回（向量路径）测试
 *
 * 覆盖：
 *   1. Sidecar 离线 → 路 2 回退 keyword，召回仍工作
 *   2. Sidecar 在线 → 路 2 走真向量，命中本地存在的 truth
 *   3. Sidecar 在线但返回的 truthId 在本地不存在 → 回退 keyword
 *   4. loadBrainContext 是 async（契约保持 { context, matchedDomains, itemCount, retrievalPaths }）
 *   5. retrievalPaths 反映真实走的路径（vector / keyword）
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  initDb,
  closeDb,
  insertCompiledTruth,
} from '../memory/memory-db.js';
import {
  loadBrainContext,
  clearBrainContextCache,
} from '../memory/brain-context.js';
import {
  setSidecarClientForTesting,
  type SidecarClient,
} from '../lib/sidecar-client.js';

let tmpDir: string;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'evodesk-vec-test-'));
  initDb(join(tmpDir, 'test.db'));

  const truths = [
    { id: 'v1', domain: '技术', statement: 'TypeScript 是 JavaScript 的超集', confidence: 0.9 },
    { id: 'v2', domain: '技术', statement: 'SQLite FTS5 支持中文全文搜索', confidence: 0.8 },
    { id: 'v3', domain: '产品', statement: 'EvoDesk 是自进化桌面 AI 助手', confidence: 0.7 },
    { id: 'v4', domain: '运维', statement: '部署脚本支持前后端同步部署', confidence: 0.6 },
    { id: 'v5', domain: '安全', statement: 'Safety Gate 检测危险操作并拦截执行', confidence: 0.85 },
  ];
  for (const t of truths) {
    insertCompiledTruth({ ...t, validAt: Date.now(), sourceMemCellIds: [] });
  }
});

after(() => {
  closeDb();
  setSidecarClientForTesting(null);
  try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
});

beforeEach(() => {
  clearBrainContextCache(); // 每个测试都重置缓存避免串扰
});

// ============================================================
// 降级：Sidecar 离线
// ============================================================

describe('loadBrainContext (vector path) — Sidecar offline fallback', () => {
  it('falls back to keyword path when Sidecar health=false', async () => {
    const offlineClient: SidecarClient = {
      async health() { return false; },
      async embed() { throw new Error('should not be called'); },
      async search() { throw new Error('should not be called'); },
      async index() { return false; },
    };
    setSidecarClientForTesting(offlineClient);

    const result = await loadBrainContext('TypeScript');
    assert.ok(result.itemCount > 0, 'should still recall via keyword fallback');
    // 降级路径应标记为 'keyword'，不是 'vector'
    assert.ok(
      result.retrievalPaths.includes('keyword') || result.retrievalPaths.includes('fts'),
      `expected keyword/fts path, got: ${result.retrievalPaths.join(',')}`,
    );
    assert.ok(!result.retrievalPaths.includes('vector'), 'should not claim vector path when sidecar is offline');
  });
});

// ============================================================
// 成功：Sidecar 在线 + 命中本地
// ============================================================

describe('loadBrainContext (vector path) — Sidecar online', () => {
  it('uses vector path and includes "vector" in retrievalPaths', async () => {
    const onlineClient: SidecarClient = {
      async health() { return true; },
      async embed(texts) { return texts.map(() => [0.1, 0.2, 0.3]); },
      async search() {
        // 命中本地存在的 v1 / v2
        return [
          { truthId: 'v1', distance: 0.05 },
          { truthId: 'v2', distance: 0.10 },
        ];
      },
      async index() { return true; },
    };
    setSidecarClientForTesting(onlineClient);

    const result = await loadBrainContext('query about TypeScript');
    assert.ok(result.itemCount > 0);
    assert.ok(
      result.retrievalPaths.includes('vector'),
      `expected vector path, got: ${result.retrievalPaths.join(',')}`,
    );
  });

  it('falls back when Sidecar returns truthIds that no longer exist locally', async () => {
    const stalePtrClient: SidecarClient = {
      async health() { return true; },
      async embed(texts) { return texts.map(() => [0.1, 0.2, 0.3]); },
      async search() {
        // 返回本地不存在的 truthId
        return [
          { truthId: 'ghost-1', distance: 0.01 },
          { truthId: 'ghost-2', distance: 0.02 },
        ];
      },
      async index() { return true; },
    };
    setSidecarClientForTesting(stalePtrClient);

    const result = await loadBrainContext('TypeScript');
    // 向量路径被完全过滤 → 应降级到 keyword + fts 仍能召回
    assert.ok(result.itemCount > 0, 'other paths (fts/keyword/time) should still work');
  });

  it('falls back to keyword when Sidecar embed throws', async () => {
    const flakyClient: SidecarClient = {
      async health() { return true; },
      async embed() { throw new Error('embed boom'); },
      async search() { throw new Error('should not be called'); },
      async index() { return true; },
    };
    setSidecarClientForTesting(flakyClient);

    const result = await loadBrainContext('TypeScript');
    assert.ok(result.itemCount > 0);
    assert.ok(
      !result.retrievalPaths.includes('vector'),
      'should not claim vector path when embed failed',
    );
  });
});

// ============================================================
// 契约：返回 shape 不变
// ============================================================

describe('loadBrainContext — return shape unchanged', () => {
  it('still returns { context, matchedDomains, itemCount, retrievalPaths }', async () => {
    setSidecarClientForTesting({
      async health() { return false; },
      async embed() { return []; },
      async search() { return []; },
      async index() { return false; },
    });

    const result = await loadBrainContext('deploy');
    assert.equal(typeof result.context, 'string');
    assert.ok(Array.isArray(result.matchedDomains));
    assert.equal(typeof result.itemCount, 'number');
    assert.ok(Array.isArray(result.retrievalPaths));
  });

  it('returns empty result for empty query', async () => {
    const result = await loadBrainContext('');
    assert.equal(result.context, '');
    assert.equal(result.itemCount, 0);
    assert.deepEqual(result.retrievalPaths, []);
  });
});
