/**
 * 记忆系统 SQLite 统一存储 v5.5
 *
 * 架构：md 文件是主数据源（人类可编辑），SQLite 是派生索引（自动重建）。
 * - memory-items.md 编辑后 → 检测 mtime 变更 → 重建 items + FTS5 + vectors
 * - 对话记忆、检索轨迹 → 直接写 SQLite（程序产生，无需 md 备份）
 *
 * 技术选型：
 * - better-sqlite3：同步 API，零 ORM 开销
 * - sqlite-vec：cosine KNN 向量搜索
 * - FTS5：全文检索（items + traces）
 * - WAL 模式：支持并发读
 *
 * 降级：SQLite 不可用时回退到文件读取（context-loader / chat-memory 的 v4 逻辑）
 */
import Database from "better-sqlite3";
export interface ItemRow {
    id: string;
    category: string;
    scope: string;
    content: string;
    stars: number;
    write_date: string | null;
    event_date: string | null;
    chain_type: string | null;
    chain_ref: string | null;
}
export interface CentroidRow {
    category: string;
    scope: string;
    item_count: number;
    l0_summary: string | null;
}
export interface VectorRow {
    id: string;
    distance: number;
}
export interface TraceRow {
    id: number;
    timestamp: string;
    query: string;
    pipeline: string;
    rrf: string;
    injected: string;
    budget_used: number;
    budget_limit: number;
}
/**
 * 获取 SQLite 数据库连接（单例）。
 * 不可用时返回 null，调用方回退到文件逻辑。
 */
export declare function getDB(cwd: string): Database.Database | null;
/**
 * 关闭数据库连接（进程退出时调用）
 */
export declare function closeDB(): void;
/**
 * 从 memory-items.md 同步到 SQLite items 表。
 * 检测 mtime 变更，仅在文件被编辑后重建。
 */
export declare function syncItemsFromMd(cwd: string): boolean;
/**
 * 从 memory-vectors.json 同步到 SQLite items_vec 表。
 * 检测 mtime 变更，仅在文件被修改后重建。
 */
export declare function syncVectorsFromJson(cwd: string): boolean;
/**
 * 同步所有 md 源到 SQLite（启动时 + 定期调用）。
 */
export declare function syncAll(cwd: string): boolean;
/**
 * 按类别查询 items（替代从 md 文件 split section）
 */
export declare function getItemsByCategory(cwd: string, category: string): ItemRow[];
/**
 * 获取所有类别及其条目数（供 L0 概览生成）
 */
export declare function getCategorySummary(cwd: string): Array<{
    category: string;
    count: number;
}>;
/**
 * 用 centroid 向量做类别粗筛：返回与 query 向量最相似的类别。
 * 比逐条比对快（~20 次 vs ~274 次），后续精排只看命中类别的 items。
 */
export declare function centroidSearch(cwd: string, queryVec: number[], topK?: number): Array<{
    category: string;
    similarity: number;
}>;
/**
 * FTS5 全文搜索 items
 */
export declare function searchItems(cwd: string, query: string, limit?: number): ItemRow[];
/**
 * 向量 KNN 搜索（替代 embedding.ts 的 vectorSearch）
 */
export declare function vectorSearchDB(cwd: string, queryVec: number[], topK?: number): VectorRow[];
/** 保存对话摘要 */
export declare function saveSummary(cwd: string, chatId: string, summary: string): void;
/** 读取对话摘要 */
export declare function getSummaries(cwd: string, chatId: string): string[];
/** 保存 DAG 节点 */
export declare function saveDAGNodes(cwd: string, chatId: string, nodes: Array<{
    id: string;
    level: number;
    sourceStart: number;
    sourceEnd: number;
    summary: string;
    tokenCount: number;
    isRoot: boolean;
    children: string[];
}>): void;
/** 添加 per-chat 事实（带去重） */
export declare function addFact(cwd: string, chatId: string, fact: string): boolean;
/** 读取 per-chat 事实 */
export declare function getFacts(cwd: string, chatId: string): string[];
/** 写入检索轨迹（替代 JSONL 文件） */
export declare function saveTrace(cwd: string, trace: {
    timestamp: string;
    query: string;
    pipeline: unknown;
    rrf: unknown;
    injected: unknown;
    budget_used: number;
    budget_limit: number;
}): void;
/** 同步 RECENT_EVENTS.md 到 events 表 */
export declare function syncEventsFromMd(cwd: string): boolean;
//# sourceMappingURL=memory-db.d.ts.map