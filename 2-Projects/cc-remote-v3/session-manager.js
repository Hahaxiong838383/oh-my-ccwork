/**
 * Session Manager v3 — tmux + node-pty
 *
 * V3 优化：
 *  - PTY 输出直接作为 Buffer 传递，不做 JSON 封装
 *  - 回放缓冲区用 Buffer 存储
 *  - onData 回调接收原始 Buffer
 *  - 跨平台 tmux 路径检测
 */

const pty = require("node-pty");
const { execSync } = require("child_process");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");

// 跨平台 tmux 检测
function findTmux() {
  const candidates = [
    "/opt/homebrew/bin/tmux",  // macOS Apple Silicon
    "/usr/local/bin/tmux",     // macOS Intel / Linux
    "/usr/bin/tmux",           // Linux system
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  // fallback: which tmux
  try {
    return execSync("which tmux 2>/dev/null", { encoding: "utf8" }).trim();
  } catch {
    throw new Error("tmux not found. Install: brew install tmux / apt install tmux");
  }
}

const TMUX = findTmux();
const WORK_DIR = process.env.WORK_DIR || path.join(os.homedir(), "mycc");
const MAX_BUFFER = 200 * 1024; // 200KB replay buffer

// Supported engines
const ENGINES = {
  claude: { cmd: "claude", name: "Claude Code" },
  codex:  { cmd: "codex",  name: "Codex CLI" },
  gemini: { cmd: "gemini", name: "Gemini CLI" },
};

class SessionManager {
  constructor() {
    // sessionId → { engine, tmuxName, pty, clients: Set, buffer: Buffer[], bufferLen, cwd, createdAt, name, onData }
    this.sessions = new Map();
    this._discoverExisting();
  }

  /** Discover existing tmux sessions matching our naming pattern */
  _discoverExisting() {
    try {
      const out = execSync(`${TMUX} list-sessions -F "#{session_name}" 2>/dev/null`, {
        encoding: "utf8",
      });
      out.trim().split("\n").filter(Boolean).forEach((name) => {
        const match = name.match(/^ccr-(\w+?)(?:-(.+))?$/);
        if (match && ENGINES[match[1]]) {
          const engine = match[1];
          if (!this.sessions.has(name)) {
            this.sessions.set(name, {
              engine,
              tmuxName: name,
              pty: null,
              clients: new Set(),
              buffer: [],
              bufferLen: 0,
              cwd: WORK_DIR,
              createdAt: new Date().toISOString(),
              name: null,
              onData: null, // callback(data: Buffer)
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

    const cmdName = ENGINES[engine].cmd;
    execSync(
      `${TMUX} new-session -d -s ${tmuxName} -c "${sessionCwd}" "$SHELL -lc 'unset CLAUDECODE; ${cmdName}'"`,
    );

    const entry = {
      engine,
      tmuxName,
      pty: null,
      clients: new Set(),
      buffer: [],
      bufferLen: 0,
      cwd: sessionCwd,
      name: name || null,
      createdAt: new Date().toISOString(),
      onData: null,
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

    for (const ws of s.clients) {
      try { ws.close(); } catch {}
    }

    if (s.pty) {
      try { s.pty.kill(); } catch {}
      s.pty = null;
    }

    try { execSync(`${TMUX} kill-session -t ${s.tmuxName} 2>/dev/null`); } catch {}

    this.sessions.delete(id);
    return true;
  }

  /**
   * Set the onData callback for a session.
   * Called with (sessionId, data: string) whenever PTY produces output.
   */
  setOnData(id, callback) {
    const s = this.sessions.get(id);
    if (s) s.onData = callback;
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

    return true;
  }

  /** Get replay buffer as concatenated string */
  getReplayBuffer(id) {
    const s = this.sessions.get(id);
    if (!s || s.bufferLen === 0) return null;
    return s.buffer.join("");
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
      // Append to replay buffer (string chunks)
      s.buffer.push(data);
      s.bufferLen += data.length;

      // Trim buffer if too large
      while (s.bufferLen > MAX_BUFFER && s.buffer.length > 1) {
        const removed = s.buffer.shift();
        s.bufferLen -= removed.length;
      }

      // Fire onData callback (session-manager doesn't care about WS protocol)
      if (s.onData) {
        s.onData(s.tmuxName, data);
      }
    });

    proc.onExit(() => {
      s.pty = null;
      // Notify via onData with null to signal exit
      if (s.onData) {
        s.onData(s.tmuxName, null);
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
