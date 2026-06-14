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
    source: string;
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
    predicted?: string[];
    budget_used: number;
    budget_limit: number;
}): void;
/**
 * PP 自动验证闭环：聚合最近 N 天有 predicted 的轨迹，
 * 对比 predicted vs injected，返回预测准确率和偏差模式。
 *
 * 准确率 = predicted 中被 injected 命中的比率（precision）
 * 召回率 = injected 中被 predicted 覆盖的比率（recall）
 * 偏差大（precision < 0.5）时，应触发预测策略调整。
 */
export interface PredictionVerification {
    readonly totalWithPredictions: number;
    readonly precision: number;
    readonly recall: number;
    /** 经常预测但从未注入的类别（幻觉候选） */
    readonly overPredicted: ReadonlyArray<{
        category: string;
        count: number;
    }>;
    /** 经常注入但从未预测的类别（盲区候选） */
    readonly underPredicted: ReadonlyArray<{
        category: string;
        count: number;
    }>;
}
export declare function verifyPredictions(cwd: string, days?: number): PredictionVerification;
/** v6 AST: 轨迹聚合统计 — 从 write-only 到反馈闭环 */
export interface TraceStats {
    /** 每个类别被注入的次数（降序） */
    readonly categoryHitRate: ReadonlyArray<{
        category: string;
        count: number;
        rate: number;
    }>;
    /** 被 RRF 排名但未注入的类别（检索盲区候选） */
    readonly missedCategories: ReadonlyArray<{
        category: string;
        rrfCount: number;
        injectCount: number;
    }>;
    /** 平均预算使用率 */
    readonly avgBudgetUsage: number;
    /** 轨迹总数 */
    readonly totalTraces: number;
}
/**
 * v6 AST: 聚合最近 N 天的检索轨迹，生成类别命中率统计。
 *
 * 用于 ASAC 反馈闭环：历史高命中类别在下次检索中获得 boost。
 * 冷启动安全：无数据时返回空统计，调用方可安全忽略。
 */
export declare function aggregateTraces(cwd: string, days?: number): TraceStats;
/** 同步 RECENT_EVENTS.md 到 events 表 */
export declare function syncEventsFromMd(cwd: string): boolean;
/**
 * 记录一批 item 被检索注入（更新 last_accessed + access_count）。
 * 在 context-loader 的 extractCategories 完成后调用。
 */
export declare function recordItemAccess(cwd: string, categories: ReadonlyArray<string>): void;
/**
 * 获取指定类别下所有 item 的质量分 + 访问衰减系数。
 *
 * 返回 Map<itemId, { quality, decayFactor }>
 * - quality: 0-1 EDM 质量分
 * - decayFactor: 0-1 FadeMem 衰减系数（1=刚访问，→0=长期未访问）
 *
 * decayFactor = e^(-λ * daysSinceLastAccess)
 * 从未被访问的 item: daysSinceLastAccess = daysSinceCreation，给予基线衰减
 */
export declare function getQualityAndDecayScores(cwd: string, categories: ReadonlyArray<string>): Map<string, {
    quality: number;
    decayFactor: number;
}>;
/** 行为漂移统计结果 */
export interface BehaviorDriftStats {
    /** 总任务数 */
    totalTasks: number;
    /** 引擎分布 { engine: count } */
    engineDistribution: ReadonlyArray<{
        engine: string;
        count: number;
        ratio: number;
    }>;
    /** 摩擦密度：有 friction 标记的任务占比 */
    frictionDensity: number;
    /** 摩擦 skill 热点（按频率排序） */
    frictionHotspots: ReadonlyArray<{
        skill: string;
        count: number;
    }>;
    /** 任务类型分布 */
    taskTypeDistribution: ReadonlyArray<{
        type: string;
        count: number;
        ratio: number;
    }>;
    /** 每日任务数趋势（最近 N 天） */
    dailyTaskCounts: ReadonlyArray<{
        date: string;
        count: number;
    }>;
    /** 分析时间窗口 */
    windowDays: number;
}
/**
 * 从 task-log.md 解析行为指标，用于检测 cc 的行为漂移。
 *
 * 数据源：`0-System/task-log.md`
 * 格式：| 时间 | 任务类型 | 摘要 | 执行引擎 | 状态 | friction_skill |
 *
 * @param cwd 项目根目录
 * @param days 回看天数（默认 14）
 */
export declare function computeBehaviorDrift(cwd: string, days?: number): BehaviorDriftStats;
//# sourceMappingURL=memory-db.d.ts.map