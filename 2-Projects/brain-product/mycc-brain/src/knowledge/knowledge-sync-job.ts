/**
 * knowledge-sync-job.ts — P0.4 外挂知识系统的调度入口
 *
 * 两段式任务：
 *   Phase A: 调 crawler.crawl() 遍历 allowlist，把新 / 更新的文档落成
 *            doc_sync_state(status=pending)。
 *   Phase B: 从 doc_sync_state 取 pending 批次，逐篇重新拉正文 →
 *            调 extractor.extractFacts() → 把 ExtractedFact 落库到
 *            knowledge_items，并把 state 迁移到 extracted / failed。
 *
 * 硬约束：
 *   - 预算硬顶 budgetUsd（默认 $0.50），超出抛 BudgetExceededError 即
 *     立刻 break 循环并标记 stoppedByBudget=true。
 *   - 失败隔离：单篇 extract 失败（普通 Error）不中断整个 job；只在
 *     遇到 BudgetExceededError 时才整体中断。
 *   - 所有返回结构 readonly；函数内部变量 immutable-friendly。
 *   - 依赖注入 SyncJobDeps，方便测试 mock crawl / fetchDocContent /
 *     extractFacts 而不真的调 lark-cli + Gemini。
 *
 * 调用方：src/server.ts 的 setInterval 调度器（每日 03:00）。
 */
import {
  crawl,
  fetchDocContent,
  type CrawlerResult,
} from "./crawler.js";
import {
  extractFacts,
  BudgetExceededError,
  type GeminiClientConfig,
} from "./extractor.js";
import { loadAllowlist } from "./allowlist.js";
import {
  openKnowledgeDB,
  closeKnowledgeDB,
  listDocSyncStatesByStatus,
  insertKnowledgeItems,
  upsertDocSyncState,
  type KnowledgeDatabase,
} from "./store.js";
import type {
  DocSyncState,
  KnowledgeItemInput,
  ExtractedFact,
} from "./types.js";

// ---------------------------------------------------------------------------
// 公共类型
// ---------------------------------------------------------------------------

export interface SyncJobOptions {
  readonly budgetUsd: number;
  readonly maxDocs: number;
  readonly allowlistPath: string;
  readonly knowledgeDbPath: string;
  readonly geminiApiKey: string;
  readonly geminiBaseUrl?: string;
  readonly geminiModel?: string;
  readonly pendingBatchSize?: number;
}

export interface SyncJobResult {
  readonly crawlerResult: CrawlerResult;
  readonly docsProcessed: number;
  readonly docsExtracted: number;
  readonly docsFailed: number;
  readonly factsInserted: number;
  readonly totalCostUsd: number;
  readonly errors: readonly string[];
  readonly stoppedByBudget: boolean;
}

/** 依赖注入——方便测试 mock */
export interface SyncJobDeps {
  readonly crawl: typeof crawl;
  readonly fetchDocContent: typeof fetchDocContent;
  readonly extractFacts: typeof extractFacts;
}

export const defaultSyncJobDeps: SyncJobDeps = {
  crawl,
  fetchDocContent,
  extractFacts,
};

// ---------------------------------------------------------------------------
// 默认值
// ---------------------------------------------------------------------------

/**
 * 默认 LLM endpoint：火山方舟 Coding Plan（2026-04-11 起替代 Gemini Flash proxy）。
 *
 * 切换原因：
 * - Gemini proxy 429 限流，27/30 docs 冷启动失败
 * - 方舟 Coding Plan 订阅制，无单次成本，无 rate limit 阻塞
 * - doubao-seed-2.0-pro 关 thinking 后 latency 5s，质量与 Gemini Flash 相当
 *
 * 关键字段：
 * - thinking: { type: "disabled" } —— 关掉 reasoning_tokens，把延迟从 18s 降到 5s
 */
const DEFAULT_GEMINI_BASE_URL = "https://ark.cn-beijing.volces.com/api/coding/v3";
const DEFAULT_GEMINI_MODEL = "doubao-seed-2.0-pro";
const DEFAULT_EXTRA_BODY: Readonly<Record<string, unknown>> = Object.freeze({
  thinking: { type: "disabled" },
});
const DEFAULT_PENDING_BATCH_SIZE = 50;
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TEMPERATURE = 0.2;
/** 预算安全边界：累积成本接近硬顶 95% 时不再发起新调用 */
const BUDGET_SAFETY_RATIO = 0.95;

// ---------------------------------------------------------------------------
// 纯转换函数：ExtractedFact → KnowledgeItemInput
// ---------------------------------------------------------------------------

/**
 * 把 extractor 返回的 fact 展开成 knowledge_items 的入库结构。
 * 构造 sourceUrl 用 feishu.cn/docx/<token>（稳定、可点击的链接）。
 */
export function factToKnowledgeInput(
  fact: ExtractedFact,
  state: DocSyncState,
): KnowledgeItemInput {
  return {
    docToken: state.docToken,
    docTitle: state.docTitle,
    spaceId: state.spaceId,
    namespace: fact.namespace,
    content: fact.content,
    keywords: fact.keywords,
    confidence: fact.confidence,
    sourceUrl: `https://feishu.cn/docx/${state.docToken}`,
    extractedBy: "gemini-flash",
  };
}

// ---------------------------------------------------------------------------
// runKnowledgeSyncJob
// ---------------------------------------------------------------------------

/**
 * 知识同步 job 入口。
 *
 * 执行顺序：
 *   1. loadAllowlist → 拿到白名单
 *   2. openKnowledgeDB → 拿到 DB 句柄
 *   3. Phase A: deps.crawl() 遍历 allowlist，写 pending 状态
 *   4. Phase B: listDocSyncStatesByStatus("pending") 拉批次，逐篇：
 *      - 预算安全边界 check
 *      - deps.fetchDocContent(docToken) 重取正文
 *      - deps.extractFacts(...) 抽取
 *      - 累加 totalCostUsd
 *      - 成功：insertKnowledgeItems + upsertDocSyncState(status="extracted")
 *      - 失败：upsertDocSyncState(status="failed") + errors.push()
 *      - BudgetExceededError：stoppedByBudget=true, break
 *   5. finally: closeKnowledgeDB
 */
export async function runKnowledgeSyncJob(
  options: SyncJobOptions,
  deps: SyncJobDeps = defaultSyncJobDeps,
): Promise<SyncJobResult> {
  const allowlist = loadAllowlist(options.allowlistPath);
  const db = await openKnowledgeDB(options.knowledgeDbPath);
  if (!db) {
    throw new Error(
      `runKnowledgeSyncJob: failed to open knowledge DB at ${options.knowledgeDbPath} (better-sqlite3 missing?)`,
    );
  }

  try {
    return await runWithDb(db, allowlist, options, deps);
  } finally {
    closeKnowledgeDB(db);
  }
}

/** 真正的执行体——把 DB 握在手上，方便 finally 关掉 */
async function runWithDb(
  db: KnowledgeDatabase,
  allowlist: ReturnType<typeof loadAllowlist>,
  options: SyncJobOptions,
  deps: SyncJobDeps,
): Promise<SyncJobResult> {
  // Phase A: 爬取
  const crawlerResult = await deps.crawl({
    db,
    allowlist,
    dryRun: false,
    maxDocs: options.maxDocs,
    apiDelayMs: 300,
  });

  // Phase B: 抽取
  const pendingBatchSize = options.pendingBatchSize ?? DEFAULT_PENDING_BATCH_SIZE;
  const pendings = listDocSyncStatesByStatus(db, "pending", pendingBatchSize);

  // 仅在使用方舟默认 baseUrl 时注入 thinking 字段——切回其它 openai-compat
  // 端点时（如 Gemini proxy）不会污染 body（feedback_openai_compat_fields）
  const usingArkDefault =
    (options.geminiBaseUrl ?? DEFAULT_GEMINI_BASE_URL) === DEFAULT_GEMINI_BASE_URL;
  const client: GeminiClientConfig = {
    baseUrl: options.geminiBaseUrl ?? DEFAULT_GEMINI_BASE_URL,
    apiKey: options.geminiApiKey,
    model: options.geminiModel ?? DEFAULT_GEMINI_MODEL,
    maxTokens: DEFAULT_MAX_TOKENS,
    temperature: DEFAULT_TEMPERATURE,
    extraBody: usingArkDefault ? DEFAULT_EXTRA_BODY : undefined,
  };

  let accumulatedCost = 0;
  let docsProcessed = 0;
  let docsExtracted = 0;
  let docsFailed = 0;
  let factsInserted = 0;
  let stoppedByBudget = false;
  const errors: string[] = [];

  for (const state of pendings) {
    // 预算安全边界：累积成本已接近硬顶 → 停止发起新调用
    if (accumulatedCost > options.budgetUsd * BUDGET_SAFETY_RATIO) {
      stoppedByBudget = true;
      break;
    }

    try {
      const content = await deps.fetchDocContent(state.docToken);
      const result = await deps.extractFacts(
        {
          docToken: state.docToken,
          docTitle: state.docTitle,
          contentHash: state.contentHash,
          content,
        },
        {
          client,
          budgetUsd: options.budgetUsd,
        },
        accumulatedCost,
      );

      accumulatedCost += result.costUsd;

      if (result.facts.length > 0) {
        const inputs: readonly KnowledgeItemInput[] = result.facts.map((f) =>
          factToKnowledgeInput(f, state),
        );
        insertKnowledgeItems(db, inputs);
        factsInserted += inputs.length;
      }

      const nextState: DocSyncState = {
        docToken: state.docToken,
        docTitle: state.docTitle,
        spaceId: state.spaceId,
        contentHash: state.contentHash,
        lastSyncedAt: state.lastSyncedAt,
        lastExtractedAt: Date.now(),
        status: "extracted",
        errorMessage: "",
      };
      upsertDocSyncState(db, nextState);

      docsExtracted += 1;
      docsProcessed += 1;
    } catch (err) {
      // 预算耗尽 ≠ 单篇失败：保持 pending 状态、不脏化统计，直接中断
      if (err instanceof BudgetExceededError) {
        stoppedByBudget = true;
        break;
      }

      const msg = err instanceof Error ? err.message : String(err);
      docsFailed += 1;
      docsProcessed += 1;
      errors.push(`${state.docToken}: ${msg}`);

      const failedState: DocSyncState = {
        docToken: state.docToken,
        docTitle: state.docTitle,
        spaceId: state.spaceId,
        contentHash: state.contentHash,
        lastSyncedAt: state.lastSyncedAt,
        lastExtractedAt: state.lastExtractedAt,
        status: "failed",
        errorMessage: msg.slice(0, 500),
      };
      // upsert 本身若炸就让它炸，我们也无能为力
      upsertDocSyncState(db, failedState);
    }
  }

  return {
    crawlerResult,
    docsProcessed,
    docsExtracted,
    docsFailed,
    factsInserted,
    totalCostUsd: accumulatedCost,
    errors,
    stoppedByBudget,
  };
}
