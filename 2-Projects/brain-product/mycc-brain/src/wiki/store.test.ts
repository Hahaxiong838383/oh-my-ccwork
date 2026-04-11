/**
 * store.test.ts — brain-wiki store 单元测试
 *
 * 运行：`npx tsx --test src/wiki/store.test.ts`
 *
 * 覆盖：
 *   - openWikiDb 成功 / single-flight 并发共享
 *   - initSchema 幂等 + PRAGMA user_version 持久
 *   - upsertDocument 新建 / 更新 version bump / 复活 tombstone
 *   - getDocumentByPath 正常 / tombstone 过滤
 *   - searchByFts 英文 / 中文 2-gram / kind 过滤 / 空 query
 *   - softDeleteByPath 正常 / 不存在返回 false / 双删幂等
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openWikiDb,
  closeWikiDb,
  upsertDocument,
  getDocumentByPath,
  searchByFts,
  softDeleteByPath,
  tokenizeCjk2Gram,
  WIKI_SCHEMA_VERSION,
  type WikiDatabase,
} from "./store.js";
import type { WikiDocumentInput } from "./types.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function withMemDb<T>(
  fn: (db: WikiDatabase) => T | Promise<T>,
): Promise<T> {
  const db = await openWikiDb(":memory:");
  assert.ok(db, "better-sqlite3 driver must load and init must succeed");
  try {
    return await fn(db);
  } finally {
    closeWikiDb(db);
  }
}

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "wiki-store-test-"));
}

const SAMPLE_EN: WikiDocumentInput = {
  path: "/wiki/entities/futurus.md",
  title: "Futurus",
  content:
    "Futurus is a spatial intelligence platform operator, building HUD and AR glasses products.",
  kind: "wiki",
  tags: ["entity", "company"],
};

const SAMPLE_ZH: WikiDocumentInput = {
  path: "/wiki/concepts/strategy.md",
  title: "战略演进",
  content:
    "Futurus 是一家空间智能平台运营商，主要产品包括 HUD 和 AR 眼镜。公司战略聚焦车载 HUD。",
  kind: "wiki",
};

const SAMPLE_SRC: WikiDocumentInput = {
  path: "/sources/feishu-doc-xxx",
  title: "飞书 wiki 抽取",
  content: "原始材料内容 Futurus 战略文档。",
  kind: "source",
};

// ---------------------------------------------------------------------------
// tokenizeCjk2Gram
// ---------------------------------------------------------------------------

test("tokenizeCjk2Gram: pure ASCII unchanged", () => {
  assert.equal(tokenizeCjk2Gram("hello world"), "hello world");
});

test("tokenizeCjk2Gram: CJK produces 2-gram + fallback single", () => {
  const out = tokenizeCjk2Gram("公司战略");
  const tokens = out.split(/\s+/).filter(Boolean);
  // 期望包含：公司 / 公 / 司战 / 司 / 战略 / 战
  assert.ok(tokens.includes("公司"), "contains bigram 公司");
  assert.ok(tokens.includes("司战"), "contains bigram 司战");
  assert.ok(tokens.includes("战略"), "contains bigram 战略");
  assert.ok(tokens.includes("公"), "contains single 公");
});

test("tokenizeCjk2Gram: mixed ASCII + CJK", () => {
  const out = tokenizeCjk2Gram("Futurus 公司");
  assert.ok(out.includes("Futurus"));
  assert.ok(out.includes("公司"));
});

test("tokenizeCjk2Gram: empty and whitespace", () => {
  assert.equal(tokenizeCjk2Gram(""), "");
  assert.equal(tokenizeCjk2Gram("   "), "");
});

// ---------------------------------------------------------------------------
// openWikiDb & initSchema
// ---------------------------------------------------------------------------

test("openWikiDb: :memory: returns usable handle", async () => {
  await withMemDb(async (db) => {
    // Schema 已初始化，搜索空结果应返回空数组
    const hits = searchByFts(db, "anything");
    assert.deepEqual(hits, []);
  });
});

test("openWikiDb: PRAGMA user_version is set to WIKI_SCHEMA_VERSION", async () => {
  await withMemDb(async (db) => {
    const d = db as {
      pragma: (stmt: string, opts?: { simple?: boolean }) => unknown;
    };
    const version = Number(d.pragma("user_version", { simple: true }));
    assert.equal(version, WIKI_SCHEMA_VERSION);
  });
});

test("openWikiDb: concurrent calls share same instance (single-flight)", async () => {
  // 两个并发 open 同一个 dbPath，期望拿到同一个 Promise 结果
  const [db1, db2] = await Promise.all([
    openWikiDb(":memory:"),
    openWikiDb(":memory:"),
  ]);
  assert.ok(db1);
  assert.ok(db2);
  assert.strictEqual(
    db1,
    db2,
    "concurrent openWikiDb calls should share the same db instance",
  );
  closeWikiDb(db1);
});

test("openWikiDb: schema persists across close/reopen (file-based)", async () => {
  const tmp = makeTmpDir();
  const dbFile = join(tmp, "persist.db");
  try {
    // 第一次打开：建表 + upsert
    const db1 = await openWikiDb(dbFile);
    assert.ok(db1);
    upsertDocument(db1, SAMPLE_EN);
    closeWikiDb(db1);

    // 第二次打开：user_version 应该已经是 1，不会重建 schema
    const db2 = await openWikiDb(dbFile);
    assert.ok(db2);
    const d = db2 as {
      pragma: (stmt: string, opts?: { simple?: boolean }) => unknown;
    };
    const version = Number(d.pragma("user_version", { simple: true }));
    assert.equal(version, WIKI_SCHEMA_VERSION);

    // 数据还在
    const fetched = getDocumentByPath(db2, SAMPLE_EN.path);
    assert.ok(fetched);
    assert.equal(fetched.title, SAMPLE_EN.title);
    closeWikiDb(db2);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// upsertDocument
// ---------------------------------------------------------------------------

test("upsertDocument: new path returns WikiDocument with version=1", async () => {
  await withMemDb(async (db) => {
    const doc = upsertDocument(db, SAMPLE_EN);
    assert.ok(doc.id > 0);
    assert.equal(doc.path, SAMPLE_EN.path);
    assert.equal(doc.title, SAMPLE_EN.title);
    assert.equal(doc.version, 1);
    assert.equal(doc.tombstone, false);
    assert.deepEqual(doc.tags, ["entity", "company"]);
  });
});

test("upsertDocument: existing path bumps version and updates content", async () => {
  await withMemDb(async (db) => {
    const first = upsertDocument(db, SAMPLE_EN);
    const second = upsertDocument(db, {
      ...SAMPLE_EN,
      title: "Futurus (updated)",
      content: "New content about Futurus.",
    });
    assert.equal(second.id, first.id, "same row (id stable)");
    assert.equal(second.version, 2);
    assert.equal(second.title, "Futurus (updated)");
    assert.equal(second.content, "New content about Futurus.");
  });
});

test("upsertDocument: empty tags stored as empty array", async () => {
  await withMemDb(async (db) => {
    const doc = upsertDocument(db, { ...SAMPLE_EN, tags: undefined });
    assert.deepEqual(doc.tags, []);
  });
});

test("upsertDocument: revives tombstoned row via same path", async () => {
  await withMemDb(async (db) => {
    const created = upsertDocument(db, SAMPLE_EN);
    softDeleteByPath(db, SAMPLE_EN.path);
    assert.equal(
      getDocumentByPath(db, SAMPLE_EN.path),
      null,
      "tombstoned row is hidden",
    );
    const revived = upsertDocument(db, {
      ...SAMPLE_EN,
      content: "Resurrected.",
    });
    assert.equal(revived.id, created.id, "same id (PK preserved)");
    assert.equal(revived.tombstone, false);
    assert.ok(revived.version >= 2, "version bumped at least once");
    assert.equal(revived.content, "Resurrected.");
  });
});

// ---------------------------------------------------------------------------
// getDocumentByPath
// ---------------------------------------------------------------------------

test("getDocumentByPath: returns null for missing path", async () => {
  await withMemDb(async (db) => {
    assert.equal(getDocumentByPath(db, "/wiki/does-not-exist.md"), null);
  });
});

test("getDocumentByPath: returns null for tombstoned row", async () => {
  await withMemDb(async (db) => {
    upsertDocument(db, SAMPLE_EN);
    softDeleteByPath(db, SAMPLE_EN.path);
    assert.equal(getDocumentByPath(db, SAMPLE_EN.path), null);
  });
});

// ---------------------------------------------------------------------------
// searchByFts
// ---------------------------------------------------------------------------

test("searchByFts: English keyword hit", async () => {
  await withMemDb(async (db) => {
    upsertDocument(db, SAMPLE_EN);
    const hits = searchByFts(db, "spatial intelligence");
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].path, SAMPLE_EN.path);
    // FTS rank 是负数，越小越相关
    assert.ok(hits[0].rank <= 0);
  });
});

test("searchByFts: Chinese 2-gram hit", async () => {
  await withMemDb(async (db) => {
    upsertDocument(db, SAMPLE_ZH);
    const hits = searchByFts(db, "空间智能");
    assert.ok(
      hits.length >= 1,
      "Chinese 2-gram tokenizer should enable 空间智能 query",
    );
    assert.equal(hits[0].path, SAMPLE_ZH.path);
  });
});

test("searchByFts: empty and whitespace returns []", async () => {
  await withMemDb(async (db) => {
    upsertDocument(db, SAMPLE_EN);
    assert.deepEqual(searchByFts(db, ""), []);
    assert.deepEqual(searchByFts(db, "   "), []);
  });
});

test("searchByFts: kind filter", async () => {
  await withMemDb(async (db) => {
    upsertDocument(db, SAMPLE_EN); // kind=wiki
    upsertDocument(db, SAMPLE_SRC); // kind=source, content 含 "Futurus"
    const wikiOnly = searchByFts(db, "Futurus", { kind: "wiki" });
    assert.ok(wikiOnly.every((h) => h.kind === "wiki"));
    const sourceOnly = searchByFts(db, "Futurus", { kind: "source" });
    assert.ok(sourceOnly.every((h) => h.kind === "source"));
  });
});

test("searchByFts: tombstoned row not returned", async () => {
  await withMemDb(async (db) => {
    upsertDocument(db, SAMPLE_EN);
    softDeleteByPath(db, SAMPLE_EN.path);
    const hits = searchByFts(db, "Futurus");
    // tombstone=1 的不应命中
    assert.equal(
      hits.filter((h) => h.path === SAMPLE_EN.path).length,
      0,
    );
  });
});

test("searchByFts: topK cap", async () => {
  await withMemDb(async (db) => {
    // 插入 5 条不同 path，content 都含 "Futurus"
    for (let i = 0; i < 5; i++) {
      upsertDocument(db, {
        ...SAMPLE_EN,
        path: `/wiki/entities/futurus-${i}.md`,
        title: `Futurus ${i}`,
      });
    }
    const hits = searchByFts(db, "Futurus", { topK: 3 });
    assert.ok(hits.length <= 3, `topK=3 must cap results, got ${hits.length}`);
  });
});

// ---------------------------------------------------------------------------
// softDeleteByPath
// ---------------------------------------------------------------------------

test("softDeleteByPath: returns true for existing row", async () => {
  await withMemDb(async (db) => {
    upsertDocument(db, SAMPLE_EN);
    assert.equal(softDeleteByPath(db, SAMPLE_EN.path), true);
  });
});

test("softDeleteByPath: returns false for non-existent path", async () => {
  await withMemDb(async (db) => {
    assert.equal(softDeleteByPath(db, "/wiki/nope.md"), false);
  });
});

test("softDeleteByPath: idempotent on already-tombstoned row", async () => {
  await withMemDb(async (db) => {
    upsertDocument(db, SAMPLE_EN);
    assert.equal(softDeleteByPath(db, SAMPLE_EN.path), true);
    // 第二次 delete 时 tombstone=1 已经筛掉，返回 false（没找到"活"的 row）
    assert.equal(softDeleteByPath(db, SAMPLE_EN.path), false);
  });
});
