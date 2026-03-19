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
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
const STATS_FILE = join(process.env.HOME || "/tmp", ".claude/cli-engine-stats.json");
const MIN_TIMEOUT = 2 * 60_000; // 2 min
const MAX_TIMEOUT = 30 * 60_000; // 30 min
const DEFAULT_TIMEOUT = 5 * 60_000; // 5 min
const MAX_HISTORY = 30; // 每个 pattern 保留最近 30 条
function loadStats() {
    if (!existsSync(STATS_FILE)) {
        return { version: 1, patterns: {} };
    }
    try {
        return JSON.parse(readFileSync(STATS_FILE, "utf-8"));
    }
    catch {
        return { version: 1, patterns: {} };
    }
}
function saveStats(data) {
    const dir = dirname(STATS_FILE);
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    writeFileSync(STATS_FILE, JSON.stringify(data, null, 2), "utf-8");
}
/** 计算数组的 P-th 百分位数 */
function percentile(sorted, p) {
    if (sorted.length === 0)
        return 0;
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
}
/**
 * 根据历史数据计算超时值。
 * @param patternKey 任务模式标识（SOP 路径 or "default"）
 * @param engine     执行引擎
 * @returns          超时值 (ms)
 */
export function getAdaptiveTimeout(patternKey, engine) {
    const stats = loadStats();
    const task = stats.patterns[patternKey];
    if (!task || task.executions.length === 0) {
        console.log(`[AdaptiveTimeout] 无历史数据 (${patternKey})，使用默认 ${DEFAULT_TIMEOUT / 1000}s`);
        return DEFAULT_TIMEOUT;
    }
    // 只看同引擎的历史
    const engineExecs = task.executions.filter((e) => e.engine === engine);
    if (engineExecs.length === 0) {
        console.log(`[AdaptiveTimeout] 引擎 ${engine} 无历史，使用默认 ${DEFAULT_TIMEOUT / 1000}s`);
        return DEFAULT_TIMEOUT;
    }
    const successful = engineExecs.filter((e) => !e.timedOut);
    const timedOuts = engineExecs.filter((e) => e.timedOut);
    let timeout;
    if (timedOuts.length > 0 && successful.length === 0) {
        // 全是超时——取最近超时时的 duration（即上次的 timeout 值），乘 1.5
        const lastTimeout = timedOuts[timedOuts.length - 1].duration;
        timeout = lastTimeout * 1.5;
        console.log(`[AdaptiveTimeout] 全超时，升档: ${lastTimeout / 1000}s → ${timeout / 1000}s`);
    }
    else if (successful.length > 0) {
        const durations = successful.map((e) => e.duration).sort((a, b) => a - b);
        const p90 = percentile(durations, 90);
        const lastSuccessful = successful[successful.length - 1].duration;
        // 基础值：P90 × 2.0
        timeout = p90 * 2.0;
        // 如果有过超时记录，额外保守：至少是最近成功耗时 × 1.5
        if (timedOuts.length > 0) {
            timeout = Math.max(timeout, lastSuccessful * 1.5);
        }
        // 不低于最近成功耗时 × 1.3
        timeout = Math.max(timeout, lastSuccessful * 1.3);
        console.log(`[AdaptiveTimeout] 历史 ${successful.length} 成功 / ${timedOuts.length} 超时，` +
            `P90=${(p90 / 1000).toFixed(1)}s，计算超时=${(timeout / 1000).toFixed(1)}s`);
    }
    else {
        timeout = DEFAULT_TIMEOUT;
    }
    // 限制范围
    timeout = Math.max(MIN_TIMEOUT, Math.min(MAX_TIMEOUT, timeout));
    console.log(`[AdaptiveTimeout] 最终超时: ${(timeout / 1000).toFixed(1)}s (${patternKey}, ${engine})`);
    return Math.round(timeout);
}
/**
 * 记录一次执行结果，用于后续学习。
 */
export function recordExecution(patternKey, engine, duration, timedOut) {
    const stats = loadStats();
    if (!stats.patterns[patternKey]) {
        stats.patterns[patternKey] = { pattern: patternKey, executions: [] };
    }
    const task = stats.patterns[patternKey];
    task.executions.push({
        timestamp: Date.now(),
        duration,
        timedOut,
        engine,
    });
    // 只保留最近 N 条
    if (task.executions.length > MAX_HISTORY) {
        task.executions = task.executions.slice(-MAX_HISTORY);
    }
    saveStats(stats);
    console.log(`[AdaptiveTimeout] 记录: ${patternKey} / ${engine} / ${(duration / 1000).toFixed(1)}s / ${timedOut ? "TIMEOUT" : "OK"}`);
}
/**
 * 获取统计摘要（调试/监控用）
 */
export function getStatsSummary() {
    const stats = loadStats();
    const summary = {};
    for (const [key, task] of Object.entries(stats.patterns)) {
        const execs = task.executions;
        const timeouts = execs.filter((e) => e.timedOut).length;
        const successful = execs.filter((e) => !e.timedOut);
        const avgMs = successful.length > 0
            ? successful.reduce((s, e) => s + e.duration, 0) / successful.length
            : 0;
        summary[key] = {
            total: execs.length,
            timeouts,
            avgDuration: `${(avgMs / 1000).toFixed(1)}s`,
            currentTimeout: `${(getAdaptiveTimeout(key, execs[0]?.engine || "gemini") / 1000).toFixed(1)}s`,
        };
    }
    return summary;
}
//# sourceMappingURL=adaptive-timeout.js.map