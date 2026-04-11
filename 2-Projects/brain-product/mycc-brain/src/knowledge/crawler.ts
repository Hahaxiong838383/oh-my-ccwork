/**
 * crawler.ts — 飞书 wiki 增量爬取器（P0.1 实装）
 *
 * 架构：
 *   1. 遍历 allowlist.spaces (enabled=true)
 *   2. 对每个 space 调 `GET /open-apis/wiki/v2/spaces/{id}/nodes` 递归（DFS）
 *   3. 对 docx 节点调 `GET /open-apis/docx/v1/documents/{obj_token}/raw_content`
 *   4. 计算 contentHash，与 doc_sync_state.contentHash 对比（增量）
 *   5. hash 变化才写入 doc_sync_state（status=pending，等 extractor 处理）
 *
 * 设计决策：
 *   - **lark-cli 子进程调用**：不自己管 auth token（F2 发现），复用 lark-cli 的
 *     user token + 自动刷新。每次启动 ~200ms CLI 开销可忽略。
 *   - **依赖注入**：listNodes / fetchContent 通过 CrawlerDeps 注入，测试可 mock。
 *   - **visited set 只跟踪 parentToken**：防止 API 返回环形结构导致死循环。
 *   - **递归到叶子（F1 tweak）**：根节点多数是导航空壳，必须 hasChild=true 的递归。
 *   - **预算保护**：maxDocs 硬上限，超出即停。
 *   - **无状态函数**：crawl() 返回新 CrawlerResult，不 mutate 入参。
 */
import { spawn } from "node:child_process";
import type {
  Allowlist,
  DocSyncState,
  DocSyncStatus,
} from "./types.js";
import {
  getDocSyncState,
  upsertDocSyncState,
  type KnowledgeDatabase,
} from "./store.js";
import { getEnabledSpaceIds } from "./allowlist.js";

/** 飞书 wiki 节点（来自 /open-apis/wiki/v2/spaces/{id}/nodes API） */
export interface WikiNode {
  readonly nodeToken: string;
  readonly objToken: string;
  /** "docx" | "sheet" | "bitable" | "mindnote" | ... */
  readonly objType: string;
  readonly title: string;
  readonly hasChild: boolean;
  /** unix seconds */
  readonly objEditTime: number;
}

/** crawler 依赖注入（测试用 mock） */
export interface CrawlerDeps {
  readonly listNodes: (
    spaceId: string,
    parentToken?: string,
  ) => Promise<readonly WikiNode[]>;
  readonly fetchContent: (docToken: string) => Promise<string>;
}

export interface CrawlerOptions {
  readonly db: KnowledgeDatabase;
  readonly allowlist: Allowlist;
  /** 只打印不落盘（P0 debug 用） */
  readonly dryRun: boolean;
  /** 单次爬取最多处理的 docx 节点数（预算保护） */
  readonly maxDocs: number;
  /** 每次 lark-cli 调用之间的延迟（ms），防限流 */
  readonly apiDelayMs: number;
}

export interface CrawlerResult {
  readonly totalDocs: number;
  readonly newDocs: number;
  readonly updatedDocs: number;
  readonly skippedDocs: number;
  readonly failedDocs: number;
  readonly states: readonly DocSyncState[];
}

// ---------------------------------------------------------------------------
// 纯工具函数
// ---------------------------------------------------------------------------

/**
 * 纯函数：给定正文计算 sha256。
 * Spike 的 content-hash 稳定性测试也走这个函数。
 */
export async function computeContentHash(content: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

/**
 * 状态机合法性校验。
 *
 * 允许的状态转移：
 *   pending   → synced | failed
 *   synced    → extracted | failed | pending (重爬)
 *   extracted → pending (下一轮增量) | failed
 *   failed    → pending (重试)
 */
export function canTransition(
  from: DocSyncStatus,
  to: DocSyncStatus,
): boolean {
  const valid: Record<DocSyncStatus, readonly DocSyncStatus[]> = {
    pending: ["synced", "failed"],
    synced: ["extracted", "failed", "pending"],
    extracted: ["pending", "failed"],
    failed: ["pending"],
  };
  return valid[from]?.includes(to) ?? false;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// lark-cli 子进程调用（默认 deps 使用）
// ---------------------------------------------------------------------------

/** lark-cli 的绝对路径。若 PATH 里能找到就用 "lark-cli"。 */
const LARK_CLI_BIN =
  process.env.LARK_CLI_BIN ?? `${process.env.HOME}/local/node/bin/lark-cli`;

/** 调 `lark-cli api` 子命令，返回解析后的 JSON（原生飞书 OpenAPI 响应包装体） */
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
    const proc = spawn(LARK_CLI_BIN, args);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => {
      stdout += String(d);
    });
    proc.stderr.on("data", (d) => {
      stderr += String(d);
    });
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `lark-cli ${args.join(" ")} exit ${code}: ${stderr.slice(0, 300)}`,
          ),
        );
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(
          new Error(
            `lark-cli returned invalid JSON: ${stdout.slice(0, 200)}`,
          ),
        );
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
          obj_edit_time: string | number;
        }>;
        page_token?: string;
        has_more?: boolean;
      };
    };
    if (resp.code !== 0) {
      throw new Error(
        `listWikiNodes failed: code=${resp.code} msg=${resp.msg}`,
      );
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
    throw new Error(
      `fetchDocContent failed: code=${resp.code} msg=${resp.msg}`,
    );
  }
  return resp.data?.content ?? "";
}

/** 默认 deps：走 lark-cli 子进程 */
export const defaultCrawlerDeps: CrawlerDeps = {
  listNodes: listWikiNodes,
  fetchContent: fetchDocContent,
};

// ---------------------------------------------------------------------------
// crawl() 主入口
// ---------------------------------------------------------------------------

/**
 * 爬取入口：遍历 allowlist → 递归列节点 → 拉 docx 正文 → 写 doc_sync_state。
 *
 * - **不调 extractor**：只负责"拉正文 + 记状态"；抽取由下一阶段 scheduler 驱动。
 * - **增量判重**：contentHash 相同 → skippedDocs++，不重写 DB。
 * - **失败隔离**：单篇文档 fetchContent 失败不中断整体；记为 status=failed。
 */
export async function crawl(
  options: CrawlerOptions,
  deps: CrawlerDeps = defaultCrawlerDeps,
): Promise<CrawlerResult> {
  const spaceIds = getEnabledSpaceIds(options.allowlist);
  const states: DocSyncState[] = [];
  let totalDocs = 0;
  let newDocs = 0;
  let updatedDocs = 0;
  let skippedDocs = 0;
  let failedDocs = 0;

  for (const spaceId of spaceIds) {
    // BFS 队列（parentToken undefined = 根）
    const queue: Array<{ parentToken?: string }> = [{ parentToken: undefined }];
    const visitedParents = new Set<string>();

    while (queue.length > 0 && totalDocs < options.maxDocs) {
      const current = queue.shift();
      if (!current) break;
      const { parentToken } = current;

      let nodes: readonly WikiNode[];
      try {
        nodes = await deps.listNodes(spaceId, parentToken);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (!options.dryRun) {
          console.error(
            `[crawler] listNodes failed space=${spaceId} parent=${parentToken ?? "_root"}: ${errMsg}`,
          );
        }
        continue;
      }
      if (options.apiDelayMs > 0) await delay(options.apiDelayMs);

      for (const node of nodes) {
        if (totalDocs >= options.maxDocs) break;

        // 递归入队子节点（无论 objType，允许 sheet 下挂 docx 的情况）
        if (node.hasChild && !visitedParents.has(node.nodeToken)) {
          visitedParents.add(node.nodeToken);
          queue.push({ parentToken: node.nodeToken });
        }

        // 只处理 docx 叶子
        if (node.objType !== "docx") continue;

        totalDocs++;

        // 拉正文 + 算 hash
        try {
          const content = await deps.fetchContent(node.objToken);
          if (options.apiDelayMs > 0) await delay(options.apiDelayMs);
          const hash = await computeContentHash(content);

          const existing = getDocSyncState(options.db, node.objToken);
          if (existing && existing.contentHash === hash) {
            skippedDocs++;
            continue;
          }

          const isNew = !existing;
          if (isNew) {
            newDocs++;
          } else {
            updatedDocs++;
          }

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
