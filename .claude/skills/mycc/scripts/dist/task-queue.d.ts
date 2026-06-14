/**
 * 异步任务队列（双主分离 - 任务主 Agent）
 *
 * 解决的问题：长任务（theory-radar / github-radar / 写代码等）阻塞对话通道，
 * 用户在任务执行期间无法继续交互。
 *
 * 方案：
 * - 消息分类器判断是"对话型"还是"任务型"
 * - 任务型：立即 ack + 后台异步执行 + 完成后回飞书
 * - 对话型：走原有同步流程
 * - 每通道独立任务队列（串行，避免 session 冲突）
 * - 后台任务使用独立 session（不占用对话 session）
 */
export type MessageType = "chat" | "task";
export type AutoRouteEngine = "cc" | "codex" | "gemini" | "pipeline";
/**
 * 路由结果（AST — 社会注意力推断）
 *
 * 不仅返回目标引擎，还返回路由原因和上下文提示，
 * 让系统「知道为什么分配给这个引擎」。
 */
export interface RouteResult {
    engine: AutoRouteEngine;
    /** 路由原因（用于 blackboard 记录 + 日志） */
    reason: string;
    /** 传递给目标引擎的上下文提示（如已知的工具偏好、历史表现） */
    contextHints: string[];
}
/**
 * 半自动任务路由（AST 社会注意力版）：
 * 根据消息内容推荐最合适的引擎，并说明路由原因和上下文提示。
 *
 * 路由优先级：
 * 1. pipeline（分析+写入组合）→ Gemini 分析 → Codex 写入飞书
 * 2. codex（纯代码任务 / 论文调研）
 * 3. gemini（纯调研/采集）
 * 4. cc（默认 / 纯写入操作）
 */
export declare function autoRouteEngine(message: string, cwd?: string): RouteResult;
/**
 * 判断消息类型。
 * 启发式规则，不追求完美，误判代价低（无非同步变同步）。
 */
export declare function classifyMessage(message: string): MessageType;
export interface QueuedTask {
    id: string;
    channelId: string;
    message: string;
    engine: string;
    submittedAt: Date;
    startedAt?: Date;
    finishedAt?: Date;
    status: "pending" | "running" | "done" | "error" | "aborted";
    error?: string;
    /** 每个任务独立的执行器（避免共享 executor 导致路由错乱） */
    executor: TaskExecutor;
}
type TaskExecutor = (task: QueuedTask, signal: AbortSignal) => Promise<void>;
/**
 * 全局任务队列管理器（每通道独立队列）。
 */
export declare class TaskQueueManager {
    private queues;
    private taskCounter;
    private getOrCreate;
    /**
     * 将任务加入队列。
     * @param engine 路由到的引擎名（用于显示和排查）
     * @returns 任务 ID
     */
    submit(channelId: string, message: string, engine: string, executor: TaskExecutor): string;
    /**
     * 获取通道当前队列长度（不含正在运行的任务）。
     */
    getPendingCount(channelId: string): number;
    /**
     * 通道是否有任务正在运行。
     */
    isChannelBusy(channelId: string): boolean;
    /**
     * 中止通道的所有任务（当前执行 + 队列中的）。
     */
    abort(channelId: string): {
        cancelledCount: number;
        abortedRunning: boolean;
        runningTaskPreview?: string;
        runningTaskEngine?: string;
        cancelledPreviews: string[];
    };
    /**
     * 获取通道队列状态信息。
     */
    getQueueInfo(channelId: string): {
        running: boolean;
        pending: number;
        currentTask: QueuedTask | null;
    };
}
/** 全局单例 */
export declare const taskQueueManager: TaskQueueManager;
export {};
//# sourceMappingURL=task-queue.d.ts.map