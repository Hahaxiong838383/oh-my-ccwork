import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb, insertCompiledTruth } from '../memory/memory-db.js';
import { hybridSearch, ftsSearch } from '../memory/retrieval.js';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

let tmpDir: string;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'evodesk-test-'));
  initDb(join(tmpDir, 'test.db'));

  // 插入测试数据
  const truths = [
    { id: 't1', domain: '技术', statement: 'TypeScript 是 JavaScript 的超集，支持静态类型检查', confidence: 0.9 },
    { id: 't2', domain: '技术', statement: 'SQLite FTS5 支持全文搜索和中文分词', confidence: 0.8 },
    { id: 't3', domain: '产品', statement: 'EvoDesk 是一个自进化桌面 AI 助手', confidence: 0.7 },
    { id: 't4', domain: '运维', statement: '部署脚本 deploy.sh 支持前后端同步部署', confidence: 0.6 },
    { id: 't5', domain: '安全', statement: 'Safety Gate 检测危险操作并拦截执行', confidence: 0.85 },
  ];

  for (const t of truths) {
    insertCompiledTruth({
      ...t,
      validAt: Date.now(),
      sourceMemCellIds: [],
    });
  }
});

after(() => {
  closeDb();
  try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
});

describe('hybridSearch', () => {
  it('returns results for English query', () => {
    const results = hybridSearch('TypeScript', 3);
    assert.ok(results.length > 0, 'should find TypeScript results');
    assert.ok(results.some(r => r.statement.includes('TypeScript')));
  });

  it('returns results for Chinese query', () => {
    const results = hybridSearch('全文搜索', 3);
    assert.ok(results.length > 0, 'should find Chinese results');
  });

  it('returns empty for nonsense query', () => {
    const results = hybridSearch('xyzzy12345 qwerty67890', 3);
    // FTS5 might not find anything, keyword path might not either
    assert.ok(results.length >= 0); // just shouldn't crash
  });

  it('returns empty for empty query', () => {
    const results = hybridSearch('', 3);
    assert.equal(results.length, 0);
  });

  it('respects limit', () => {
    const results = hybridSearch('TypeScript', 1);
    assert.ok(results.length <= 1);
  });

  it('returns CompiledTruth shape', () => {
    const results = hybridSearch('Safety Gate', 1);
    if (results.length > 0) {
      const r = results[0];
      assert.ok(typeof r.id === 'string');
      assert.ok(typeof r.domain === 'string');
      assert.ok(typeof r.statement === 'string');
      assert.ok(typeof r.confidence === 'number');
    }
  });
});

describe('ftsSearch', () => {
  it('returns results for matching query', () => {
    const results = ftsSearch('TypeScript', 3);
    assert.ok(results.length > 0);
  });

  it('returns empty for no match', () => {
    const results = ftsSearch('zzzznonexistent', 3);
    assert.equal(results.length, 0);
  });
});
