/**
 * Session Manager — tmux + node-pty 会话管理
 *
 * 每个 session 对应一个独立 tmux session。
 * pty 惰性创建：有 WebSocket 连接时 attach，断开后释放 pty（tmux 持久化）。
 * 重连时重新 attach 同一 tmux session。
 */

const pty = require("node-pty");
const { execSync } = require("child_process");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const TMUX = "/opt/homebrew/bin/tmux";
const WORK_DIR = process.env.WORK_DIR || path.join(os.homedir(), "mycc");
const MAX_BUFFER = 200 * 1024; // 200KB replay buffer per session

// Supported engines
const ENGINES = {
  claude: { cmd: "claude", name: "Claude Code" },
  codex: { cmd: "codex", name: "Codex CLI" },
  gemini: { cmd: "gemini", name: "Gemini CLI" },
};

class SessionManager {
  constructor() {
    // sessionId → { engine, tmuxName, pty, clients: Set<ws>, buffer, cwd, createdAt }
    this.sessions = new Map();
    this._discoverExisting();
  }

  /** Discover existing tmux sessions matching our naming pattern */
  _discoverExisting() {
    try {
      const out = execSync(`${TMUX} list-sessions -F "#{session_name}" 2>/dev/null`, {
        encoding: "utf8",
      });
      out
        .trim()
        .split("\n")
        .filter(Boolean)
        .forEach((name) => {
          // Match pattern: ccr-<engine>-<id> or ccr-<engine>
          const match = name.match(/^ccr-(\w+?)(?:-(.+))?$/);
          if (match && ENGINES[match[1]]) {
            const engine = match[1];
            const id = name;
            if (!this.sessions.has(id)) {
              this.sessions.set(id, {
                engine,
                tmuxName: name,
                pty: null,
                clients: new Set(),
                buffer: "",
                cwd: WORK_DIR,
                createdAt: new Date().toISOString(),
              });
            }
          }
        });
    } catch {}
  }

  /** List all sessions */
  list() {
    const result = [];
    for (const [id, s] of this.sessions) {
      const alive = this._tmuxAlive(s.tmuxName);
      result.push({
        id,
        engine: s.engine,
        engineName: ENGINES[s.engine]?.name || s.engine,
        name: s.name || null,
        cwd: s.cwd,
        connected: s.clients.size,
        alive,
        createdAt: s.createdAt,
      });
    }
    return result;
  }

  /** Create a new session */
  create(engine, cwd, name) {
    if (!ENGINES[engine]) throw new Error(`Unknown engine: ${engine}`);

    const shortId = crypto.randomBytes(3).toString("hex");
    const tmuxName = `ccr-${engine}-${shortId}`;
    const sessionCwd = cwd || WORK_DIR;

    // Create tmux session running the engine CLI
    // 使用 env 传递当前 PATH，确保 CLI 可被找到
    const cmd = ENGINES[engine].cmd;
    execSync(
      `${TMUX} new-session -d -s ${tmuxName} -c "${sessionCwd}" "PATH=${process.env.PATH} ${cmd}"`,
    );

    const entry = {
      engine,
      tmuxName,
      pty: null,
      clients: new Set(),
      buffer: "",
      cwd: sessionCwd,
      name: name || null,
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(tmuxName, entry);
    return { id: tmuxName, engine, engineName: ENGINES[engine].name, name: entry.name, cwd: sessionCwd };
  }

  /** Update session properties */
  update(id, opts) {
    const s = this.sessions.get(id);
    if (!s) return null;
    if (opts.name !== undefined) s.name = opts.name;
    return {
      id,
      engine: s.engine,
      engineName: ENGINES[s.engine]?.name || s.engine,
      name: s.name,
      cwd: s.cwd,
    };
  }

  /** Terminate a session */
  terminate(id) {
    const s = this.sessions.get(id);
    if (!s) return false;

    // Close all WebSocket clients
    for (const ws of s.clients) {
      ws.send(JSON.stringify({ type: "exit" }));
      ws.close();
    }

    // Kill pty
    if (s.pty) {
      try { s.pty.kill(); } catch {}
      s.pty = null;
    }

    // Kill tmux session
    try { execSync(`${TMUX} kill-session -t ${s.tmuxName} 2>/dev/null`); } catch {}

    this.sessions.delete(id);
    return true;
  }

  /** Attach a WebSocket client to a session */
  attach(id, ws) {
    const s = this.sessions.get(id);
    if (!s) return false;
    if (!this._tmuxAlive(s.tmuxName)) return false;

    s.clients.add(ws);

    // Create pty if not exists (lazy attach)
    if (!s.pty) {
      this._createPty(s);
    }

    // Send replay buffer
    if (s.buffer) {
      ws.send(JSON.stringify({ type: "output", data: s.buffer }));
    }

    return true;
  }

  /** Detach a WebSocket client */
  detach(id, ws) {
    const s = this.sessions.get(id);
    if (!s) return;

    s.clients.delete(ws);

    // If no more clients, release pty (but keep tmux alive)
    if (s.clients.size === 0 && s.pty) {
      try { s.pty.kill(); } catch {}
      s.pty = null;
    }
  }

  /** Write input to session */
  write(id, data) {
    const s = this.sessions.get(id);
    if (s && s.pty) s.pty.write(data);
  }

  /** Resize session terminal */
  resize(id, cols, rows) {
    const s = this.sessions.get(id);
    if (s && s.pty) {
      s.pty.resize(Math.max(cols || 80, 10), Math.max(rows || 24, 5));
    }
  }

  /** Create pty and attach to tmux session */
  _createPty(s) {
    const proc = pty.spawn(TMUX, ["attach-session", "-t", s.tmuxName], {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: s.cwd,
      env: Object.assign({}, process.env, { TERM: "xterm-256color" }),
    });

    proc.onData((data) => {
      // Append to replay buffer
      s.buffer += data;
      if (s.buffer.length > MAX_BUFFER) {
        s.buffer = s.buffer.slice(-MAX_BUFFER);
      }
      // Broadcast to all clients
      const msg = JSON.stringify({ type: "output", data });
      for (const ws of s.clients) {
        if (ws.readyState === 1) ws.send(msg);
      }
    });

    proc.onExit(() => {
      s.pty = null;
      const msg = JSON.stringify({ type: "exit" });
      for (const ws of s.clients) {
        if (ws.readyState === 1) ws.send(msg);
      }
    });

    s.pty = proc;
  }

  /** Check if tmux session is alive */
  _tmuxAlive(name) {
    try {
      execSync(`${TMUX} has-session -t ${name} 2>/dev/null`);
      return true;
    } catch {
      return false;
    }
  }

  /** Get available engines */
  static getEngines() {
    const result = [];
    for (const [key, val] of Object.entries(ENGINES)) {
      let available = false;
      try {
        execSync(`which ${val.cmd} 2>/dev/null`);
        available = true;
      } catch {}
      result.push({ id: key, name: val.name, cmd: val.cmd, available });
    }
    return result;
  }

  /** Get device info */
  static getDeviceInfo() {
    return {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      cpus: os.cpus().length,
      memory: Math.round(os.totalmem() / 1024 / 1024 / 1024) + "GB",
      uptime: Math.round(os.uptime() / 3600) + "h",
      node: process.version,
      defaultCwd: WORK_DIR,
    };
  }
}

module.exports = SessionManager;
