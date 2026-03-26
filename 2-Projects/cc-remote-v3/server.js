/**
 * cc-remote v3 — Multi-Session AI CLI Web Console
 *
 * JSON WS 模式（FNOS 验证通过，中文正常）
 * 多 session 管理：claude / codex / gemini + 动态创建
 * Basic Auth 认证
 */

const express = require("express");
const { WebSocketServer } = require("ws");
const pty = require("node-pty");
const http = require("http");
const path = require("path");
const { execSync } = require("child_process");
const os = require("os");
const fs = require("fs");
const crypto = require("crypto");

// ============ 配置 ============

const PORT = parseInt(process.env.PORT || "7681");
const WORK_DIR = process.env.WORK_DIR || path.join(os.homedir(), "mycc");
const AUTH_USER = process.env.CC_REMOTE_USER || "admin";
const AUTH_PASS = process.env.CC_REMOTE_PASS;
if (!AUTH_PASS) { console.error("请设置环境变量 CC_REMOTE_PASS"); process.exit(1); }
const MAX_BUFFER = 200 * 1024; // 200KB 回放缓冲

// 跨平台 tmux 检测
function findBin(name) {
  const candidates = [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, `/usr/bin/${name}`];
  for (const p of candidates) { if (fs.existsSync(p)) return p; }
  try { return execSync(`which ${name} 2>/dev/null`, { encoding: "utf8" }).trim(); } catch { return name; }
}

const TMUX = findBin("tmux");

const ENGINES = {
  claude: { cmd: "claude", name: "Claude Code" },
  codex:  { cmd: "codex",  name: "Codex CLI" },
  gemini: { cmd: "gemini", name: "Gemini CLI" },
};

// ============ Basic Auth 中间件 ============

function basicAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="cc-remote"');
    return res.status(401).json({ error: "Authentication required" });
  }
  const [user, pass] = Buffer.from(auth.split(" ")[1], "base64").toString().split(":");
  if (user === AUTH_USER && pass === AUTH_PASS) return next();
  res.setHeader("WWW-Authenticate", 'Basic realm="cc-remote"');
  return res.status(401).json({ error: "Invalid credentials" });
}

// WS 认证（从 query 参数或 cookie 验证）
function verifyWsAuth(req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get("token");
  if (token === Buffer.from(`${AUTH_USER}:${AUTH_PASS}`).toString("base64")) return true;
  // 也接受 Basic Auth header
  const auth = req.headers.authorization;
  if (auth && auth.startsWith("Basic ")) {
    const [user, pass] = Buffer.from(auth.split(" ")[1], "base64").toString().split(":");
    return user === AUTH_USER && pass === AUTH_PASS;
  }
  return false;
}

// ============ Session 管理 ============

// sessionId → { engine, tmuxName, pty, clients: Set<ws>, buffer, createdAt }
const sessions = new Map();

// 启动时发现已有 tmux session
function discoverSessions() {
  try {
    const out = execSync(`${TMUX} list-sessions -F "#{session_name}" 2>/dev/null`, { encoding: "utf8" });
    out.trim().split("\n").filter(Boolean).forEach((name) => {
      const match = name.match(/^ccr-(\w+?)(?:-(.+))?$/);
      if (match && ENGINES[match[1]] && !sessions.has(name)) {
        sessions.set(name, {
          engine: match[1],
          tmuxName: name,
          pty: null,
          clients: new Set(),
          buffer: "",
          createdAt: new Date().toISOString(),
        });
      }
    });
  } catch {}
}

function createSession(engine) {
  if (!ENGINES[engine]) throw new Error("Unknown engine: " + engine);
  const shortId = crypto.randomBytes(3).toString("hex");
  const tmuxName = `ccr-${engine}-${shortId}`;
  const cmd = ENGINES[engine].cmd;

  execSync(`${TMUX} new-session -d -s ${tmuxName} -c "${WORK_DIR}"`);
  execSync(`${TMUX} send-keys -t ${tmuxName} "unset CLAUDECODE; ${cmd}" Enter`);

  const entry = {
    engine,
    tmuxName,
    pty: null,
    clients: new Set(),
    buffer: "",
    createdAt: new Date().toISOString(),
  };
  sessions.set(tmuxName, entry);
  return tmuxName;
}

function terminateSession(id) {
  const s = sessions.get(id);
  if (!s) return false;
  for (const ws of s.clients) {
    ws.send(JSON.stringify({ type: "exit" }));
    try { ws.close(); } catch {}
  }
  if (s.pty) { try { s.pty.kill(); } catch {} }
  try { execSync(`${TMUX} kill-session -t ${s.tmuxName} 2>/dev/null`); } catch {}
  sessions.delete(id);
  return true;
}

function tmuxAlive(name) {
  try { execSync(`${TMUX} has-session -t ${name} 2>/dev/null`); return true; } catch { return false; }
}

function getOrCreatePty(s) {
  if (s.pty) return s.pty;

  const proc = pty.spawn(TMUX, ["attach-session", "-t", s.tmuxName], {
    name: "xterm-256color",
    cols: 120,
    rows: 40,
    cwd: WORK_DIR,
    env: Object.assign({}, process.env, { TERM: "xterm-256color" }),
  });

  proc.onData(function (data) {
    // 回放缓冲
    s.buffer += data;
    if (s.buffer.length > MAX_BUFFER) s.buffer = s.buffer.slice(-MAX_BUFFER);
    // 广播
    const msg = JSON.stringify({ type: "output", data: data });
    s.clients.forEach(function (ws) {
      if (ws.readyState === 1) ws.send(msg);
    });
  });

  proc.onExit(function () {
    s.pty = null;
    const msg = JSON.stringify({ type: "exit" });
    s.clients.forEach(function (ws) {
      if (ws.readyState === 1) ws.send(msg);
    });
  });

  s.pty = proc;
  return proc;
}

// ============ HTTP Server ============

const app = express();
const server = http.createServer(app);

// 静态文件（不需要认证，前端 JS 自己处理登录）
app.use(express.static(path.join(__dirname, "dist")));
app.use(express.json());

// API（需要认证）
app.get("/api/device", basicAuth, (req, res) => {
  res.json({
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    cpus: os.cpus().length,
    memory: Math.round(os.totalmem() / 1024 / 1024 / 1024) + "GB",
    node: process.version,
  });
});

app.get("/api/engines", basicAuth, (req, res) => {
  const result = [];
  for (const [key, val] of Object.entries(ENGINES)) {
    let available = false;
    try { execSync(`which ${val.cmd} 2>/dev/null`); available = true; } catch {}
    result.push({ id: key, name: val.name, available });
  }
  res.json(result);
});

app.get("/api/sessions", basicAuth, (req, res) => {
  const list = [];
  for (const [id, s] of sessions) {
    list.push({
      id,
      engine: s.engine,
      engineName: ENGINES[s.engine]?.name || s.engine,
      connected: s.clients.size,
      alive: tmuxAlive(s.tmuxName),
      createdAt: s.createdAt,
    });
  }
  res.json(list);
});

app.post("/api/sessions", basicAuth, (req, res) => {
  try {
    const engine = (req.body && req.body.engine) || "claude";
    const id = createSession(engine);
    const s = sessions.get(id);
    res.json({ id, engine, engineName: ENGINES[engine].name });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/sessions/:id", basicAuth, (req, res) => {
  if (terminateSession(req.params.id)) res.json({ ok: true });
  else res.status(404).json({ error: "Session not found" });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime(), sessions: sessions.size, version: "v3" });
});

app.get("/api/ping", basicAuth, (req, res) => {
  res.json({ ts: Date.now(), version: "v3" });
});

// ============ WebSocket ============

const wss = new WebSocketServer({ server });

wss.on("connection", function (ws, req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sessionId = url.searchParams.get("sessionId");

  // WS 认证
  if (!verifyWsAuth(req)) {
    ws.send(JSON.stringify({ type: "error", error: "Unauthorized" }));
    ws.close(1008, "Unauthorized");
    return;
  }

  if (!sessionId) {
    ws.send(JSON.stringify({ type: "error", error: "Missing sessionId" }));
    ws.close();
    return;
  }

  const s = sessions.get(sessionId);
  if (!s || !tmuxAlive(s.tmuxName)) {
    ws.send(JSON.stringify({ type: "error", error: "Session not found or dead" }));
    ws.close();
    return;
  }

  s.clients.add(ws);
  const term = getOrCreatePty(s);
  console.log(`[ws] +1 → ${sessionId} (total: ${s.clients.size})`);

  // 发送回放缓冲
  if (s.buffer) {
    ws.send(JSON.stringify({ type: "output", data: s.buffer }));
  }

  ws.on("message", function (msg) {
    try {
      const parsed = JSON.parse(msg);
      if (parsed.type === "input" && s.pty) {
        s.pty.write(parsed.data);
      } else if (parsed.type === "resize" && s.pty) {
        s.pty.resize(Math.max(parsed.cols || 80, 10), Math.max(parsed.rows || 24, 5));
      } else if (parsed.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", ts: parsed.ts }));
      }
    } catch {}
  });

  ws.on("close", function () {
    s.clients.delete(ws);
    console.log(`[ws] -1 → ${sessionId} (total: ${s.clients.size})`);
    // 无客户端时释放 pty（tmux 保留）
    if (s.clients.size === 0 && s.pty) {
      try { s.pty.kill(); } catch {}
      s.pty = null;
    }
  });
});

// ============ 启动 ============

discoverSessions();

server.listen(PORT, "0.0.0.0", function () {
  console.log(`[cc-remote-v3] http://0.0.0.0:${PORT}`);
  console.log(`[cc-remote-v3] Auth: ${AUTH_USER} / ****`);
  console.log(`[cc-remote-v3] Sessions: ${sessions.size} existing`);
  const engines = Object.entries(ENGINES).filter(([k, v]) => {
    try { execSync(`which ${v.cmd} 2>/dev/null`); return true; } catch { return false; }
  }).map(([k, v]) => v.name);
  console.log(`[cc-remote-v3] Engines: ${engines.join(", ") || "none"}`);
});
