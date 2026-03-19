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
import { spawn } from "child_process";
import { runGeminiApi } from "./gemini-api.js";
/**
 * 根据 prompt 复杂度自动选择 codex reasoning effort。
 * 复杂任务（代码/架构/调试/分析）→ xhigh，简单问答 → high。
 */
function classifyEffort(prompt) {
    const complex = /代码|bug|debug|实现|重构|架构|分析|设计|优化|修复|迁移|部署|review|refactor|implement|fix|deploy|migrate|architect/i;
    return complex.test(prompt) ? "xhigh" : "high";
}
/**
 * Execute codex via spawn + stdin (supports long prompts).
 * Prompt is piped via stdin using "-" argument.
 */
function runCodex(prompt, cwd, opts) {
    const effort = opts?.reasoningEffort || classifyEffort(prompt);
    const timeout = opts?.timeout || 300_000;
    const args = [
        "exec",
        "-s", "danger-full-access",
        "-c", `model_reasoning_effort="${effort}"`,
        "--ephemeral",
        "-C", cwd,
        "-", // read prompt from stdin
    ];
    console.log(`[CliEngine][codex] spawn (timeout=${(timeout / 1000).toFixed(0)}s, effort=${effort}, prompt=${prompt.length} chars)`);
    return new Promise((resolve) => {
        const child = spawn("codex", args, {
            cwd,
            env: { ...process.env, CLAUDECODE: undefined },
            stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let killed = false;
        const timer = setTimeout(() => {
            killed = true;
            child.kill("SIGTERM");
            setTimeout(() => child.kill("SIGKILL"), 2000);
        }, timeout);
        // 外部中止信号
        const onAbort = () => {
            if (!killed) {
                killed = true;
                console.log("[CliEngine][codex] 收到外部中止信号");
                child.kill("SIGTERM");
                setTimeout(() => child.kill("SIGKILL"), 2000);
            }
        };
        opts?.signal?.addEventListener("abort", onAbort, { once: true });
        child.stdout.on("data", (data) => { stdout += data.toString(); });
        child.stderr.on("data", (data) => { stderr += data.toString(); });
        child.on("close", (code) => {
            clearTimeout(timer);
            opts?.signal?.removeEventListener("abort", onAbort);
            if (killed && opts?.signal?.aborted) {
                console.log("[CliEngine][codex] 已被用户中止");
                resolve({ output: stdout, error: "USER_ABORTED" });
            }
            else if (killed) {
                console.error(`[CliEngine][codex] TIMEOUT after ${(timeout / 1000).toFixed(0)}s`);
                resolve({ output: stdout, error: `TIMEOUT after ${timeout / 1000}s\n${stderr}`, timedOut: true });
            }
            else if (code !== 0) {
                console.error(`[CliEngine][codex] exit code ${code}: ${stderr.substring(0, 200)}`);
                resolve({ output: stdout, error: `exit code ${code}\n${stderr}` });
            }
            else {
                console.log(`[CliEngine][codex] done, output length: ${stdout.length}`);
                resolve({ output: stdout });
            }
        });
        child.on("error", (err) => {
            clearTimeout(timer);
            console.error(`[CliEngine][codex] spawn error:`, err.message);
            resolve({ output: "", error: err.message });
        });
        // 写入 prompt 并关闭 stdin
        child.stdin.write(prompt);
        child.stdin.end();
    });
}
/**
 * Execute a prompt via CLI engine (codex or gemini).
 */
export function runCliEngine(engine, prompt, cwd, opts) {
    if (engine === "codex") {
        return runCodex(prompt, cwd, opts);
    }
    // gemini: 直接调 API（支持多模态，含内存中的媒体数据）
    return runGeminiApi(prompt, {
        timeout: opts?.timeout,
        signal: opts?.signal,
        filePaths: opts?.filePaths,
        mediaBuffers: opts?.mediaBuffers,
    });
}
//# sourceMappingURL=cli-engine.js.map