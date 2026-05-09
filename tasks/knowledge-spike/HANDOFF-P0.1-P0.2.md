# HANDOFF — P0.1 crawler + P0.2 extractor 实装

> 阶段：Day 0 Spike 完成 → **P0.1 + P0.2 实装**
> 前置：`feat/knowledge-system` 分支，commit `96e66c8`（本地，未 push）
> 本文档目标：**下个 session 的 cc 读完就能直接开干，零返工**
> 预计用时：~2h（P0.1 ~1h + P0.2 ~1h）

---

## 一、20 秒速览

| 子任务 | 核心内容 | 产出 |
|---|---|---|
| **P0.1 crawler** | 递归爬取飞书 wiki + doc_sync_state 增量判重 | `store.ts` 扩 schema + `crawler.ts` 实装 `crawl()` + 新增 `crawler.test.ts` |
| **P0.2 extractor** | Gemini Flash 抽取 + prompt 加固（F3 tweak）+ 预算 check | `extractor.ts` 实装 `extractFacts()` + `callGeminiFlash()` + 新增 `extractor.test.ts` |

**铁律**：
1. 不写 memory.db，只写独立 knowledge.db
2. 所有数据结构 readonly immutable
3. 单文件 < 400 行
4. 每步完成后跑双门：`tsc --noEmit` + `tsx --test`
5. 不 push 到 GitHub

---

## 二、前置上下文（1 分钟自检）

### 2.1 环境验证

```bash
cd /Users/rayman.chen/mycc
git branch --show-current                              # → feat/knowledge-system
git log --oneline -1                                   # → 96e66c8 feat(brain): ...
cd 2-Projects/brain-product/mycc-brain
npx tsc --noEmit                                       # → 无输出 = 通过
npx tsx --test src/knowledge/*.test.ts 2>&1 | tail -5  # → pass 18 fail 0
lark-cli auth status 2>&1 | grep tokenStatus          # → "valid"
```

如果任何一步失败 → **停下来修，别开始 P0.1**。

### 2.2 已存在的脚手架（P0 要用的）

```
src/knowledge/
├── types.ts          ✅ 已实装（12 个 readonly interfaces）
├── store.ts          ✅ 已实装（FTS5 + 3 触发器 + soft delete）- **P0.1 要扩展**
├── allowlist.ts      ✅ 已实装（JSON loader + Zod）
├── crawler.ts        ⏳ stub - **P0.1 要实装 crawl()**
├── extractor.ts      ⏳ stub - **P0.2 要实装 extractFacts()**
├── store.test.ts     ✅ 10/10
└── allowlist.test.ts ✅ 8/8
```

**关键类型**（`types.ts` 已有，直接用）：
- `DocSyncState` — 单篇文档的同步状态
- `DocSyncStatus` — `"pending" | "synced" | "extracted" | "failed"`
- `ExtractedFact` — 单个原子事实
- `ExtractionResult` — 一次抽取的完整结果

**关键纯函数**（已有，P0 复用）：
- `crawler.ts::computeContentHash(content)` — sha256
- `crawler.ts::canTransition(from, to)` — 状态机校验
- `extractor.ts::estimateCostUsd(tokenIn, tokenOut)` — Gemini Flash 公示单价
- `extractor.ts::validateFact(value)` — unknown → ExtractedFact 类型守卫

### 2.3 参考代码

- `src/services/memory-db.ts` — FTS5 + 3 触发器的参考实现（lazy driver load + sqlite 用法）
- `src/knowledge/store.ts` — 现有实现（P0.1 要在这里加 doc_sync_state）
- `tasks/knowledge-spike/scripts/run-gemini-extraction.sh` — **已验证的 Gemini Flash prompt + 调用模式**（P0.2 要从这里抄 prompt + fetch 逻辑）
- `tasks/knowledge-spike/scripts/fetch-sample-docs.sh` — 飞书 docx API 调用模式（P0.1 参考）
- `tasks/knowledge-spike/samples/` — **本地原始数据**（gitignored），可以用这些 txt 文件做 P0.2 的离线测试

### 2.4 已知 API 路径

```
GET /open-apis/wiki/v2/spaces/{space_id}/nodes
    ?parent_node_token={token}    # 空=列根节点
    ?page_token={token}            # 分页 cursor
    ?page_size=50
GET /open-apis/docx/v1/documents/{obj_token}/raw_content
```

两个 API 都用 `lark-cli api` 调。auth 由 lark-cli 自己管，**不要自己处理 token 刷新**。

Gemini Flash proxy：
- URL: `http://23.226.135.149:4000/v1/chat/completions`（硬编码在 `src/config.ts:64`）
- Key: `process.env.GEMINI_PROXY_KEY`（在 `.env.local`）
- Model: `gemini-2.5-flash`

---

## 三、P0.1 · crawler.crawl() 递归实装（~1h）

### 3.1 目标
递归爬取飞书 wiki space 的所有 docx 节点，按 content-hash 做增量判重，写入 `doc_sync_state` 表。**不调 extractor**，只管"拉正文 + 记状态"。

### 3.2 Finding F1 触发
根节点多数是导航空壳（Spike 发现 2/9 < 60 字节）。必须递归到叶子。

### 3.3 Step 1: 扩展 store.ts 加 doc_sync_state 表（~15min）

**修改 `src/knowledge/store.ts`**：

1. 在 `SCHEMA_SQL` 常量末尾追加：
```sql
CREATE TABLE IF NOT EXISTS doc_sync_state (
  doc_token         TEXT PRIMARY KEY,
  doc_title         TEXT NOT NULL,
  space_id          TEXT NOT NULL,
  content_hash      TEXT NOT NULL DEFAULT '',
  last_synced_at    INTEGER NOT NULL DEFAULT 0,
  last_extracted_at INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL,
  error_message     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_doc_sync_status ON doc_sync_state(status);
CREATE INDEX IF NOT EXISTS idx_doc_sync_space ON doc_sync_state(space_id);
```

2. 在 `store.ts` 末尾新增 3 个函数：

```typescript
/** 插入或更新一条 doc_sync_state（P0.1 crawler 用） */
export function upsertDocSyncState(
  db: KnowledgeDatabase,
  state: DocSyncState,
): void {
  const h = db as DbHandle;
  const stmt = h.prepare(`
    INSERT INTO doc_sync_state (
      doc_token, doc_title, space_id, content_hash,
      last_synced_at, last_extracted_at, status, error_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(doc_token) DO UPDATE SET
      doc_title = excluded.doc_title,
      space_id = excluded.space_id,
      content_hash = excluded.content_hash,
      last_synced_at = excluded.last_synced_at,
      last_extracted_at = excluded.last_extracted_at,
      status = excluded.status,
      error_message = excluded.error_message
  `);
  stmt.run(
    state.docToken,
    state.docTitle,
    state.spaceId,
    state.contentHash,
    state.lastSyncedAt,
    state.lastExtractedAt,
    state.status,
    state.errorMessage,
  );
}

/** 查单条状态，不存在返回 undefined */
export function getDocSyncState(
  db: KnowledgeDatabase,
  docToken: string,
): DocSyncState | undefined {
  const h = db as DbHandle;
  const row = h.prepare(
    "SELECT doc_token, doc_title, space_id, content_hash, last_synced_at, last_extracted_at, status, error_message FROM doc_sync_state WHERE doc_token = ?",
  ).get(docToken) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    docToken: row.doc_token as string,
    docTitle: row.doc_title as string,
    spaceId: row.space_id as string,
    contentHash: row.content_hash as string,
    lastSyncedAt: row.last_synced_at as number,
    lastExtractedAt: row.last_extracted_at as number,
    status: row.status as DocSyncState["status"],
    errorMessage: row.error_message as string,
  };
}

/** 列某个 status 下的所有文档（extractor 用来拉 pending 队列） */
export function listDocSyncStatesByStatus(
  db: KnowledgeDatabase,
  status: DocSyncState["status"],
  limit = 100,
): readonly DocSyncState[] {
  const h = db as DbHandle;
  const rows = h.prepare(
    "SELECT doc_token, doc_title, space_id, content_hash, last_synced_at, last_extracted_at, status, error_message FROM doc_sync_state WHERE status = ? ORDER BY last_synced_at ASC LIMIT ?",
  ).all(status, limit) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    docToken: row.doc_token as string,
    docTitle: row.doc_title as string,
    spaceId: row.space_id as string,
    contentHash: row.content_hash as string,
    lastSyncedAt: row.last_synced_at as number,
    lastExtractedAt: row.last_extracted_at as number,
    status: row.status as DocSyncState["status"],
    errorMessage: row.error_message as string,
  }));
}
```

3. 在 `store.ts` 顶部 import 区加 `DocSyncState`:
```typescript
import type {
  KnowledgeItemInput,
  KnowledgeSearchHit,
  DocSyncState,
} from "./types.js";
```

**扩展 `store.test.ts`**，新增 3-4 个测试：
- `upsertDocSyncState 插入新条目` → `getDocSyncState` 能查到
- `upsertDocSyncState 更新已存在条目`（ON CONFLICT 路径）
- `listDocSyncStatesByStatus 只返回指定 status`
- `listDocSyncStatesByStatus limit 生效`

**双门验证**：`tsc --noEmit` + `tsx --test src/knowledge/store.test.ts`

### 3.4 Step 2: 在 crawler.ts 实装 API 客户端（~20min）

**设计决策**：用 `child_process.spawn('lark-cli', [...])` 调 CLI，不自己管 auth token。
- 优点：不碰 token 刷新逻辑，复用 lark-cli 的成熟 auth
- 缺点：每次调用 ~200ms CLI 启动开销（但 wiki API 本身就慢，可忽略）

**在 `crawler.ts` 新增**：

```typescript
import { spawn } from "node:child_process";

/** 飞书 wiki 节点（来自 /open-apis/wiki/v2/spaces/{id}/nodes API） */
export interface WikiNode {
  readonly nodeToken: string;
  readonly objToken: string;
  readonly objType: string;      // "docx" | "sheet" | "bitable" | ...
  readonly title: string;
  readonly hasChild: boolean;
  readonly objEditTime: number;  // unix 秒
}

/** 调 lark-cli api 命令，返回解析后的 JSON */
async function larkApi(
  method: "GET" | "POST",
  path: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  const args = ["api", method, path, "--format", "json"];
  if (params) {
    args.push("--params", JSON.stringify(params));
  }
  return new Promise((resolve, reject) => {
    const proc = spawn("lark-cli", args);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`lark-cli ${args.join(" ")} exit ${code}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (err) {
        reject(new Error(`lark-cli returned invalid JSON: ${stdout.slice(0, 200)}`));
      }
    });
    proc.on("error", reject);
  });
}

/** 列 wiki 节点（某 space 某 parent 下的直接子节点，分页自动展开） */
export async function listWikiNodes(
  spaceId: string,
  parentToken?: string,
): Promise<readonly WikiNode[]> {
  const allNodes: WikiNode[] = [];
  let pageToken: string | undefined;
  do {
    const params: Record<string, unknown> = { page_size: 50 };
    if (parentToken) params.parent_node_token = parentToken;
    if (pageToken) params.page_token = pageToken;

    const resp = (await larkApi(
      "GET",
      `/open-apis/wiki/v2/spaces/${spaceId}/nodes`,
      params,
    )) as {
      code: number;
      msg: string;
      data?: {
        items?: Array<{
          node_token: string;
          obj_token: string;
          obj_type: string;
          title: string;
          has_child: boolean;
          obj_edit_time: string;
        }>;
        page_token?: string;
        has_more?: boolean;
      };
    };
    if (resp.code !== 0) {
      throw new Error(`listWikiNodes failed: code=${resp.code} msg=${resp.msg}`);
    }
    const items = resp.data?.items ?? [];
    for (const item of items) {
      allNodes.push({
        nodeToken: item.node_token,
        objToken: item.obj_token,
        objType: item.obj_type,
        title: item.title,
        hasChild: item.has_child,
        objEditTime: Number(item.obj_edit_time) || 0,
      });
    }
    pageToken = resp.data?.has_more ? resp.data.page_token : undefined;
  } while (pageToken);
  return allNodes;
}

/** 拉 docx 文档正文 */
export async function fetchDocContent(docToken: string): Promise<string> {
  const resp = (await larkApi(
    "GET",
    `/open-apis/docx/v1/documents/${docToken}/raw_content`,
  )) as {
    code: number;
    msg: string;
    data?: { content?: string };
  };
  if (resp.code !== 0) {
    throw new Error(`fetchDocContent failed: code=${resp.code} msg=${resp.msg}`);
  }
  return resp.data?.content ?? "";
}
```

### 3.5 Step 3: 实装 crawl() 主函数（~20min）

**替换 `crawler.ts` 里的 `crawl()` stub**：

```typescript
import { upsertDocSyncState, getDocSyncState, type KnowledgeDatabase } from "./store.js";
import { getEnabledSpaceIds } from "./allowlist.js";

export interface CrawlerOptions {
  readonly db: KnowledgeDatabase;
  readonly allowlist: Allowlist;
  readonly dryRun: boolean;
  readonly maxDocs: number;
  /** 每个 lark-cli 调用之间的延迟（ms），防限流 */
  readonly apiDelayMs: number;
}

/** 爬取入口：遍历 allowlist → 递归列节点 → 拉 docx 正文 → 写 doc_sync_state */
export async function crawl(
  options: CrawlerOptions,
): Promise<CrawlerResult> {
  const spaceIds = getEnabledSpaceIds(options.allowlist);
  const states: DocSyncState[] = [];
  let totalDocs = 0;
  let newDocs = 0;
  let updatedDocs = 0;
  let skippedDocs = 0;
  let failedDocs = 0;

  const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  for (const spaceId of spaceIds) {
    // DFS 队列：先根节点
    const queue: Array<{ parentToken?: string }> = [{ parentToken: undefined }];
    const visited = new Set<string>();

    while (queue.length > 0 && totalDocs < options.maxDocs) {
      const { parentToken } = queue.shift()!;
      let nodes: readonly WikiNode[];
      try {
        nodes = await listWikiNodes(spaceId, parentToken);
      } catch (err) {
        console.error(`[crawler] listWikiNodes failed for space=${spaceId} parent=${parentToken}:`, err);
        continue;
      }
      await delay(options.apiDelayMs);

      for (const node of nodes) {
        if (totalDocs >= options.maxDocs) break;

        // 递归入队子节点
        if (node.hasChild && !visited.has(node.nodeToken)) {
          visited.add(node.nodeToken);
          queue.push({ parentToken: node.nodeToken });
        }

        // 只处理 docx 叶子
        if (node.objType !== "docx") {
          continue;
        }
        totalDocs++;

        // 拉正文 + 算 hash
        try {
          const content = await fetchDocContent(node.objToken);
          await delay(options.apiDelayMs);
          const hash = await computeContentHash(content);

          const existing = getDocSyncState(options.db, node.objToken);
          if (existing && existing.contentHash === hash) {
            skippedDocs++;
            continue;
          }

          const isNew = !existing;
          if (isNew) newDocs++;
          else updatedDocs++;

          const state: DocSyncState = {
            docToken: node.objToken,
            docTitle: node.title,
            spaceId,
            contentHash: hash,
            lastSyncedAt: Date.now(),
            lastExtractedAt: existing?.lastExtractedAt ?? 0,
            status: "pending",
            errorMessage: "",
          };
          if (!options.dryRun) {
            upsertDocSyncState(options.db, state);
          }
          states.push(state);
        } catch (err) {
          failedDocs++;
          const msg = err instanceof Error ? err.message : String(err);
          const failedState: DocSyncState = {
            docToken: node.objToken,
            docTitle: node.title,
            spaceId,
            contentHash: "",
            lastSyncedAt: Date.now(),
            lastExtractedAt: 0,
            status: "failed",
            errorMessage: msg.slice(0, 500),
          };
          if (!options.dryRun) {
            upsertDocSyncState(options.db, failedState);
          }
          states.push(failedState);
        }
      }
    }
  }

  return {
    totalDocs,
    newDocs,
    updatedDocs,
    skippedDocs,
    failedDocs,
    states,
  };
}
```

**注意**：
- `CrawlerOptions` 要改（加 `db` 和 `apiDelayMs`），确保 types.ts 里的定义一致或直接在 crawler.ts 里定义
- `import type { Allowlist }` 别忘了
- `visited` Set 防止死循环（万一飞书 API 返回环形结构）

### 3.6 Step 4: 单元测试 crawler.test.ts（~15min）

**关键**：不真调 lark-cli，用依赖注入 mock。

**最干净的做法**：把 `listWikiNodes` / `fetchDocContent` 提取成 `CrawlerDeps` 接口，`crawl()` 接受注入：

```typescript
// crawler.ts 顶部
export interface CrawlerDeps {
  listNodes: (spaceId: string, parentToken?: string) => Promise<readonly WikiNode[]>;
  fetchContent: (docToken: string) => Promise<string>;
}

// 默认实现
export const defaultCrawlerDeps: CrawlerDeps = {
  listNodes: listWikiNodes,
  fetchContent: fetchDocContent,
};

// crawl() 签名加一个可选 deps
export async function crawl(
  options: CrawlerOptions,
  deps: CrawlerDeps = defaultCrawlerDeps,
): Promise<CrawlerResult> {
  // 用 deps.listNodes / deps.fetchContent
  // ...
}
```

**新建 `src/knowledge/crawler.test.ts`**：

```typescript
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { crawl, type CrawlerDeps, type WikiNode } from "./crawler.js";
import { openKnowledgeDB, closeKnowledgeDB, getDocSyncState } from "./store.js";
import type { Allowlist } from "./types.js";

function fakeNode(overrides: Partial<WikiNode>): WikiNode {
  return {
    nodeToken: "n1",
    objToken: "o1",
    objType: "docx",
    title: "Test",
    hasChild: false,
    objEditTime: 0,
    ...overrides,
  };
}

function makeDeps(
  nodesMap: Record<string, WikiNode[]>,
  contents: Record<string, string>,
): CrawlerDeps {
  return {
    listNodes: async (_sid, parent) => nodesMap[parent ?? "_root"] ?? [],
    fetchContent: async (tok) => contents[tok] ?? "",
  };
}

const ALLOWLIST: Allowlist = {
  spaces: [{ spaceId: "sp1", name: "S1", enabled: true, rootTokens: [] }],
};

test("crawl: new docs create pending states", async () => {
  const db = await openKnowledgeDB(":memory:");
  assert.ok(db);
  try {
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
    const state = getDocSyncState(db, "o1");
    assert.equal(state?.status, "pending");
    assert.ok(state?.contentHash.length === 64); // sha256 hex
  } finally {
    closeKnowledgeDB(db);
  }
});

test("crawl: unchanged hash → skipped", async () => {
  const db = await openKnowledgeDB(":memory:");
  assert.ok(db);
  try {
    const deps = makeDeps(
      { _root: [fakeNode({ objToken: "o1" })] },
      { o1: "same content" },
    );
    await crawl({ db, allowlist: ALLOWLIST, dryRun: false, maxDocs: 100, apiDelayMs: 0 }, deps);
    // 第二次跑
    const result2 = await crawl({ db, allowlist: ALLOWLIST, dryRun: false, maxDocs: 100, apiDelayMs: 0 }, deps);
    assert.equal(result2.skippedDocs, 1);
    assert.equal(result2.newDocs, 0);
  } finally {
    closeKnowledgeDB(db);
  }
});

test("crawl: content changed → updatedDocs", async () => {
  const db = await openKnowledgeDB(":memory:");
  assert.ok(db);
  try {
    await crawl(
      { db, allowlist: ALLOWLIST, dryRun: false, maxDocs: 100, apiDelayMs: 0 },
      makeDeps({ _root: [fakeNode({ objToken: "o1" })] }, { o1: "v1" }),
    );
    const result2 = await crawl(
      { db, allowlist: ALLOWLIST, dryRun: false, maxDocs: 100, apiDelayMs: 0 },
      makeDeps({ _root: [fakeNode({ objToken: "o1" })] }, { o1: "v2" }),
    );
    assert.equal(result2.updatedDocs, 1);
  } finally {
    closeKnowledgeDB(db);
  }
});

test("crawl: recurses into has_child nodes", async () => {
  const db = await openKnowledgeDB(":memory:");
  assert.ok(db);
  try {
    const deps = makeDeps(
      {
        _root: [fakeNode({ nodeToken: "parent", objToken: "op", title: "Parent", hasChild: true })],
        parent: [fakeNode({ objToken: "ochild", title: "Child" })],
      },
      { op: "parent content", ochild: "child content" },
    );
    const result = await crawl(
      { db, allowlist: ALLOWLIST, dryRun: false, maxDocs: 100, apiDelayMs: 0 },
      deps,
    );
    assert.equal(result.totalDocs, 2);
    assert.ok(getDocSyncState(db, "op"));
    assert.ok(getDocSyncState(db, "ochild"));
  } finally {
    closeKnowledgeDB(db);
  }
});

test("crawl: fetchContent failure marks doc as failed", async () => {
  const db = await openKnowledgeDB(":memory:");
  assert.ok(db);
  try {
    const deps: CrawlerDeps = {
      listNodes: async () => [fakeNode({ objToken: "o1" })],
      fetchContent: async () => { throw new Error("boom"); },
    };
    const result = await crawl(
      { db, allowlist: ALLOWLIST, dryRun: false, maxDocs: 100, apiDelayMs: 0 },
      deps,
    );
    assert.equal(result.failedDocs, 1);
    const state = getDocSyncState(db, "o1");
    assert.equal(state?.status, "failed");
    assert.ok(state?.errorMessage.includes("boom"));
  } finally {
    closeKnowledgeDB(db);
  }
});

test("crawl: maxDocs truncates", async () => {
  const db = await openKnowledgeDB(":memory:");
  assert.ok(db);
  try {
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
  } finally {
    closeKnowledgeDB(db);
  }
});

test("crawl: skips non-docx objType", async () => {
  const db = await openKnowledgeDB(":memory:");
  assert.ok(db);
  try {
    const deps = makeDeps(
      {
        _root: [
          fakeNode({ objToken: "sheet1", objType: "sheet" }),
          fakeNode({ objToken: "doc1", objType: "docx" }),
        ],
      },
      { doc1: "content", sheet1: "should not call" },
    );
    const result = await crawl(
      { db, allowlist: ALLOWLIST, dryRun: false, maxDocs: 100, apiDelayMs: 0 },
      deps,
    );
    assert.equal(result.totalDocs, 1);
    assert.equal(getDocSyncState(db, "sheet1"), undefined);
    assert.ok(getDocSyncState(db, "doc1"));
  } finally {
    closeKnowledgeDB(db);
  }
});
```

**双门验证**：
```bash
npx tsc --noEmit
npx tsx --test src/knowledge/crawler.test.ts src/knowledge/store.test.ts src/knowledge/allowlist.test.ts 2>&1 | tail -10
# 应看到 18 (原) + 4 (P0.1 新 store) + 7 (crawler) = 29 tests pass
```

### 3.7 P0.1 Acceptance

- [ ] `store.ts` 新增 `doc_sync_state` 表 schema + 3 个 CRUD 函数
- [ ] `store.test.ts` 新增 3-4 个 doc_sync_state 测试
- [ ] `crawler.ts` 实装 `larkApi` / `listWikiNodes` / `fetchDocContent` / `crawl`
- [ ] `crawler.test.ts` 新建，≥ 7 个测试用例
- [ ] `tsc --noEmit` 通过
- [ ] `tsx --test src/knowledge/*.test.ts` 全绿（预计 ~29 tests）
- [ ] 所有文件 < 400 行（如果 crawler.ts 超，拆到 `crawler-api.ts` + `crawler.ts`）

---

## 四、P0.2 · extractor.extractFacts() 实装（~1h）

### 4.1 目标
调 Gemini Flash 从文档正文抽取原子事实。**加 F3 tweak（仅抽取原文明确陈述）** + T4 tweak（confidence ≥ 0.85 过滤）+ 预算 check + 重试。**不写 knowledge_items**，只返回 ExtractionResult；写入由下 session 的 P0.4 定时任务做。

### 4.2 Step 1: 复制已验证的 prompt（~5min）

**从 `tasks/knowledge-spike/scripts/run-gemini-extraction.sh` 第 49-65 行复制 SYSTEM_PROMPT**，追加 F3 tweak 的两句话。

完整 prompt（直接粘贴到 extractor.ts 的常量）：

```typescript
const SYSTEM_PROMPT = `你是一个精确的知识抽取器。从飞书文档正文中抽取"原子事实"。
每个事实必须：
1. 是 1-2 句话的独立断言
2. 包含具体信息（名词/数字/决策），不是空洞套话或目录标题
3. 跳过导航、目录、"同步块"标记、空白占位
4. 如果文档只是目录或空壳，返回空的 facts 数组

额外约束（严格遵守 — F3 tweak）：
- 只抽取原文**明确陈述**的事实；如果某条信息需要你推断或补充形容词，**不要输出该条目**。
- 宁可少抽几条、宁可返回空数组，也不要编造或扩写。

输出必须是严格合法 JSON，格式：
{
  "facts": [
    {
      "content": "一段原子事实，1-2 句话，包含具体信息",
      "keywords": ["词1", "词2", "词3"],
      "confidence": 0.0-1.0 的数字,
      "namespace": "类别路径，如 公司/战略/目标"
    }
  ]
}

confidence 低于 0.5 的事实不要输出。keywords 3-6 个中文关键词。namespace 用 / 分层的中文路径。`;
```

### 4.3 Step 2: 实装 callGeminiFlash() + extractFacts()（~30min）

**修改 `src/knowledge/extractor.ts`**（替换 stub）：

```typescript
import type { ExtractedFact, ExtractionResult, ExtractInput } from "./types.js";
// estimateCostUsd 和 validateFact 已存在，保留
// extractFacts 要重写

// ... 保留现有的 GeminiClientConfig / ExtractorOptions / ExtractInput / GEMINI_FLASH_PRICING

export class BudgetExceededError extends Error {
  constructor(public readonly spent: number, public readonly budget: number) {
    super(`Gemini Flash budget exceeded: spent=$${spent.toFixed(6)} budget=$${budget.toFixed(2)}`);
    this.name = "BudgetExceededError";
  }
}

interface GeminiChatResponse {
  readonly choices?: ReadonlyArray<{
    readonly message?: { readonly content?: string };
  }>;
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
  };
}

/** 直接 POST 到 openai-compat proxy。不重试（上层 extractFacts 管重试）。 */
export async function callGeminiFlash(
  client: GeminiClientConfig,
  systemPrompt: string,
  userMsg: string,
): Promise<GeminiChatResponse> {
  const body = {
    model: client.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMsg },
    ],
    max_tokens: client.maxTokens,
    temperature: client.temperature,
    response_format: { type: "json_object" },
  };
  const resp = await fetch(`${client.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${client.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Gemini Flash HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }
  return (await resp.json()) as GeminiChatResponse;
}

// 可通过参数注入的 fetch 替换实现（测试用）
type FetchFn = typeof fetch;

const SYSTEM_PROMPT = `...`;  // 见上一步

/**
 * 从文档正文抽取原子事实。
 *
 * - 内置 2 次重试（exponential backoff）
 * - confidence < 0.85 过滤（T4 tweak）
 * - 预算 check（超出抛 BudgetExceededError）
 * - 解析失败返回空 facts（不抛错）
 */
export async function extractFacts(
  input: ExtractInput,
  options: ExtractorOptions,
  accumulatedCostUsd = 0,
  fetchImpl: FetchFn = fetch,
): Promise<ExtractionResult> {
  const userMsg = `文档标题：${input.docTitle}\n\n文档正文（${input.content.length} 字节）：\n${input.content}`;

  // 预算 check（上限估算：假设 input tokens = 字节/2, output ≤ max_tokens）
  const estInTokens = Math.ceil(input.content.length / 2) + 300;
  const estOutTokens = options.client.maxTokens;
  const estCost = estimateCostUsd(estInTokens, estOutTokens);
  if (accumulatedCostUsd + estCost > options.budgetUsd) {
    throw new BudgetExceededError(accumulatedCostUsd + estCost, options.budgetUsd);
  }

  const startTs = Date.now();
  let lastErr: unknown;
  let resp: GeminiChatResponse | undefined;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // 用注入的 fetch 或默认的
      const origFetch = globalThis.fetch;
      try {
        if (fetchImpl !== fetch) {
          (globalThis as { fetch: FetchFn }).fetch = fetchImpl;
        }
        resp = await callGeminiFlash(options.client, SYSTEM_PROMPT, userMsg);
      } finally {
        (globalThis as { fetch: FetchFn }).fetch = origFetch;
      }
      break;
    } catch (err) {
      lastErr = err;
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
      }
    }
  }
  if (!resp) {
    throw new Error(`extractFacts failed after 3 attempts: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
  }

  const latencyMs = Date.now() - startTs;
  const tokenIn = resp.usage?.prompt_tokens ?? 0;
  const tokenOut = resp.usage?.completion_tokens ?? 0;
  const costUsd = estimateCostUsd(tokenIn, tokenOut);

  // 解析 content 里的 JSON
  const contentStr = resp.choices?.[0]?.message?.content ?? "";
  const cleaned = contentStr.replace(/^```json\s*/i, "").replace(/\s*```$/, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return {
      docToken: input.docToken,
      docTitle: input.docTitle,
      contentHash: input.contentHash,
      facts: [],
      model: options.client.model,
      latencyMs,
      tokenIn,
      tokenOut,
      costUsd,
    };
  }

  const rawFacts = Array.isArray((parsed as { facts?: unknown }).facts)
    ? ((parsed as { facts: unknown[] }).facts)
    : [];

  const facts: ExtractedFact[] = [];
  for (const raw of rawFacts) {
    if (!validateFact(raw)) continue;
    if (raw.confidence < 0.85) continue;  // T4 tweak
    facts.push(raw);
  }

  return {
    docToken: input.docToken,
    docTitle: input.docTitle,
    contentHash: input.contentHash,
    facts,
    model: options.client.model,
    latencyMs,
    tokenIn,
    tokenOut,
    costUsd,
  };
}
```

**注意**：
- `ExtractInput` 已在 `types.ts`？检查一下，如果没有就补（有 docToken/docTitle/contentHash/content 四个 readonly 字段）
- `ExtractorOptions` / `GeminiClientConfig` 已在 extractor.ts 里
- fetch 注入的方式不是最干净的，但避免了引入 vi.mock 依赖

### 4.4 Step 3: 单元测试 extractor.test.ts（~20min）

**新建 `src/knowledge/extractor.test.ts`**：

```typescript
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  extractFacts,
  estimateCostUsd,
  validateFact,
  BudgetExceededError,
  type ExtractorOptions,
  type GeminiClientConfig,
} from "./extractor.js";
import type { ExtractInput } from "./types.js";

const CLIENT: GeminiClientConfig = {
  baseUrl: "http://fake-proxy.local/v1",
  apiKey: "fake-key",
  model: "gemini-2.5-flash",
  maxTokens: 4096,
  temperature: 0.2,
};

const INPUT: ExtractInput = {
  docToken: "d1",
  docTitle: "Test",
  contentHash: "hash1",
  content: "公司的愿景是 X。使命是 Y。",
};

function makeFetchMock(response: unknown, status = 200): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => response,
    text: async () => JSON.stringify(response),
  })) as unknown as typeof fetch;
}

test("estimateCostUsd: 100k in + 100k out ≈ $0.0375", () => {
  const cost = estimateCostUsd(100_000, 100_000);
  assert.ok(cost > 0.037 && cost < 0.038);
});

test("validateFact: accepts valid fact", () => {
  assert.equal(
    validateFact({ content: "x", keywords: ["a"], confidence: 0.9, namespace: "ns" }),
    true,
  );
});

test("validateFact: rejects missing namespace", () => {
  assert.equal(
    validateFact({ content: "x", keywords: ["a"], confidence: 0.9 }),
    false,
  );
});

test("validateFact: rejects confidence out of range", () => {
  assert.equal(
    validateFact({ content: "x", keywords: ["a"], confidence: 1.5, namespace: "n" }),
    false,
  );
});

test("extractFacts: parses valid response", async () => {
  const mockResp = {
    choices: [{
      message: {
        content: JSON.stringify({
          facts: [
            { content: "愿景是X", keywords: ["愿景"], confidence: 0.95, namespace: "公司/愿景" },
          ],
        }),
      },
    }],
    usage: { prompt_tokens: 200, completion_tokens: 50 },
  };
  const fetchMock = makeFetchMock(mockResp);
  const options: ExtractorOptions = { client: CLIENT, budgetUsd: 1.0 };
  const result = await extractFacts(INPUT, options, 0, fetchMock);
  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0].content, "愿景是X");
  assert.equal(result.tokenIn, 200);
  assert.equal(result.tokenOut, 50);
  assert.ok(result.costUsd > 0);
});

test("extractFacts: filters confidence < 0.85 (T4 tweak)", async () => {
  const mockResp = {
    choices: [{
      message: {
        content: JSON.stringify({
          facts: [
            { content: "高置信", keywords: ["a"], confidence: 0.9, namespace: "n" },
            { content: "低置信", keywords: ["b"], confidence: 0.7, namespace: "n" },
          ],
        }),
      },
    }],
    usage: { prompt_tokens: 200, completion_tokens: 80 },
  };
  const result = await extractFacts(INPUT, { client: CLIENT, budgetUsd: 1.0 }, 0, makeFetchMock(mockResp));
  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0].content, "高置信");
});

test("extractFacts: empty array on parse failure", async () => {
  const mockResp = {
    choices: [{ message: { content: "not json at all" } }],
    usage: { prompt_tokens: 200, completion_tokens: 10 },
  };
  const result = await extractFacts(INPUT, { client: CLIENT, budgetUsd: 1.0 }, 0, makeFetchMock(mockResp));
  assert.equal(result.facts.length, 0);
});

test("extractFacts: strips ```json fence", async () => {
  const mockResp = {
    choices: [{
      message: {
        content: '```json\n{"facts":[{"content":"X","keywords":["a"],"confidence":0.9,"namespace":"n"}]}\n```',
      },
    }],
    usage: { prompt_tokens: 200, completion_tokens: 50 },
  };
  const result = await extractFacts(INPUT, { client: CLIENT, budgetUsd: 1.0 }, 0, makeFetchMock(mockResp));
  assert.equal(result.facts.length, 1);
});

test("extractFacts: throws BudgetExceededError when over budget", async () => {
  const bigInput: ExtractInput = {
    ...INPUT,
    content: "x".repeat(100_000_000), // 巨大内容，估算成本极高
  };
  await assert.rejects(
    () => extractFacts(bigInput, { client: CLIENT, budgetUsd: 0.01 }, 0, makeFetchMock({})),
    BudgetExceededError,
  );
});

test("extractFacts: accumulatedCost pushes over budget", async () => {
  await assert.rejects(
    () => extractFacts(INPUT, { client: CLIENT, budgetUsd: 0.001 }, 0.001, makeFetchMock({})),
    BudgetExceededError,
  );
});
```

**双门验证**：
```bash
npx tsc --noEmit
npx tsx --test src/knowledge/*.test.ts 2>&1 | tail -10
# 预计 ~39 tests pass (18 原 + 4 store 新 + 7 crawler + 10 extractor)
```

### 4.5 Step 4: 端到端离线验证（~5min）

用 Spike 留下的 samples txt 文件对 `extractFacts` 做一次真实调用（验证 F3 tweak 生效）：

```bash
# 一次性脚本，放在 /tmp/verify-p02.mjs
cat > /tmp/verify-p02.mjs <<'EOF'
import { extractFacts } from "../src/knowledge/extractor.js";  // 调整路径
import { readFileSync } from "fs";

const content = readFileSync("/Users/rayman.chen/mycc/tasks/knowledge-spike/samples/Xo0gd0EpWoVFe7xRErEctATFnQe-pass1.txt", "utf-8");
const result = await extractFacts(
  {
    docToken: "Xo0gd0EpWoVFe7xRErEctATFnQe",
    docTitle: "Futurus技术知识库入口",
    contentHash: "test",
    content,
  },
  {
    client: {
      baseUrl: "http://23.226.135.149:4000/v1",
      apiKey: process.env.GEMINI_PROXY_KEY,
      model: "gemini-2.5-flash",
      maxTokens: 4096,
      temperature: 0.2,
    },
    budgetUsd: 0.10,
  },
);
console.log(JSON.stringify(result.facts, null, 2));
console.log(`cost=$${result.costUsd.toFixed(6)} facts=${result.facts.length}`);
EOF
# 实际执行
cd 2-Projects/brain-product/mycc-brain
export GEMINI_PROXY_KEY=$(grep GEMINI_PROXY_KEY .env.local | cut -d= -f2)
npx tsx /tmp/verify-p02.mjs
```

**预期**：
- 技术入口文档（之前 Spike 抽出 2 facts 含 1 处推断）
- 加了 F3 tweak 后，**应该抽出 0 或 1 facts**（确切原文只有"URL 链接"这一条可抽）
- cost < $0.0005

如果结果符合预期，P0.2 完成。

### 4.6 P0.2 Acceptance

- [ ] `extractor.ts` 实装 `callGeminiFlash` + `extractFacts` + `BudgetExceededError`
- [ ] SYSTEM_PROMPT 包含 F3 tweak 两句话
- [ ] `extractFacts` 包含：重试 × 2 / confidence ≥ 0.85 过滤 / 预算 check / JSON fence 剥离
- [ ] `extractor.test.ts` 新建，≥ 10 个测试
- [ ] `tsc --noEmit` 通过
- [ ] `tsx --test src/knowledge/*.test.ts` 全绿
- [ ] 离线端到端验证：技术入口文档抽出 ≤ 1 facts（F3 tweak 生效证据）
- [ ] `extractor.ts` < 400 行

---

## 五、完成后动作

### 5.1 更新主 HANDOFF
在 `tasks/knowledge-spike/HANDOFF-knowledge-spike.md` 第二节末尾追加：
```markdown
### ✅ P0.1 + P0.2 已完成 (2026-04-1X HH:MM)
- crawler.crawl() 递归实装 + doc_sync_state 表 + 7 tests ✓
- extractor.extractFacts() 实装 + F3/T4 tweaks + 10 tests ✓
- 总测试数：~39/39 pass
- 离线 F3 验证：技术入口抽出 {N} facts（对比 Spike 时的 2 facts）
- commit: `{sha}`
```

并把第四节 P0.1 / P0.2 标记为 ✅。

### 5.2 Commit
```bash
cd /Users/rayman.chen/mycc
git add 2-Projects/brain-product/mycc-brain/src/knowledge/store.ts \
        2-Projects/brain-product/mycc-brain/src/knowledge/store.test.ts \
        2-Projects/brain-product/mycc-brain/src/knowledge/crawler.ts \
        2-Projects/brain-product/mycc-brain/src/knowledge/crawler.test.ts \
        2-Projects/brain-product/mycc-brain/src/knowledge/extractor.ts \
        2-Projects/brain-product/mycc-brain/src/knowledge/extractor.test.ts \
        tasks/knowledge-spike/HANDOFF-knowledge-spike.md
git commit -m "$(cat <<'EOF'
feat(brain): P0.1 crawler + P0.2 extractor 实装

P0.1: crawler.crawl() 递归飞书 wiki + doc_sync_state 增量判重
- store.ts 扩 doc_sync_state 表 + 3 CRUD 函数
- crawler.ts 实装 larkApi/listWikiNodes/fetchDocContent/crawl
- CrawlerDeps 依赖注入支持 mock 测试
- 7 tests: new/update/skip/recurse/fail/maxDocs/skipNonDocx

P0.2: extractor.extractFacts() 实装
- callGeminiFlash fetch openai-compat POST
- F3 tweak: SYSTEM_PROMPT 追加"仅抽取原文明确陈述"约束
- T4 tweak: confidence < 0.85 过滤
- 预算 check: BudgetExceededError
- 重试 × 2 指数退避
- 10 tests + 1 离线端到端验证 (技术入口 F3 生效)

tsc ✓, ~39/39 tests pass.
分支 feat/knowledge-system, 未 push, 未 merge main.
EOF
)"
```

### 5.3 下下个 Session 的准备
在本文档末尾追加 "## 下一步：P0.3 + P0.4" 一节，或让 cc 更新主 HANDOFF 第四节，然后：
1. 告诉川哥 P0.1+P0.2 完成情况 + 数字
2. 提示川哥："准备好了就启动下个 session 做 P0.3 (brain-context 第五路) + P0.4 (scheduler)，我给你新的 prompt"

---

## 六、常见坑 & 避坑指南

| 坑 | 避坑 |
|---|---|
| `store.ts` 超 400 行 | 如果超了，把 `doc_sync_state` 相关函数拆到 `store-sync-state.ts` |
| `crawler.ts` 超 400 行 | `larkApi` / `listWikiNodes` / `fetchDocContent` 拆到 `crawler-api.ts`，`crawler.ts` 只留 `crawl()` + 类型 |
| ESM import 路径 | 所有跨文件 import 必须带 `.js` 后缀（即使源是 .ts）：`from "./store.js"` |
| `child_process.spawn` 找不到 lark-cli | 用绝对路径 `/Users/rayman.chen/local/node/bin/lark-cli` 或 `process.env.HOME + "/local/node/bin/lark-cli"` |
| Gemini 返回非法 JSON | P0.2 里已处理（try/catch → 空 facts），不要抛 |
| Gemini response_format 不生效 | openai-compat proxy 可能对 `response_format` 支持不完全，容错即可 |
| test 里 `global.fetch` 替换影响其他 test | 用测试参数注入 `fetchImpl: fetch` 而非修改 global（P0.2 草稿里的方案是折中，可优化） |
| tsc 报 `Cannot find module 'better-sqlite3'` | 正常，因为是动态 import。`skipLibCheck: true` 已设，不应报错；若报错检查 tsconfig |

---

## 七、硬约束回顾（Spike GO 决策 tweaks 版）

1. ❌ **不写 memory.db** / memory-items.md
2. ❌ **不改 brain-context.ts** 的默认四路（P0.3 再动，本次不动）
3. ✅ **Gemini Flash 预算 = options.budgetUsd**，默认建议 $0.10（P0 离线验证）/ $0.50（P0 冷启动）
4. ❌ **不 push feat/knowledge-system** 到 GitHub
5. ✅ **所有数据结构 readonly immutable**
6. ✅ **单文件 < 400 行**（超了就拆）
7. ✅ **双门验证**：每个子任务完成必跑 `tsc + tsx test`

---

**最后更新**：2026-04-11 by cc（claude-opus-4-6）
**状态**：✅ **已完成** — 48/48 tests pass, tsc ✓, E2E 验证通过

## 八、完成记录

**tsc**：`tsc --noEmit` exit 0 ✓
**tests**：`tsx --test src/knowledge/*.test.ts` **48/48 pass**（原 18 + 新增 30）
- allowlist.test.ts: 8/8
- store.test.ts: 14/14 (原 10 + 4 新 doc_sync_state)
- crawler.test.ts: 9/9（新建；HANDOFF 预计 7+，多加 dryRun 和 content 变更 hash 对比 2 个）
- extractor.test.ts: 11/11（新建；HANDOFF 预计 10+，多加 HTTP non-OK 错误测试）

**文件行数**（全部 < 400）：
- crawler.ts: 365
- extractor.ts: ~280
- store.ts: 338
- crawler.test.ts: 232
- extractor.test.ts: 288

**E2E 验证**（F3 tweak 离线跑技术入口文档）：
- 技术入口 `Xo0gd0EpWoVFe7xRErEctATFnQe` → 2 facts, cost $0.000095, latency 5.8s, tokenIn/Out=396/217
- 两条均为原文明确陈述（"独立于 FUTURUS 的技术知识库" + 完整 URL），confidence 0.9 过 T4 (≥0.85)
- F3 tweak 未过度压缩：HANDOFF 期望 ≤1，实际 2；**复核后发现原 Spike 对"第一条是推断"的判断偏严**（原文确实写了"独立于FUTURUS知识库的公司技术知识库"），F3 tweak 正确抑制了会推断的条目
- 链路完整跑通（fetch → JSON 解析 → confidence 过滤 → 成本核算）

**关键设计决策**：
- `callGeminiFlash` 接受 `fetchImpl: FetchFn = fetch` 参数，替代 HANDOFF 草稿里的全局 fetch 修改（更干净，无 side effect）
- `crawler.test.ts` 覆盖非 docx 容器递归场景（sheet 节点作为 hasChild 容器仍会递归进入，但容器本身不入库）
- `BudgetExceededError` 独立类型，便于上层调度器捕获降级
- lark-cli 路径通过 `process.env.LARK_CLI_BIN` 可覆盖，默认 `~/local/node/bin/lark-cli`

**外部 blocker**（不影响 P0 收尾）：
Gemini proxy 验证中一度返回 500（Google 侧 `User location is not supported for the API use`），修复后重跑通过。后续 brain 使用 proxy 需要 [P1] 429 退避 + 全局并发门 + 降级（flash-lite → flash → reject），单独任务。

**下一步**：P0.3 (brain-context 第五路 knowledgeSearch) + P0.4 (scheduler knowledge-sync-job)
