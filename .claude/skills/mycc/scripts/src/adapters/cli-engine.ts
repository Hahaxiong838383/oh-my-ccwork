/**
 * CLI Engine Adapter - Codex / Gemini CLI
 *
 * Spawns child processes for non-Claude engines.
 * Each call is stateless (no session).
 */

import { execFile } from "child_process";

export type EngineType = "codex" | "gemini";

interface CliEngineResult {
  output: string;
  error?: string;
}

const ENGINE_CONFIG: Record<EngineType, { bin: string; buildArgs: (prompt: string, cwd: string) => string[] }> = {
  codex: {
    bin: "codex",
    buildArgs: (prompt, cwd) => ["exec", prompt, "-C", cwd],
  },
  gemini: {
    bin: "gemini",
    buildArgs: (prompt, _cwd) => ["-p", prompt, "-y"],
  },
};

/**
 * Execute a prompt via CLI engine (codex or gemini).
 * Returns the stdout output as a string.
 * Timeout: 5 minutes.
 */
export function runCliEngine(engine: EngineType, prompt: string, cwd: string): Promise<CliEngineResult> {
  const config = ENGINE_CONFIG[engine];

  return new Promise((resolve) => {
    const args = config.buildArgs(prompt, cwd);
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
