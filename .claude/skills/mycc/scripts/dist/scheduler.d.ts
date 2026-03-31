/**
 * Scheduler 模块 - 定时任务核心逻辑
 *
 * 功能：
 * 1. parseTasks - 解析 tasks.md 中的任务配置
 * 2. matchTime - 判断当前时间是否匹配任务时间
 * 3. TaskLock - 防止同一任务重复执行
 * 4. startScheduler - 启动定时检查
 * 5. stopScheduler - 停止定时检查
 */
export interface Task {
    time: string;
    name: string;
    skill: string;
    desc: string;
    type: "daily" | "weekly" | "once" | "interval" | "ndays" | "conditional";
    activeHours?: {
        start: number;
        end: number;
    };
    engine?: "claude" | "codex" | "gemini";
    sessionId?: string;
    conditionExpr?: string;
}
/**
 * 解析 tasks.md 内容，提取任务列表
 */
export declare function parseTasks(content: string | null | undefined): Task[];
/**
 * 判断当前时间是否匹配任务时间
 */
export declare function matchTime(taskTime: string, now: Date): boolean;
/**
 * 求值条件表达式
 * 支持：
 *   fail_count>=N     - task-log.md 近7天失败记录 ≥ N 条
 *   stale(path, Nd)   - 路径 N 天未修改
 *   no_msg(Nd)        - N 天无用户消息（chat-history/p2p 最新文件日期）
 */
export declare function evaluateCondition(expr: string, cwd: string): boolean;
/**
 * 任务锁 - 防止同一任务在同一时间窗口内重复执行
 *
 * 内存锁 + 可选持久化文件，防止服务重启后在时间窗口内重复触发。
 * key 格式：`${taskName}|${taskTime}|${dateStr}`
 */
export declare class TaskLock {
    private executed;
    private lockEntries;
    private lockFilePath;
    constructor(lockFilePath?: string);
    /** 从持久化文件加载锁状态（启动时调用）*/
    loadFromFile(): void;
    /**
     * 尝试获取锁
     * @returns true 表示可以执行，false 表示已执行过
     */
    tryAcquire(taskName: string, taskTime: string, now: Date): boolean;
    private persistToFile;
    /**
     * 构建锁的 key
     * 使用任务时间（而非当前时间）+ 日期，确保同一时间窗口内只执行一次
     */
    private buildKey;
    /**
     * 清空所有锁（用于测试）
     */
    clear(): void;
}
export type ExecuteTaskFn = (task: Task, cwd: string) => void | Promise<void>;
/**
 * 启动定时任务调度器
 *
 * @param cwd 项目根目录
 * @param executeTask 任务执行函数（可注入，便于测试）
 */
export declare function startScheduler(cwd: string, executeTask: ExecuteTaskFn): void;
/**
 * 停止定时任务调度器
 */
export declare function stopScheduler(): void;
//# sourceMappingURL=scheduler.d.ts.map