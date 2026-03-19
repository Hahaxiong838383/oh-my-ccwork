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
 */
import { type MediaBuffer } from "./gemini-api.js";
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
}
/**
 * Execute a prompt via CLI engine (codex or gemini).
 */
export declare function runCliEngine(engine: EngineType, prompt: string, cwd: string, opts?: CliEngineOptions): Promise<CliEngineResult>;
export {};
//# sourceMappingURL=cli-engine.d.ts.map