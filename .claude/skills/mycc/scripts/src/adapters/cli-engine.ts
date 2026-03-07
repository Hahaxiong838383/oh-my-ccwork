/**
 * CLI Engine Adapter - Codex / Gemini CLI
 *
 * Spawns child processes for non-Claude engines.
 * Each call is stateless (no session).
 */

import { execFile } from "child_process";

export type EngineType = "codex" | "gemini";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

interface CliEngineResult {
  output: string;
  error?: string;
}

interface CliEngineOptions {
  reasoningEffort?: ReasoningEffort;
}

const ENGINE_CONFIG: Record<EngineType, { bin: string; buildArgs: (prompt: string, cwd: string, opts?: CliEngineOptions) => string[] }> = {
  codex: {
    bin: "codex",
    buildArgs: (prompt, cwd, opts) => {
      const args = ["exec", "-s", "danger-full-access"];
      if (opts?.reasoningEffort) {
        args.push("-c", `model_reasoning_effort="${opts.reasoningEffort}"`);
      }
      args.push(prompt, "-C", cwd);
      return args;
    },
  },
  gemini: {
    bin: "gemini",
    buildArgs: (prompt, _cwd) => ["-p", prompt, "-y"],
  },
};

/**
 * 根据 prompt 复杂度自动选择 codex reasoning effort。
 * 复杂任务（代码/架构/调试/分析）→ xhigh，简单问答 → high。
 */
function classifyEffort(prompt: string): ReasoningEffort {
  const complex = /代码|bug|debug|实现|重构|架构|分析|设计|优化|修复|迁移|部署|review|refactor|implement|fix|deploy|migrate|architect/i;
  return complex.test(prompt) ? "xhigh" : "high";
}

/**
 * Execute a prompt via CLI engine (codex or gemini).
 * Returns the stdout output as a string.
 * Timeout: 5 minutes.
 * For codex: auto-classifies reasoning effort if not explicitly provided.
 */
export function runCliEngine(engine: EngineType, prompt: string, cwd: string, opts?: CliEngineOptions): Promise<CliEngineResult> {
  if (engine === "codex" && !opts?.reasoningEffort) {
    const effort = classifyEffort(prompt);
    opts = { ...opts, reasoningEffort: effort };
    console.log(`[CliEngine][codex] auto reasoning: ${effort}`);
  }
  const config = ENGINE_CONFIG[engine];

  return new Promise((resolve) => {
    const args = config.buildArgs(prompt, cwd, opts);
    console.log(`[CliEngine][${engine}] exec: ${config.bin} ${args.join(" ").substring(0, 100)}...`);

    const child = execFile(config.bin, args, {
      cwd,
      timeout: 300_000, // 5 min
      maxBuffer: 1024 * 1024 * 10, // 10MB
      env: { ...process.env, CLAUDECODE: undefined },
    }, (error, stdout, stderr) => {
      if (error) {
        console.error(`[CliEngine][${engine}] error:`, error.message);
        resolve({
          output: stdout || "",
          error: error.message + (stderr ? `\n${stderr}` : ""),
        });
        return;
      }
      console.log(`[CliEngine][${engine}] done, output length: ${stdout.length}`);
      resolve({ output: stdout });
    });
  });
}
