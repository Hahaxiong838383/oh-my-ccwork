/**
 * knowledge-sync-job.test.ts — runKnowledgeSyncJob() 单测
 *
 * 全部用 `:memory:` DB + 注入 mock deps，零网络 / 零 lark-cli / 零 Gemini。
 * 覆盖：
 *   1. 正常路径：crawl mock 返回 result，pending 有数据 → docsProcessed > 0
 *   2. 空路径：pending 为 0 → docsProcessed=0
 *   3. 单篇 extract 失败（普通 Error）→ 其他继续，errors 里有条目
 *   4. BudgetExceededError → stoppedByBudget=true, break 循环
 *   5. facts=[] → status 仍 extracted，factsInserted 不增
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runKnowledgeSyncJob,
  factToKnowledgeInput,
  type SyncJobDeps,
  type SyncJobOptions,
} from "./knowledge-sync-job.js";
import {
  openKnowledgeDB,
  closeKnowledgeDB,
  upsertDocSyncState,
  getDocSyncState,
  countKnowledgeItems,
  type KnowledgeDatabase,
} from "./store.js";
import { BudgetExceededError } from "./extractor.js";
import type { CrawlerResult } from "./crawler.js";
import type {
  DocSyncState,
  ExtractedFact,
  ExtractionResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// 共享 fixture
// ---------------------------------------------------------------------------

function makeCrawlerResult(): CrawlerResult {
  return {
    totalDocs: 0,
    newDocs: 0,
    updatedDocs: 0,
    skippedDocs: 0,
    failedDocs: 0,
    states: [],
  };
}

function makeFact(overrides: Partial<ExtractedFact> = {}): ExtractedFact {
  return {
    content: "公司使命是构建通用人工智能。",
    keywords: ["公司", "使命", "AGI"],
    confidence: 0.92,
    namespace: "company/mission",
    ...overrides,
  };
}

function makeExtractionResult(
  docToken: string,
  facts: readonly ExtractedFact[],
  costUsd = 0.001,
): ExtractionResult {
  return {
    docToken,
    docTitle: `title-${docToken}`,
    contentHash: `hash-${docToken}`,
    facts,
    model: "gemini-2.5-flash",
    latencyMs: 100,
    tokenIn: 500,
    tokenOut: 200,
    costUsd,
  };
}

function seedPending(db: KnowledgeDatabase, docTokens: readonly string[]): void {
  for (const tok of docTokens) {
    const state: DocSyncState = {
      docToken: tok,
      docTitle: `title-${tok}`,
      spaceId: "space_test",
      contentHash: `hash-${tok}`,
      lastSyncedAt: Date.now(),
      lastExtractedAt: 0,
      status: "pending",
      errorMessage: "",
    };
    upsertDocSyncState(db, state);
  }
}

/** 准备一次性的 tmp allowlist 文件（内容空 spaces 即可） */
function makeTmpAllowlist(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "kn-sync-job-"));
  const path = join(dir, "knowledge-allowlist.json");
  writeFileSync(path, JSON.stringify({ spaces: [] }), "utf-8");
  return {
    path,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** 预置 DB + 调用 job 的通用包装；注入固定 allowlistPath / knowledgeDbPath */
async function runWithFixtures(params: {
  pendingDocs: readonly string[];
  deps: SyncJobDeps;
  budgetUsd?: number;
}) {
  const allowlist = makeTmpAllowlist();

  // Seed the DB via a temporary open, then close it so runKnowledgeSyncJob
  // can open it independently. Using a file path (not :memory:) so the two
  // connections see the same data.
  const dbDir = mkdtempSync(join(tmpdir(), "kn-sync-db-"));
  const dbPath = join(dbDir, "knowledge.db");
  const seedDb = await openKnowledgeDB(dbPath);
  assert.ok(seedDb, "better-sqlite3 must load");
  seedPending(seedDb, params.pendingDocs);
  closeKnowledgeDB(seedDb);

  const options: SyncJobOptions = {
    budgetUsd: params.budgetUsd ?? 0.5,
    maxDocs: 100,
    allowlistPath: allowlist.path,
    knowledgeDbPath: dbPath,
    geminiApiKey: "fake-key",
    pendingBatchSize: 50,
  };

  try {
    const result = await runKnowledgeSyncJob(options, params.deps);
    // 读 DB 快照，供断言使用
    const db = await openKnowledgeDB(dbPath);
    assert.ok(db);
    const readBack = {
      itemCount: countKnowledgeItems(db),
      stateFor: (tok: string) => getDocSyncState(db, tok),
    };
    // 拿完就关
    const snapshot = {
      itemCount: readBack.itemCount,
      states: params.pendingDocs.map((t) => readBack.stateFor(t)),
    };
    closeKnowledgeDB(db);
    return { result, snapshot };
  } finally {
    allowlist.cleanup();
    rmSync(dbDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

test("factToKnowledgeInput: builds input with feishu docx URL + gemini-flash source", () => {
  const fact = makeFact();
  const state: DocSyncState = {
    docToken: "tok_abc",
    docTitle: "标题",
    spaceId: "sp1",
    contentHash: "h1",
    lastSyncedAt: 123,
    lastExtractedAt: 0,
    status: "pending",
    errorMessage: "",
  };
  const input = factToKnowledgeInput(fact, state);
  assert.equal(input.docToken, "tok_abc");
  assert.equal(input.sourceUrl, "https://feishu.cn/docx/tok_abc");
  assert.equal(input.extractedBy, "gemini-flash");
  assert.equal(input.namespace, fact.namespace);
  assert.equal(input.content, fact.content);
  assert.deepEqual(input.keywords, fact.keywords);
  assert.equal(input.confidence, fact.confidence);
});

// ---------------------------------------------------------------------------
// runKnowledgeSyncJob 场景
// ---------------------------------------------------------------------------

test("runKnowledgeSyncJob: happy path inserts facts and marks extracted", async () => {
  const deps: SyncJobDeps = {
    crawl: async () => makeCrawlerResult(),
    fetchDocContent: async (docToken: string) => `content for ${docToken}`,
    extractFacts: async (input) =>
      makeExtractionResult(input.docToken, [makeFact(), makeFact({ content: "第二条事实。" })]),
  };

  const { result, snapshot } = await runWithFixtures({
    pendingDocs: ["doc1", "doc2"],
    deps,
  });

  assert.equal(result.docsProcessed, 2);
  assert.equal(result.docsExtracted, 2);
  assert.equal(result.docsFailed, 0);
  assert.equal(result.factsInserted, 4);
  assert.equal(result.stoppedByBudget, false);
  assert.ok(result.totalCostUsd > 0);
  assert.equal(snapshot.itemCount, 4);
  for (const s of snapshot.states) {
    assert.ok(s);
    assert.equal(s?.status, "extracted");
    assert.equal(s?.errorMessage, "");
    assert.ok((s?.lastExtractedAt ?? 0) > 0);
  }
});

test("runKnowledgeSyncJob: empty pending queue returns zeros without crashing", async () => {
  const deps: SyncJobDeps = {
    crawl: async () => makeCrawlerResult(),
    fetchDocContent: async () => {
      throw new Error("should not be called");
    },
    extractFacts: async () => {
      throw new Error("should not be called");
    },
  };

  const { result, snapshot } = await runWithFixtures({
    pendingDocs: [],
    deps,
  });

  assert.equal(result.docsProcessed, 0);
  assert.equal(result.docsExtracted, 0);
  assert.equal(result.docsFailed, 0);
  assert.equal(result.factsInserted, 0);
  assert.equal(result.totalCostUsd, 0);
  assert.equal(result.errors.length, 0);
  assert.equal(result.stoppedByBudget, false);
  assert.equal(snapshot.itemCount, 0);
});

test("runKnowledgeSyncJob: individual extract failure does not abort job", async () => {
  const deps: SyncJobDeps = {
    crawl: async () => makeCrawlerResult(),
    fetchDocContent: async (docToken: string) => `content-${docToken}`,
    extractFacts: async (input) => {
      if (input.docToken === "doc2") {
        throw new Error("gemini 502 bad gateway");
      }
      return makeExtractionResult(input.docToken, [makeFact()]);
    },
  };

  const { result, snapshot } = await runWithFixtures({
    pendingDocs: ["doc1", "doc2", "doc3"],
    deps,
  });

  assert.equal(result.docsProcessed, 3);
  assert.equal(result.docsExtracted, 2);
  assert.equal(result.docsFailed, 1);
  assert.equal(result.factsInserted, 2);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0] ?? "", /doc2.*gemini 502/);
  assert.equal(result.stoppedByBudget, false);
  assert.equal(snapshot.itemCount, 2);

  // doc2 应被标记 failed，其他是 extracted
  const [d1, d2, d3] = snapshot.states;
  assert.equal(d1?.status, "extracted");
  assert.equal(d2?.status, "failed");
  assert.match(d2?.errorMessage ?? "", /gemini 502/);
  assert.equal(d3?.status, "extracted");
});

test("runKnowledgeSyncJob: BudgetExceededError stops loop and sets flag", async () => {
  // 第一个 doc 成功，第二个抛 BudgetExceeded，第三个不应被处理
  const deps: SyncJobDeps = {
    crawl: async () => makeCrawlerResult(),
    fetchDocContent: async (docToken: string) => `content-${docToken}`,
    extractFacts: async (input) => {
      if (input.docToken === "doc2") {
        throw new BudgetExceededError(0.51, 0.5);
      }
      return makeExtractionResult(input.docToken, [makeFact()]);
    },
  };

  const { result, snapshot } = await runWithFixtures({
    pendingDocs: ["doc1", "doc2", "doc3"],
    deps,
  });

  assert.equal(result.stoppedByBudget, true);
  // doc1 成功；doc2 抛 BudgetExceededError 但不算"失败"（保持 pending 下次再试）；doc3 未处理
  assert.equal(result.docsProcessed, 1);
  assert.equal(result.docsExtracted, 1);
  assert.equal(result.docsFailed, 0);
  assert.equal(result.factsInserted, 1);
  assert.equal(result.errors.length, 0);
  assert.equal(snapshot.itemCount, 1);
  // doc1 extracted，doc2/doc3 仍然 pending（等下次 sync job 重试）
  const [d1, d2, d3] = snapshot.states;
  assert.equal(d1?.status, "extracted");
  assert.equal(d2?.status, "pending");
  assert.equal(d3?.status, "pending");
});

test("runKnowledgeSyncJob: empty facts still marks extracted", async () => {
  const deps: SyncJobDeps = {
    crawl: async () => makeCrawlerResult(),
    fetchDocContent: async () => "空壳目录文档",
    extractFacts: async (input) => makeExtractionResult(input.docToken, []),
  };

  const { result, snapshot } = await runWithFixtures({
    pendingDocs: ["doc1"],
    deps,
  });

  assert.equal(result.docsProcessed, 1);
  assert.equal(result.docsExtracted, 1);
  assert.equal(result.docsFailed, 0);
  assert.equal(result.factsInserted, 0);
  assert.equal(snapshot.itemCount, 0);
  assert.equal(snapshot.states[0]?.status, "extracted");
});
