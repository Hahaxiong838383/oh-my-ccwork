/**
 * RunManager — 轻量级 CLI Agent 运行管理器
 *
 * 借鉴 ACP 协议的 Run 生命周期模型，但走 stdio 不走 HTTP。
 * 核心能力：
 * - Run 状态机：created → in-progress → completed/failed/cancelled/timed-out
 * - 并发限制：每个引擎最多 N 个并发 Run
 * - 可观测：实时查询任意 Run 的状态、耗时、输出
 * - 自动清理：已完成的 Run 保留 10 分钟后自动清理
 *
 * 零外部依赖，纯 TypeScript 实现。
 */
import type { EngineType } from "../adapters/cli-engine.js";
export type RunStatus = "created" | "in-progress" | "completed" | "failed" | "cancelled" | "timed-out";
export interface Run {
    /** 唯一标识 */
    id: string;
    /** 执行引擎 */
    engine: EngineType;
    /** prompt 摘要（前 80 字符） */
    promptSummary: string;
    /** 当前状态 */
    status: RunStatus;
    /** 创建时间 */
    createdAt: number;
    /** 开始执行时间 */
    startedAt?: number;
    /** 结束时间 */
    finishedAt?: number;
    /** 输出内容 */
    output?: string;
    /** 错误信息 */
    error?: string;
    /** 来源（飞书 chatId / scheduler / CLI） */
    source?: string;
}
/**
 * 创建一个新 Run（状态：created）
 */
export declare function createRun(engine: EngineType, prompt: string, source?: string): Run;
/**
 * 标记 Run 开始执行
 */
export declare function startRun(runId: string): void;
/**
 * 标记 Run 完成
 */
export declare function completeRun(runId: string, output: string): void;
/**
 * 标记 Run 失败
 */
export declare function failRun(runId: string, error: string, timedOut?: boolean): void;
/**
 * 取消 Run
 */
export declare function cancelRun(runId: string): boolean;
/**
 * 查询单个 Run 状态
 */
export declare function getRun(runId: string): Run | undefined;
/**
 * 查询指定引擎当前正在执行的 Run 数量
 */
export declare function getActiveCount(engine: EngineType): number;
/**
 * 检查引擎是否可以接受新任务（并发控制）
 */
export declare function canAcceptRun(engine: EngineType): boolean;
/**
 * 获取所有活跃 Run（in-progress）
 */
export declare function getActiveRuns(): Run[];
/**
 * 获取指定引擎最近的 Run 列表（最多 10 条）
 */
export declare function getRecentRuns(engine?: EngineType, limit?: number): Run[];
/**
 * 生成 Run 摘要（用于飞书状态汇报）
 */
export declare function getRunSummary(): string;
//# sourceMappingURL=run-manager.d.ts.map