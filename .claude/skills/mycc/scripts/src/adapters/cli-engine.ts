/**
 * CLI Engine Adapter - Codex / Gemini CLI
 *
 * Spawns child processes for non-Claude engines.
 * Each call is stateless (no session).
 *
 * 优化记录 (2026-03-09):
 * - codex: 用 spawn + stdin 传 prompt（避免超长命令行参数）
 * - codex: 加 --ephemeral 跳过 session 持久化
 * - gemini: 仍用 -p 参数（gemini 不支持 stdin）
 */

import { spawn, execFile } from "child_process";

export type EngineType = "codex" | "gemini";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

interface CliEngineResult {
  output: string;
  error?: string;
  timedOut?: boolean;
}

interface CliEngineOptions {
  reasoningEffort?: ReasoningEffort;
  timeout?: number; // ms
}

/**
 * 根据 prompt 复杂度自动选择 codex reasoning effort。
 * 复杂任务（代码/架构/调试/分析）→ xhigh，简单问答 → high。
 */
function classifyEffort(prompt: string): ReasoningEffort {
  const complex = /代码|bug|debug|实现|重构|架构|分析|设计|优化|修复|迁移|部署|review|refactor|implement|fix|deploy|migrate|architect/i;
  return complex.test(prompt) ? "xhigh" : "high";
}

/**
 * Execute codex via spawn + stdin (supports long prompts).
 * Prompt is piped via stdin using "-" argument.
 */
function runCodex(prompt: string, cwd: string, opts?: CliEngineOptions): Promise<CliEngineResult> {
  const effort = opts?.reasoningEffort || classifyEffort(prompt);
  const timeout = opts?.timeout || 300_000;

  const args = [
    "exec",
    "-s", "danger-full-access",
    "-c", `model_reasoning_effort="${effort}"`,
    "--ephemeral",
    "-C", cwd,
    "-",  // read prompt from stdin
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
      // 给 2s 优雅退出，然后 SIGKILL
      setTimeout(() => child.kill("SIGKILL"), 2000);
    }, timeout);

    child.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (killed) {
        console.error(`[CliEngine][codex] TIMEOUT after ${(timeout / 1000).toFixed(0)}s`);
        resolve({ output: stdout, error: `TIMEOUT after ${timeout / 1000}s\n${stderr}`, timedOut: true });
      } else if (code !== 0) {
        console.error(`[CliEngine][codex] exit code ${code}: ${stderr.substring(0, 200)}`);
        resolve({ output: stdout, error: `exit code ${code}\n${stderr}` });
      } else {
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
 * Execute gemini via execFile (short prompts via -p arg).
 */
function runGemini(prompt: string, cwd: string, opts?: CliEngineOptions): Promise<CliEngineResult> {
  const timeout = opts?.timeout || 300_000;
  const args = ["-p", prompt, "-y"];

  console.log(`[CliEngine][gemini] exec (timeout=${(timeout / 1000).toFixed(0)}s): gemini ${args[0]} ${args[1].substring(0, 80)}...`);

  return new Promise((resolve) => {
    execFile("gemini", args, {
      cwd,
      timeout,
      maxBuffer: 1024 * 1024 * 10,
      env: { ...process.env, CLAUDECODE: undefined },
    }, (error, stdout, stderr) => {
      if (error) {
        const isTimeout = error.message.includes("TIMEOUT") || (error as any).killed;
        console.error(`[CliEngine][gemini] ${isTimeout ? "TIMEOUT" : "error"}:`, error.message);
        resolve({
          output: stdout || "",
          error: error.message + (stderr ? `\n${stderr}` : ""),
          timedOut: isTimeout,
        });
        return;
      }
      console.log(`[CliEngine][gemini] done, output length: ${stdout.length}`);
      resolve({ output: stdout });
    });
  });
}

/**
 * Execute a prompt via CLI engine (codex or gemini).
 */
export function runCliEngine(engine: EngineType, prompt: string, cwd: string, opts?: CliEngineOptions): Promise<CliEngineResult> {
  if (engine === "codex") {
    return runCodex(prompt, cwd, opts);
  }
  return runGemini(prompt, cwd, opts);
}
