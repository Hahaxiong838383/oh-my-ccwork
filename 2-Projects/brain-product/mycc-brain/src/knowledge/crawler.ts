/**
 * crawler.ts — 飞书 wiki 增量爬取器（stub）
 *
 * Spike 阶段只定义类型 + 两个纯函数（computeContentHash / canTransition）。
 * 真正的 `crawl()` 实现留给 P0，Spike 用 tasks/knowledge-spike/scripts/ 下的
 * 一次性 shell 脚本完成文档拉取。
 *
 * P0 实装路径（TODO）：
 *   1. 遍历 allowlist.spaces (enabled=true)
 *   2. 对每个 space 调 `GET /open-apis/wiki/v2/spaces/{id}/nodes` 递归
 *   3. 对 docx 节点调 `GET /open-apis/docx/v1/documents/{obj_token}/raw_content`
 *   4. 计算 contentHash，与 doc_sync_state.lastHash 对比（增量）
 *   5. hash 变化才入队 extractor
 *   6. 更新 doc_sync_state 表（该表 P0 新建）
 */
import type {
  Allowlist,
  DocSyncState,
  DocSyncStatus,
} from "./types.js";

export interface CrawlerOptions {
  readonly allowlist: Allowlist;
  /** 只打印不落盘（P0 debug 用） */
  readonly dryRun: boolean;
  /** 单次爬取最多处理的 doc 数量（预算保护） */
  readonly maxDocs: number;
}

export interface CrawlerResult {
  readonly totalDocs: number;
  readonly newDocs: number;
  readonly updatedDocs: number;
  readonly skippedDocs: number;
  readonly failedDocs: number;
  readonly states: readonly DocSyncState[];
}

/** 爬取入口（stub，P0 实装） */
export async function crawl(
  _options: CrawlerOptions,
): Promise<CrawlerResult> {
  throw new Error(
    "crawler.crawl is not implemented (stub). See docstring for P0 plan.",
  );
}

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
