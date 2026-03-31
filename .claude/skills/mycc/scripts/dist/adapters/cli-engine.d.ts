/**
 * CLI Engine Adapter - Codex CLI / Gemini API
 *
 * Spawns child processes for non-Claude engines.
 * Each call is stateless (no session).
 *
 * 优化记录:
 * - 2026-03-09: codex 用 spawn + stdin 传 prompt（避免超长命令行参数）
 * - 2026-03-09: codex 加 --ephemeral 跳过 session 持久化
 * - 2026-03-12: gemini 从 CLI 切换到 API（支持多模态，分散 cc 负载）
 * - 2026-03-15: 接入 RunManager（ACP Run 生命周期 + 并发控制）
 */
import { type MediaBuffer } from "./gemini-api.js";
import { type Run } from "../services/run-manager.js";
export type EngineType = "codex" | "gemini";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";
interface CliEngineResult {
    output: string;
    error?: string;
    timedOut?: boolean;
}
interface CliEngineOptions {
    reasoningEffort?: ReasoningEffort;
    timeout?: number;
    signal?: AbortSignal;
    filePaths?: string[];
    mediaBuffers?: MediaBuffer[];
    enableTools?: boolean;
    source?: string;
}
export interface CliEngineResultWithRun extends CliEngineResult {
    /** RunManager 分配的 Run 对象（可用于状态查询） */
    run: Run;
}
/**
 * Execute a prompt via CLI engine (codex or gemini).
 *
 * 自动接入 RunManager：
 * - 并发控制（每引擎最多 2 个并发 Run）
 * - Run 生命周期跟踪（created → in-progress → completed/failed）
 * - 超时、取消、错误 全部归口到 Run 状态
 */
export declare function runCliEngine(engine: EngineType, prompt: string, cwd: string, opts?: CliEngineOptions): Promise<CliEngineResultWithRun>;
export {};
//# sourceMappingURL=cli-engine.d.ts.map