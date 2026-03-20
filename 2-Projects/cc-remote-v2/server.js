/**
 * cc-remote v2 — AI CLI Web Console
 *
 * Express + WebSocket + node-pty + tmux
 * 支持 Claude Code / Codex / Gemini CLI 远程访问
 */

const express = require("express");
const { WebSocketServer } = require("ws");
const http = require("http");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const SessionManager = require("./session-manager");

const app = express();
const server = http.createServer(app);
// --- WS Security ---
// CC_REMOTE_TOKEN: 若设置，WS 连接需携带 ?token=xxx（本地开发不需要）
const WS_TOKEN = process.env.CC_REMOTE_TOKEN || null;

// CC_REMOTE_ORIGINS: 逗号分隔的允许 Origin 列表（空=全部允许）
// 示例：CC_REMOTE_ORIGINS=https://cli.hahaxiong.com,https://mycc.dev
const ALLOWED_ORIGINS = process.env.CC_REMOTE_ORIGINS
  ? process.env.CC_REMOTE_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
  : [];

function verifyOrigin(req) {
  if (ALLOWED_ORIGINS.length === 0) return true; // 未配置则全放行
  const origin = req.headers.origin || '';
  // 允许无 origin（curl、本地 ws:// 连接）
  if (!origin) return true;
  return ALLOWED_ORIGINS.some(o => origin === o || origin.startsWith(o));
}

const wss = new WebSocketServer({
  server,
  verifyClient: ({ req }, done) => {
    if (!verifyOrigin(req)) {
      console.warn('[ws] 拒绝非法 Origin:', req.headers.origin);
      done(false, 403, 'Forbidden');
      return;
    }
    done(true);
  },
});
const sm = new SessionManager();

// Static files (Vite dist)
const distPath = path.join(__dirname, "dist");
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
} else {
  // Dev mode: serve index.html directly
  app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
}

app.use(express.json());

// --- REST API ---

// Device info
app.get("/api/device", (req, res) => {
  res.json(SessionManager.getDeviceInfo());
});

// Available engines
app.get("/api/engines", (req, res) => {
  res.json(SessionManager.getEngines());
});

// List sessions
app.get("/api/sessions", (req, res) => {
  res.json(sm.list());
});

// Create session
app.post("/api/sessions", (req, res) => {
  try {
    const { engine, cwd } = req.body || {};
    const session = sm.create(engine || "claude", cwd);
    res.json(session);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Terminate session
app.delete("/api/sessions/:id", (req, res) => {
  const ok = sm.terminate(req.params.id);
  if (ok) res.json({ ok: true });
  else res.status(404).json({ error: "Session not found" });
});

// File upload
const uploadsDir = path.join(__dirname, "uploads");
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const sessionId = req.body.sessionId || "default";
      const dir = path.join(uploadsDir, sessionId);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      // Preserve original filename, add timestamp if exists
      const name = file.originalname;
      const dest = path.join(uploadsDir, req.body.sessionId || "default", name);
      if (fs.existsSync(dest)) {
        const ext = path.extname(name);
        const base = path.basename(name, ext);
        cb(null, `${base}_${Date.now()}${ext}`);
      } else {
        cb(null, name);
      }
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

app.post("/api/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });
  res.json({ ok: true, path: req.file.path, filename: req.file.filename });
});

// --- WebSocket ---

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Token 校验（仅在 CC_REMOTE_TOKEN 设置时启用）
  if (WS_TOKEN) {
    const clientToken = url.searchParams.get('token') || '';
    if (clientToken !== WS_TOKEN) {
      console.warn('[ws] Token 校验失败，拒绝连接');
      ws.send(JSON.stringify({ type: 'error', error: 'Unauthorized' }));
      ws.close(1008, 'Unauthorized');
      return;
    }
  }

  const sessionId = url.searchParams.get('sessionId');

  if (!sessionId) {
    ws.send(JSON.stringify({ type: "error", error: "Missing sessionId" }));
    ws.close();
    return;
  }

  const ok = sm.attach(sessionId, ws);
  if (!ok) {
    ws.send(JSON.stringify({ type: "error", error: "Session not found or dead" }));
    ws.close();
    return;
  }

  console.log(`[ws] +1 → ${sessionId}`);

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === "input") {
        sm.write(sessionId, msg.data);
      } else if (msg.type === "resize") {
        sm.resize(sessionId, msg.cols, msg.rows);
      }
    } catch {}
  });

  ws.on("close", () => {
    sm.detach(sessionId, ws);
    console.log(`[ws] -1 → ${sessionId}`);
  });
});

// --- Start ---

const PORT = parseInt(process.env.PORT || "7681");
server.listen(PORT, "0.0.0.0", () => {
  console.log(`[cc-remote-v2] http://0.0.0.0:${PORT}`);
  console.log(`[cc-remote-v2] Sessions: ${sm.list().length} existing`);
  console.log(`[cc-remote-v2] Engines: ${SessionManager.getEngines().filter(e => e.available).map(e => e.name).join(", ")}`);
});
