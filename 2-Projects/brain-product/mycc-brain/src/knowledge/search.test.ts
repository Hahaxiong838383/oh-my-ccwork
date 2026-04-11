/**
 * search.test.ts — 第五路知识检索入口测试
 *
 * 通过 `tsx --test src/knowledge/search.test.ts` 运行。
 * 每个 test 末尾必 reset singleton cache，防止路径串扰。
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  knowledgeSearch,
  shouldTriggerKnowledgeSearch,
  resetKnowledgeSearchCache,
} from "./search.js";
import {
  openKnowledgeDB,
  insertKnowledgeItems,
  closeKnowledgeDB,
} from "./store.js";
import type { KnowledgeItemInput } from "./types.js";

// ─── env helpers ───

function saveEnv(): { readonly enabled: string | undefined } {
  return { enabled: process.env.KNOWLEDGE_SEARCH_ENABLED };
}

function restoreEnv(saved: { readonly enabled: string | undefined }): void {
  if (saved.enabled === undefined) delete process.env.KNOWLEDGE_SEARCH_ENABLED;
  else process.env.KNOWLEDGE_SEARCH_ENABLED = saved.enabled;
}

function makeTempDbPath(): { readonly dir: string; readonly dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-search-test-"));
  return { dir, dbPath: join(dir, "knowledge.db") };
}

const SAMPLE_ITEMS: readonly KnowledgeItemInput[] = [
  {
    docToken: "doc_deploy_guide",
    docTitle: "部署指南",
    spaceId: "space_ops",
    namespace: "ops/deploy",
    content: "部署 brain 服务需要先执行 npm install 然后 pm2 restart brain",
    keywords: ["部署", "brain", "pm2"],
    confidence: 0.95,
    sourceUrl: "https://example.com/deploy",
    extractedBy: "manual",
  },
  {
    docToken: "doc_config",
    docTitle: "配置说明",
    spaceId: "space_ops",
    namespace: "ops/config",
    content: "brain 的配置文件位于 src/config 目录，怎么配置请参考 README",
    keywords: ["配置", "config"],
    confidence: 0.9,
    sourceUrl: "https://example.com/config",
    extractedBy: "manual",
  },
];

// ─── shouldTriggerKnowledgeSearch ───

test("shouldTriggerKnowledgeSearch: env not set → false", () => {
  const saved = saveEnv();
  try {
    delete process.env.KNOWLEDGE_SEARCH_ENABLED;
    assert.equal(shouldTriggerKnowledgeSearch("我要看文档"), false);
    assert.equal(shouldTriggerKnowledgeSearch("怎么部署 brain"), false);
  } finally {
    restoreEnv(saved);
    resetKnowledgeSearchCache();
  }
});

test("shouldTriggerKnowledgeSearch: env=true + 关键词命中 → true", () => {
  const saved = saveEnv();
  try {
    process.env.KNOWLEDGE_SEARCH_ENABLED = "true";
    assert.equal(shouldTriggerKnowledgeSearch("我要看文档"), true);
    assert.equal(shouldTriggerKnowledgeSearch("怎么部署 brain"), true);
    assert.equal(shouldTriggerKnowledgeSearch("这个流程是什么"), true);
    assert.equal(shouldTriggerKnowledgeSearch("SOP 是什么"), true);
    assert.equal(shouldTriggerKnowledgeSearch("操作方法"), true);
  } finally {
    restoreEnv(saved);
    resetKnowledgeSearchCache();
  }
});

test("shouldTriggerKnowledgeSearch: env=true + 无关键词 → false", () => {
  const saved = saveEnv();
  try {
    process.env.KNOWLEDGE_SEARCH_ENABLED = "true";
    assert.equal(shouldTriggerKnowledgeSearch("你好"), false);
    assert.equal(shouldTriggerKnowledgeSearch("今天天气不错"), false);
  } finally {
    restoreEnv(saved);
    resetKnowledgeSearchCache();
  }
});

// ─── knowledgeSearch ───

test("knowledgeSearch: 无关键词 + 默认 → 返回 []", async () => {
  const saved = saveEnv();
  try {
    delete process.env.KNOWLEDGE_SEARCH_ENABLED;
    const hits = await knowledgeSearch("你好");
    assert.deepEqual(hits, []);
  } finally {
    restoreEnv(saved);
    resetKnowledgeSearchCache();
  }
});

test("knowledgeSearch: forceEnable=true → 即使无关键词也执行查询", async () => {
  const saved = saveEnv();
  const { dir, dbPath } = makeTempDbPath();
  try {
    delete process.env.KNOWLEDGE_SEARCH_ENABLED;
    // 预填数据
    const db = await openKnowledgeDB(dbPath);
    assert.ok(db);
    insertKnowledgeItems(db, SAMPLE_ITEMS);
    closeKnowledgeDB(db);
    resetKnowledgeSearchCache();

    // 无关键词 + forceEnable → 应该真查询
    const hits = await knowledgeSearch("部署", 5, {
      forceEnable: true,
      dbPath,
    });
    assert.ok(hits.length > 0, "forceEnable should bypass trigger guard");
    assert.ok(
      hits.some((h) => h.content.includes("部署")),
      "should find deploy item",
    );
  } finally {
    restoreEnv(saved);
    resetKnowledgeSearchCache();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("knowledgeSearch: env=true + 关键词 + 真实 DB → 命中", async () => {
  const saved = saveEnv();
  const { dir, dbPath } = makeTempDbPath();
  try {
    process.env.KNOWLEDGE_SEARCH_ENABLED = "true";
    const db = await openKnowledgeDB(dbPath);
    assert.ok(db);
    insertKnowledgeItems(db, SAMPLE_ITEMS);
    closeKnowledgeDB(db);
    resetKnowledgeSearchCache();

    const hits = await knowledgeSearch("怎么部署 brain", 5, { dbPath });
    assert.ok(hits.length > 0, "should trigger and find hits");
    assert.ok(
      hits.some((h) => h.docTitle === "部署指南"),
      "should hit deploy guide doc",
    );
  } finally {
    restoreEnv(saved);
    resetKnowledgeSearchCache();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("knowledgeSearch: 默认 env + 命中关键词 → 返回 []（env 未开）", async () => {
  const saved = saveEnv();
  const { dir, dbPath } = makeTempDbPath();
  try {
    delete process.env.KNOWLEDGE_SEARCH_ENABLED;
    const db = await openKnowledgeDB(dbPath);
    assert.ok(db);
    insertKnowledgeItems(db, SAMPLE_ITEMS);
    closeKnowledgeDB(db);
    resetKnowledgeSearchCache();

    const hits = await knowledgeSearch("怎么部署 brain", 5, { dbPath });
    assert.deepEqual(hits, [], "env off should bypass even with keywords");
  } finally {
    restoreEnv(saved);
    resetKnowledgeSearchCache();
    rmSync(dir, { recursive: true, force: true });
  }
});
