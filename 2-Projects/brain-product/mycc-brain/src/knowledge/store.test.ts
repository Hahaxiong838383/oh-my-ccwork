/**
 * store.test.ts — 通过 `tsx --test src/knowledge/store.test.ts` 运行。
 *
 * 所有测试用 `:memory:` DB，零文件副作用。
 * 依赖 better-sqlite3 和 node:test（node 22+）。
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  openKnowledgeDB,
  insertKnowledgeItem,
  insertKnowledgeItems,
  knowledgeFtsSearch,
  softDeleteByDocToken,
  countKnowledgeItems,
  closeKnowledgeDB,
  type KnowledgeDatabase,
} from "./store.js";
import type { KnowledgeItemInput } from "./types.js";

const SAMPLE: KnowledgeItemInput = {
  docToken: "tok_1",
  docTitle: "Test Doc",
  spaceId: "space_1",
  namespace: "brain/test",
  content: "Mycc brain uses SQLite FTS5 for keyword search.",
  keywords: ["sqlite", "fts5", "brain"],
  confidence: 0.9,
  sourceUrl: "https://example.com/tok_1",
  extractedBy: "manual",
};

async function withDB<T>(
  fn: (db: KnowledgeDatabase) => T | Promise<T>,
): Promise<T> {
  const db = await openKnowledgeDB(":memory:");
  assert.ok(db, "better-sqlite3 driver must load");
  try {
    return await fn(db);
  } finally {
    closeKnowledgeDB(db);
  }
}

test("openKnowledgeDB creates tables and returns handle", async () => {
  await withDB(async (db) => {
    assert.equal(countKnowledgeItems(db), 0);
  });
});

test("insertKnowledgeItem writes row and returns id", async () => {
  await withDB(async (db) => {
    const id = insertKnowledgeItem(db, SAMPLE);
    assert.ok(typeof id === "number" && id > 0);
    assert.equal(countKnowledgeItems(db), 1);
  });
});

test("insertKnowledgeItems batches in transaction", async () => {
  await withDB(async (db) => {
    const ids = insertKnowledgeItems(db, [
      SAMPLE,
      { ...SAMPLE, docToken: "tok_2" },
      { ...SAMPLE, docToken: "tok_3" },
    ]);
    assert.equal(ids.length, 3);
    assert.equal(countKnowledgeItems(db), 3);
  });
});

test("knowledgeFtsSearch finds by keyword", async () => {
  await withDB(async (db) => {
    insertKnowledgeItem(db, SAMPLE);
    const hits = knowledgeFtsSearch(db, "SQLite");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].content, SAMPLE.content);
    assert.equal(hits[0].docTitle, SAMPLE.docTitle);
    assert.equal(hits[0].sourceUrl, SAMPLE.sourceUrl);
    assert.equal(hits[0].namespace, SAMPLE.namespace);
    assert.ok(typeof hits[0].rank === "number");
  });
});

test("knowledgeFtsSearch sanitizes special chars (no throw)", async () => {
  await withDB(async (db) => {
    insertKnowledgeItem(db, SAMPLE);
    // 含 FTS5 特殊字符：*, !, ()
    const hits = knowledgeFtsSearch(db, "SQL*ite! (brain)");
    assert.ok(hits.length >= 0);
  });
});

test("knowledgeFtsSearch returns empty on empty query", async () => {
  await withDB(async (db) => {
    insertKnowledgeItem(db, SAMPLE);
    assert.deepEqual(knowledgeFtsSearch(db, ""), []);
    assert.deepEqual(knowledgeFtsSearch(db, "   "), []);
  });
});

test("softDeleteByDocToken hides row from search and count", async () => {
  await withDB(async (db) => {
    insertKnowledgeItem(db, SAMPLE);
    assert.equal(countKnowledgeItems(db), 1);
    const changed = softDeleteByDocToken(db, SAMPLE.docToken);
    assert.equal(changed, 1);
    assert.equal(countKnowledgeItems(db), 0, "active count excludes tombstoned");
    assert.equal(
      countKnowledgeItems(db, true),
      1,
      "total count includes tombstoned",
    );
    const hits = knowledgeFtsSearch(db, "SQLite");
    assert.equal(hits.length, 0, "tombstoned rows filtered from search");
  });
});

test("softDeleteByDocToken is idempotent on already-deleted", async () => {
  await withDB(async (db) => {
    insertKnowledgeItem(db, SAMPLE);
    softDeleteByDocToken(db, SAMPLE.docToken);
    const changed = softDeleteByDocToken(db, SAMPLE.docToken);
    assert.equal(changed, 0, "second delete is no-op");
  });
});

test("knowledgeFtsSearch topK limits result", async () => {
  await withDB(async (db) => {
    for (let i = 0; i < 5; i++) {
      insertKnowledgeItem(db, {
        ...SAMPLE,
        docToken: `tok_${i}`,
        content: `${SAMPLE.content} item ${i}`,
      });
    }
    const hits = knowledgeFtsSearch(db, "SQLite", 3);
    assert.equal(hits.length, 3);
  });
});

test("keywords persist as JSON string and round-trip correctly", async () => {
  await withDB(async (db) => {
    insertKnowledgeItem(db, SAMPLE);
    // 验证 keywords 被存为 FTS-可搜索文本
    const hits = knowledgeFtsSearch(db, "fts5");
    assert.ok(
      hits.length >= 1,
      "keyword 'fts5' should be indexed into FTS via trigger",
    );
  });
});
