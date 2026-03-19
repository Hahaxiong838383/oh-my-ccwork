/**
 * Adaptive Timeout — 自适应超时管理
 *
 * 核心思路：不硬编码超时规则，而是通过历史执行数据自动学习。
 * - 每次 CLI 引擎执行完成后，记录实际耗时和结果
 * - 下次执行同类任务时，基于历史数据动态计算超时值
 * - 超时被触发后自动扩大，快速完成时逐渐收敛
 *
 * 算法：timeout = P90(历史耗时) × 安全系数
 * - 新任务（无历史）：默认 5 分钟
 * - 有超时记录：最近超时值 × 1.5
 * - 有成功记录：P90 × 2.0，但不低于最近成功耗时 × 1.3
 * - 上限 30 分钟，下限 2 分钟
 */
/**
 * 根据历史数据计算超时值。
 * @param patternKey 任务模式标识（SOP 路径 or "default"）
 * @param engine     执行引擎
 * @returns          超时值 (ms)
 */
export declare function getAdaptiveTimeout(patternKey: string, engine: string): number;
/**
 * 记录一次执行结果，用于后续学习。
 */
export declare function recordExecution(patternKey: string, engine: string, duration: number, timedOut: boolean): void;
/**
 * 获取统计摘要（调试/监控用）
 */
export declare function getStatsSummary(): Record<string, {
    total: number;
    timeouts: number;
    avgDuration: string;
    currentTimeout: string;
}>;
//# sourceMappingURL=adaptive-timeout.d.ts.map