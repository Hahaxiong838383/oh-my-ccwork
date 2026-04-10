/**
 * types.ts — 外挂知识系统核心类型定义
 *
 * 所有结构 readonly 不可变。此文件不导入任何运行时依赖，纯类型。
 * 设计纲领：feishu wiki → Gemini Flash 抽取 → 独立 knowledge.db。
 */

/** 原子事实的提取来源 */
export type ExtractionSource = "gemini-flash" | "manual";

/** 单篇文档的同步状态机 */
export type DocSyncStatus = "pending" | "synced" | "extracted" | "failed";

/**
 * 单条"原子事实"条目，对应 knowledge_items 表一行。
 *
 * - `namespace`: 人类可读的分类路径（如 "brain/架构/检索层"）。
 * - `keywords`: 关键词数组，用于关键词召回（不走向量）。
 * - `tombstone`: 软删标记；检索时必须过滤 `tombstone = false`。
 */
export interface KnowledgeItem {
  readonly id: number;
  readonly docToken: string;
  readonly docTitle: string;
  readonly spaceId: string;
  readonly namespace: string;
  readonly content: string;
  readonly keywords: readonly string[];
  readonly confidence: number;
  readonly sourceUrl: string;
  readonly extractedBy: ExtractionSource;
  readonly createdAt: number;
  readonly tombstone: boolean;
}

/** 插入新条目时的入参（不含 id / createdAt / tombstone，由 store 填充） */
export interface KnowledgeItemInput {
  readonly docToken: string;
  readonly docTitle: string;
  readonly spaceId: string;
  readonly namespace: string;
  readonly content: string;
  readonly keywords: readonly string[];
  readonly confidence: number;
  readonly sourceUrl: string;
  readonly extractedBy: ExtractionSource;
}

/** FTS5 检索单条结果（rank 越小越相关） */
export interface KnowledgeSearchHit {
  readonly id: number;
  readonly namespace: string;
  readonly content: string;
  readonly docTitle: string;
  readonly sourceUrl: string;
  readonly rank: number;
}

/** Gemini Flash 从单篇文档抽取出的单个原子事实 */
export interface ExtractedFact {
  readonly content: string;
  readonly keywords: readonly string[];
  readonly confidence: number;
  readonly namespace: string;
}

/**
 * 单次 Gemini Flash 抽取的完整元数据。
 *
 * - `contentHash`: 文档正文的 sha256，用于增量去重（相同 hash 跳过重抽）。
 * - `costUsd`: 本次调用的估算成本，用于 $0.50 预算硬顶。
 */
export interface ExtractionResult {
  readonly docToken: string;
  readonly docTitle: string;
  readonly contentHash: string;
  readonly facts: readonly ExtractedFact[];
  readonly model: string;
  readonly latencyMs: number;
  readonly tokenIn: number;
  readonly tokenOut: number;
  readonly costUsd: number;
}

/** 每篇文档的同步状态快照（crawler 写，extractor 读） */
export interface DocSyncState {
  readonly docToken: string;
  readonly docTitle: string;
  readonly spaceId: string;
  readonly contentHash: string;
  readonly lastSyncedAt: number;
  readonly lastExtractedAt: number;
  readonly status: DocSyncStatus;
  readonly errorMessage: string;
}

/** Allowlist 单条（对应 knowledge-allowlist.json 里 spaces[] 的一个元素） */
export interface AllowlistEntry {
  readonly spaceId: string;
  readonly name: string;
  readonly enabled: boolean;
  /** 空数组表示爬该 space 下所有根节点 */
  readonly rootTokens: readonly string[];
}

/** Allowlist 整体 */
export interface Allowlist {
  readonly spaces: readonly AllowlistEntry[];
}
