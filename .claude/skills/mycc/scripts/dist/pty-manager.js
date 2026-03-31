/**
 * PTY Manager - 管理多个 CLI 终端会话
 *
 * 支持 claude / codex / gemini 等 CLI 的远程终端访问
 * 通过 node-pty 创建伪终端，WebSocket 转发输入输出
 */
import { randomBytes } from "crypto";
import { execSync } from "child_process";
const SUPPORTED_CLIS = [
    { name: "claude", command: "claude", detectCmd: "claude --version" },
    { name: "codex", command: "codex", detectCmd: "codex --version" },
    { name: "gemini", command: "gemini", detectCmd: "gemini --version" },
];
export function detectClis() {
    return SUPPORTED_CLIS.map((cli) => {
        try {
            const version = execSync(cli.detectCmd, {
                timeout: 5000,
                encoding: "utf-8",
                stdio: ["pipe", "pipe", "pipe"],
            }).trim();
            return { ...cli, version, available: true };
        }
        catch {
            return { ...cli, version: null, available: false };
        }
    });
}
export class PTYManager {
    sessions = new Map();
    maxSessions;
    constructor(maxSessions = 10) {
        this.maxSessions = maxSessions;
    }
    async create(cli, command, cols = 80, rows = 24, cwd) {
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
            env: { ...process.env },
        });
        const id = randomBytes(8).toString("hex");
        const session = {
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
    get(id) {
        return this.sessions.get(id);
    }
    write(id, data) {
        const session = this.sessions.get(id);
        if (!session)
            throw new Error(`Session ${id} not found`);
        session.pty.write(data);
    }
    resize(id, cols, rows) {
        const session = this.sessions.get(id);
        if (!session)
            throw new Error(`Session ${id} not found`);
        session.pty.resize(cols, rows);
        session.cols = cols;
        session.rows = rows;
    }
    kill(id) {
        const session = this.sessions.get(id);
        if (!session)
            return;
        try {
            session.pty.kill();
        }
        catch {
            // already dead
        }
        this.sessions.delete(id);
    }
    list() {
        return Array.from(this.sessions.values()).map((s) => ({
            id: s.id,
            cli: s.cli,
            createdAt: s.createdAt,
        }));
    }
    killAll() {
        for (const [id] of this.sessions) {
            this.kill(id);
        }
    }
    get count() {
        return this.sessions.size;
    }
}
//# sourceMappingURL=pty-manager.js.map