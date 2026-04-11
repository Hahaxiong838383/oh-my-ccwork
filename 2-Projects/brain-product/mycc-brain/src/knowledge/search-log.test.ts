/**
 * search-log.test.ts — 召回日志的基础覆盖
 *
 * 跑法：`npx tsx --test src/knowledge/search-log.test.ts`
 * 遵循 feedback_brain_no_test_framework：用 node:test + tsx --test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  appendSearchLog,
  readSearchLog,
  aggregateSearchLog,
  filterEvents,
  parseWindow,
  hashQuery,
  sanitizeQuerySample,
  type SearchLogEvent,
} from "./search-log.js";

function mkEvt(partial: Partial<SearchLogEvent> = {}): SearchLogEvent {
  return {
    ts: Date.now(),
    query_sample: "test query",
    query_hash: "abc123def456",
    triggered: true,
    topK: 5,
    hit_count: 2,
    top_hits: [],
    latency_ms: 3,
    ...partial,
  };
}

test("hashQuery 稳定 + 12 字符", () => {
  const h1 = hashQuery("hello");
  const h2 = hashQuery("hello");
  assert.equal(h1, h2);
  assert.equal(h1.length, 12);
});

test("sanitizeQuerySample 默认脱敏前 20 字符", () => {
  const original = process.env.DEBUG_KNOWLEDGE_SEARCH_LOG;
  delete process.env.DEBUG_KNOWLEDGE_SEARCH_LOG;
  const s = sanitizeQuerySample("这是一个超级长的查询应该被截断到二十字符以内吧啊哈哈");
  assert.equal(s.length <= 20, true);
  if (original) process.env.DEBUG_KNOWLEDGE_SEARCH_LOG = original;
});

test("sanitizeQuerySample full 模式保留全文", () => {
  const original = process.env.DEBUG_KNOWLEDGE_SEARCH_LOG;
  process.env.DEBUG_KNOWLEDGE_SEARCH_LOG = "full";
  const q = "完整 query 不应被截断";
  assert.equal(sanitizeQuerySample(q), q);
  if (original !== undefined) process.env.DEBUG_KNOWLEDGE_SEARCH_LOG = original;
  else delete process.env.DEBUG_KNOWLEDGE_SEARCH_LOG;
});

test("appendSearchLog + readSearchLog 回读", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "kw-log-"));
  const logPath = path.join(dir, "k.jsonl");
  try {
    await appendSearchLog(logPath, mkEvt({ ts: Date.now(), hit_count: 3 }));
    await appendSearchLog(logPath, mkEvt({ ts: Date.now(), hit_count: 0 }));
    const events = await readSearchLog(logPath, 60 * 1000);
    assert.equal(events.length, 2);
    assert.equal(events[0].hit_count, 3);
    assert.equal(events[1].hit_count, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readSearchLog 过滤超出 window 的事件", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "kw-log-"));
  const logPath = path.join(dir, "k.jsonl");
  try {
    const now = Date.now();
    await appendSearchLog(logPath, mkEvt({ ts: now - 2 * 60 * 60 * 1000 })); // 2h 前
    await appendSearchLog(logPath, mkEvt({ ts: now - 30 * 60 * 1000 })); // 30min 前
    // 1h window 应该只看到 30min 前的
    const events = await readSearchLog(logPath, 60 * 60 * 1000);
    assert.equal(events.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readSearchLog 文件不存在返回空数组", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "kw-log-"));
  const logPath = path.join(dir, "nonexistent.jsonl");
  try {
    const events = await readSearchLog(logPath);
    assert.deepEqual(events, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("aggregateSearchLog 三类分类正确", () => {
  const events: SearchLogEvent[] = [
    mkEvt({ triggered: true, hit_count: 3, query_hash: "h1", query_sample: "sop" }),
    mkEvt({ triggered: true, hit_count: 2, query_hash: "h1", query_sample: "sop" }),
    mkEvt({ triggered: true, hit_count: 0, query_hash: "h2", query_sample: "wiki 404" }),
    mkEvt({ triggered: false, hit_count: 0, query_hash: "h3", query_sample: "where" }),
    mkEvt({ triggered: false, hit_count: 0, query_hash: "h3", query_sample: "where" }),
    mkEvt({ triggered: false, hit_count: 0, query_hash: "h3", query_sample: "where" }),
  ];
  const agg = aggregateSearchLog(events, 60 * 1000);
  assert.equal(agg.total, 6);
  assert.equal(agg.triggered, 3);
  assert.equal(agg.hit, 2);
  assert.equal(agg.miss, 1);
  assert.equal(agg.untriggered, 3);
  assert.equal(agg.topUntriggeredQueries[0].hash, "h3");
  assert.equal(agg.topUntriggeredQueries[0].count, 3);
  assert.equal(agg.topHitQueries[0].hash, "h1");
  assert.equal(agg.topHitQueries[0].count, 2);
  assert.equal(agg.topMissQueries[0].hash, "h2");
});

test("filterEvents 按 filter 正确过滤", () => {
  const events: SearchLogEvent[] = [
    mkEvt({ triggered: true, hit_count: 3 }),
    mkEvt({ triggered: true, hit_count: 0 }),
    mkEvt({ triggered: false, hit_count: 0 }),
  ];
  assert.equal(filterEvents(events, "all").length, 3);
  assert.equal(filterEvents(events, "hit").length, 1);
  assert.equal(filterEvents(events, "miss").length, 1);
  assert.equal(filterEvents(events, "untriggered").length, 1);
});

test("parseWindow 支持 h/d 单位", () => {
  assert.equal(parseWindow("1h"), 60 * 60 * 1000);
  assert.equal(parseWindow("24h"), 24 * 60 * 60 * 1000);
  assert.equal(parseWindow("7d"), 7 * 24 * 60 * 60 * 1000);
  assert.equal(parseWindow(null), 24 * 60 * 60 * 1000); // 默认
  assert.equal(parseWindow("garbage"), 24 * 60 * 60 * 1000); // 无效 → 默认
});
