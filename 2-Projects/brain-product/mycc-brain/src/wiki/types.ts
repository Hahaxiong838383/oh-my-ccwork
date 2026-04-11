/**
 * brain-wiki 数据层类型定义。
 *
 * 与 memory.db / knowledge.db 完全独立。
 * 面向 Phase 2 MCP server 的 guide/search/read/write/delete 工具。
 */

/** 文档类型：wiki = cc 在对话中维护的 markdown 页 / source = 从外部抽取的原始材料 */
export type DocumentKind = "wiki" | "source";

/** 完整的 wiki document row（从 db 读出）。 */
export interface WikiDocument {
  id: number;
  /** 规范化路径，e.g. '/wiki/entities/futurus.md' 或 '/sources/feishu-xxx'。唯一索引。 */
  path: string;
  title: string;
  /** 完整 markdown 原文。不做 chunk，LLM 客户端按整页读/写。 */
  content: string;
  kind: DocumentKind;
  /** 用户标签，JSON 序列化存储。 */
  tags: string[];
  /** upsert 每次 +1，支持乐观并发 / 审计。 */
  version: number;
  /** soft delete 标记。tombstone=1 时不在 search 和 getByPath 结果中。 */
  tombstone: boolean;
  /** ISO 8601 UTC */
  createdAt: string;
  /** ISO 8601 UTC */
  updatedAt: string;
}

/** upsert 输入（不含自动字段）。 */
export interface WikiDocumentInput {
  path: string;
  title: string;
  content: string;
  kind: DocumentKind;
  tags?: string[];
}

/** FTS5 搜索命中。 */
export interface WikiSearchHit {
  id: number;
  path: string;
  title: string;
  content: string;
  kind: DocumentKind;
  /** FTS5 BM25 rank（负数，越小越相关）。 */
  rank: number;
}

/** 搜索参数。 */
export interface WikiSearchOptions {
  /** 过滤 wiki / source。省略=全部。 */
  kind?: DocumentKind;
  /** 默认 10。 */
  topK?: number;
}
