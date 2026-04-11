/**
 * crawler.test.ts — 通过依赖注入 mock 测试 crawl()。
 *
 * 不依赖 lark-cli / 网络 / 真 FS；全程 :memory: DB。
 * 覆盖：newDocs / skippedDocs / updatedDocs / 递归 / 失败 / maxDocs / 非 docx 过滤。
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  crawl,
  computeContentHash,
  canTransition,
  type CrawlerDeps,
  type WikiNode,
} from "./crawler.js";
import {
  openKnowledgeDB,
  closeKnowledgeDB,
  getDocSyncState,
  type KnowledgeDatabase,
} from "./store.js";
import type { Allowlist } from "./types.js";

const ALLOWLIST: Allowlist = {
  spaces: [
    { spaceId: "sp1", name: "S1", enabled: true, rootTokens: [] },
  ],
};

function fakeNode(overrides: Partial<WikiNode>): WikiNode {
  return {
    nodeToken: "n1",
    objToken: "o1",
    objType: "docx",
    title: "Test Doc",
    hasChild: false,
    objEditTime: 0,
    ...overrides,
  };
}

function makeDeps(
  nodesMap: Readonly<Record<string, readonly WikiNode[]>>,
  contents: Readonly<Record<string, string>>,
): CrawlerDeps {
  return {
    listNodes: async (_sid, parent) => nodesMap[parent ?? "_root"] ?? [],
    fetchContent: async (tok) => contents[tok] ?? "",
  };
}

async function withDB<T>(
  fn: (db: KnowledgeDatabase) => T | Promise<T>,
): Promise<T> {
  const db = await openKnowledgeDB(":memory:");
  assert.ok(db);
  try {
    return await fn(db);
  } finally {
    closeKnowledgeDB(db);
  }
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

test("computeContentHash: stable sha256 for same content", async () => {
  const h1 = await computeContentHash("hello world");
  const h2 = await computeContentHash("hello world");
  assert.equal(h1, h2);
  assert.equal(h1.length, 64);
});

test("computeContentHash: different content → different hash", async () => {
  const h1 = await computeContentHash("v1");
  const h2 = await computeContentHash("v2");
  assert.notEqual(h1, h2);
});

test("canTransition: valid transitions allowed, invalid rejected", () => {
  assert.equal(canTransition("pending", "synced"), true);
  assert.equal(canTransition("synced", "extracted"), true);
  assert.equal(canTransition("extracted", "pending"), true);
  assert.equal(canTransition("failed", "pending"), true);
  assert.equal(canTransition("pending", "extracted"), false);
  assert.equal(canTransition("extracted", "synced"), false);
});

// ---------------------------------------------------------------------------
// crawl() 集成
// ---------------------------------------------------------------------------

test("crawl: new docs create pending states with hash", async () => {
  await withDB(async (db) => {
    const deps = makeDeps(
      { _root: [fakeNode({ objToken: "o1", title: "Doc1" })] },
      { o1: "hello world" },
    );
    const result = await crawl(
      { db, allowlist: ALLOWLIST, dryRun: false, maxDocs: 100, apiDelayMs: 0 },
      deps,
    );
    assert.equal(result.totalDocs, 1);
    assert.equal(result.newDocs, 1);
    assert.equal(result.skippedDocs, 0);
    assert.equal(result.updatedDocs, 0);
    assert.equal(result.failedDocs, 0);

    const state = getDocSyncState(db, "o1");
    assert.ok(state);
    assert.equal(state?.status, "pending");
    assert.equal(state?.contentHash.length, 64);
    assert.equal(state?.docTitle, "Doc1");
  });
});

test("crawl: unchanged hash on re-run → skippedDocs", async () => {
  await withDB(async (db) => {
    const deps = makeDeps(
      { _root: [fakeNode({ objToken: "o1" })] },
      { o1: "same content" },
    );
    await crawl(
      { db, allowlist: ALLOWLIST, dryRun: false, maxDocs: 100, apiDelayMs: 0 },
      deps,
    );
    const result2 = await crawl(
      { db, allowlist: ALLOWLIST, dryRun: false, maxDocs: 100, apiDelayMs: 0 },
      deps,
    );
    assert.equal(result2.totalDocs, 1);
    assert.equal(result2.skippedDocs, 1);
    assert.equal(result2.newDocs, 0);
  });
});

test("crawl: content changed → updatedDocs and new hash", async () => {
  await withDB(async (db) => {
    await crawl(
      { db, allowlist: ALLOWLIST, dryRun: false, maxDocs: 100, apiDelayMs: 0 },
      makeDeps({ _root: [fakeNode({ objToken: "o1" })] }, { o1: "v1" }),
    );
    const before = getDocSyncState(db, "o1");

    const result2 = await crawl(
      { db, allowlist: ALLOWLIST, dryRun: false, maxDocs: 100, apiDelayMs: 0 },
      makeDeps({ _root: [fakeNode({ objToken: "o1" })] }, { o1: "v2" }),
    );
    assert.equal(result2.updatedDocs, 1);
    assert.equal(result2.newDocs, 0);

    const after = getDocSyncState(db, "o1");
    assert.notEqual(before?.contentHash, after?.contentHash);
  });
});

test("crawl: recurses into has_child nodes", async () => {
  await withDB(async (db) => {
    const deps = makeDeps(
      {
        _root: [
          fakeNode({
            nodeToken: "parent",
            objToken: "op",
            title: "Parent",
            hasChild: true,
          }),
        ],
        parent: [
          fakeNode({ nodeToken: "c1", objToken: "oc", title: "Child" }),
        ],
      },
      { op: "parent content", oc: "child content" },
    );
    const result = await crawl(
      { db, allowlist: ALLOWLIST, dryRun: false, maxDocs: 100, apiDelayMs: 0 },
      deps,
    );
    assert.equal(result.totalDocs, 2);
    assert.ok(getDocSyncState(db, "op"));
    assert.ok(getDocSyncState(db, "oc"));
  });
});

test("crawl: fetchContent failure marks doc as failed", async () => {
  await withDB(async (db) => {
    const deps: CrawlerDeps = {
      listNodes: async () => [fakeNode({ objToken: "o1" })],
      fetchContent: async () => {
        throw new Error("boom");
      },
    };
    const result = await crawl(
      { db, allowlist: ALLOWLIST, dryRun: false, maxDocs: 100, apiDelayMs: 0 },
      deps,
    );
    assert.equal(result.failedDocs, 1);
    assert.equal(result.newDocs, 0);
    const state = getDocSyncState(db, "o1");
    assert.equal(state?.status, "failed");
    assert.ok(state?.errorMessage.includes("boom"));
  });
});

test("crawl: maxDocs truncates", async () => {
  await withDB(async (db) => {
    const deps = makeDeps(
      {
        _root: [
          fakeNode({ objToken: "o1" }),
          fakeNode({ objToken: "o2" }),
          fakeNode({ objToken: "o3" }),
        ],
      },
      { o1: "a", o2: "b", o3: "c" },
    );
    const result = await crawl(
      { db, allowlist: ALLOWLIST, dryRun: false, maxDocs: 2, apiDelayMs: 0 },
      deps,
    );
    assert.equal(result.totalDocs, 2);
    assert.ok(getDocSyncState(db, "o1"));
    assert.ok(getDocSyncState(db, "o2"));
    assert.equal(getDocSyncState(db, "o3"), undefined);
  });
});

test("crawl: skips non-docx objType but recurses has_child containers", async () => {
  await withDB(async (db) => {
    const deps = makeDeps(
      {
        _root: [
          // 表格节点：objType=sheet 但 hasChild=true → 不 upsert 但递归
          fakeNode({
            nodeToken: "folder",
            objToken: "folder_obj",
            objType: "sheet",
            title: "容器",
            hasChild: true,
          }),
          fakeNode({ objToken: "doc1", objType: "docx" }),
        ],
        folder: [
          fakeNode({ objToken: "nested_doc", objType: "docx", title: "嵌套" }),
        ],
      },
      {
        doc1: "top content",
        nested_doc: "nested content",
      },
    );
    const result = await crawl(
      { db, allowlist: ALLOWLIST, dryRun: false, maxDocs: 100, apiDelayMs: 0 },
      deps,
    );
    assert.equal(result.totalDocs, 2);
    // sheet 容器本身不入库
    assert.equal(getDocSyncState(db, "folder_obj"), undefined);
    assert.ok(getDocSyncState(db, "doc1"));
    assert.ok(getDocSyncState(db, "nested_doc"));
  });
});

test("crawl: dryRun does not write to db", async () => {
  await withDB(async (db) => {
    const deps = makeDeps(
      { _root: [fakeNode({ objToken: "o1" })] },
      { o1: "content" },
    );
    const result = await crawl(
      { db, allowlist: ALLOWLIST, dryRun: true, maxDocs: 100, apiDelayMs: 0 },
      deps,
    );
    assert.equal(result.newDocs, 1);
    assert.equal(result.states.length, 1);
    // DB 未写入
    assert.equal(getDocSyncState(db, "o1"), undefined);
  });
});
