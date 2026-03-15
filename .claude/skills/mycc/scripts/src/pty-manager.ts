/**
 * PTY Manager - 管理多个 CLI 终端会话
 *
 * 支持 claude / codex / gemini 等 CLI 的远程终端访问
 * 通过 node-pty 创建伪终端，WebSocket 转发输入输出
 */

import { randomBytes } from "crypto";
import { execSync } from "child_process";

// node-pty types (dynamic import)
interface IPty {
  onData: (callback: (data: string) => void) => { dispose: () => void };
  onExit: (callback: (e: { exitCode: number; signal?: number }) => void) => { dispose: () => void };
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: (signal?: string) => void;
  pid: number;
}

export interface CliInfo {
  name: string;
  command: string;
  detectCmd: string;
  version: string | null;
  available: boolean;
}

export interface TerminalSession {
  id: string;
  cli: string;
  pty: IPty;
  createdAt: Date;
  cols: number;
  rows: number;
}

const SUPPORTED_CLIS = [
  { name: "claude", command: "claude", detectCmd: "claude --version" },
  { name: "codex", command: "codex", detectCmd: "codex --version" },
  { name: "gemini", command: "gemini", detectCmd: "gemini --version" },
];

export function detectClis(): CliInfo[] {
  return SUPPORTED_CLIS.map((cli) => {
    try {
      const version = execSync(cli.detectCmd, {
        timeout: 5000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      return { ...cli, version, available: true };
    } catch {
      return { ...cli, version: null, available: false };
    }
  });
}

export class PTYManager {
  private sessions = new Map<string, TerminalSession>();
  private maxSessions: number;

  constructor(maxSessions: number = 10) {
    this.maxSessions = maxSessions;
  }

  async create(
    cli: string,
    command: string,
    cols: number = 80,
    rows: number = 24,
    cwd?: string
  ): Promise<TerminalSession> {
    if (this.sessions.size >= this.maxSessions) {
      throw new Error(`Max sessions (${this.maxSessions}) reached`);
    }

    // Dynamic import for node-pty (native module)
    const pty = await import("node-pty");

    const isWindows = process.platform === "win32";
    const shell = isWindows ? "cmd.exe" : "bash";
    const shellArgs = isWindows ? ["/c", command] : ["-c", command];

    const ptyProcess = pty.spawn(shell, shellArgs, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: cwd || process.env.HOME || process.env.USERPROFILE || "/",
      env: { ...process.env } as Record<string, string>,
    });

    const id = randomBytes(8).toString("hex");
    const session: TerminalSession = {
      id,
      cli,
      pty: ptyProcess,
      createdAt: new Date(),
      cols,
      rows,
    };

    this.sessions.set(id, session);
    return session;
  }

  get(id: string): TerminalSession | undefined {
    return this.sessions.get(id);
  }

  write(id: string, data: string): void {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session ${id} not found`);
    session.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session ${id} not found`);
    session.pty.resize(cols, rows);
    session.cols = cols;
    session.rows = rows;
  }

  kill(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    try {
      session.pty.kill();
    } catch {
      // already dead
    }
    this.sessions.delete(id);
  }

  list(): Array<{ id: string; cli: string; createdAt: Date }> {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      cli: s.cli,
      createdAt: s.createdAt,
    }));
  }

  killAll(): void {
    for (const [id] of this.sessions) {
      this.kill(id);
    }
  }

  get count(): number {
    return this.sessions.size;
  }
}
