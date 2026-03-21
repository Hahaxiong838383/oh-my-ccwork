/**
 * cc-remote v3 — AI CLI Web Console (Binary Protocol Edition)
 *
 * 终端 I/O 走简单二进制帧 [opcode][payload]，零 JSON 开销。
 * 控制消息（会话管理、心跳）走 JSON text frame。
 */

delete process.env.CLAUDECODE;

const express = require("express");
const { WebSocketServer } = require("ws");
const http = require("http");
const path = require("path");
const fs = require("fs");
const SessionManager = require("./session-manager");
const {
  OP_TERMINAL_OUTPUT,
  OP_TERMINAL_INPUT,
  OP_TERMINAL_RESIZE,
  OP_REPLAY_BUFFER,
  encodeSimpleFrame,
  decodeSimpleFrame,
  decodeResize,
} = require("./protocol");

const app = express();
const server = http.createServer(app);

const WS_TOKEN = process.env.CC_REMOTE_TOKEN || null;
const ALLOWED_ORIGINS = process.env.CC_REMOTE_ORIGINS
  ? process.env.CC_REMOTE_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
  : [];

function verifyOrigin(req) {
  if (ALLOWED_ORIGINS.length === 0) return true;
  const origin = req.headers.origin || "";
  if (!origin) return true;
  return ALLOWED_ORIGINS.some((o) => origin === o || origin.startsWith(o));
}

const wss = new WebSocketServer({
  server,
  perMessageDeflate: false,
  verifyClient: ({ req }, done) => {
    if (!verifyOrigin(req)) {
      done(false, 403, "Forbidden");
      return;
    }
    done(true);
  },
});

const sm = new SessionManager();

// --- Static files ---
const distPath = path.join(__dirname, "dist");
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
}
app.get("/", (req, res) => {
  if (fs.existsSync(distPath)) {
    res.sendFile(path.join(distPath, "index.html"));
  } else {
    res.sendFile(path.join(__dirname, "index.html"));
  }
});

app.use(express.json());

// --- REST API ---

app.get("/api/device", (req, res) => res.json(SessionManager.getDeviceInfo()));
app.get("/api/engines", (req, res) => res.json(SessionManager.getEngines()));
app.get("/api/sessions", (req, res) => res.json(sm.list()));

app.post("/api/sessions", (req, res) => {
  try {
    const { engine, cwd, name } = req.body || {};
    res.json(sm.create(engine || "claude", cwd, name));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.patch("/api/sessions/:id", (req, res) => {
  const result = sm.update(req.params.id, req.body || {});
  if (result) res.json(result);
  else res.status(404).json({ error: "Session not found" });
});

app.delete("/api/sessions/:id", (req, res) => {
  const ok = sm.terminate(req.params.id);
  if (ok) res.json({ ok: true });
  else res.status(404).json({ error: "Session not found" });
});

app.get("/api/ping", (req, res) => res.json({ ts: Date.now(), version: "v3" }));

// --- WebSocket: Simple Binary Protocol ---

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (WS_TOKEN) {
    const clientToken = url.searchParams.get("token") || "";
    if (clientToken !== WS_TOKEN) {
      ws.send(JSON.stringify({ type: "error", error: "Unauthorized" }));
      ws.close(1008, "Unauthorized");
      return;
    }
  }

  const sessionId = url.searchParams.get("sessionId");
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

  // PTY 输出 → 简单二进制帧发给客户端
  sm.setOnData(sessionId, (sid, data) => {
    if (ws.readyState !== 1) return;
    if (data === null) {
      ws.send(JSON.stringify({ type: "exit" }));
      return;
    }
    ws.send(encodeSimpleFrame(OP_TERMINAL_OUTPUT, data));
  });

  // 发送回放缓冲
  const replay = sm.getReplayBuffer(sessionId);
  if (replay) {
    ws.send(encodeSimpleFrame(OP_REPLAY_BUFFER, replay));
  }

  ws.on("message", (raw, isBinary) => {
    if (isBinary) {
      // 简单二进制帧 [opcode][payload]
      const { opcode, payload } = decodeSimpleFrame(raw);
      switch (opcode) {
        case OP_TERMINAL_INPUT:
          sm.write(sessionId, payload.toString("utf8"));
          break;
        case OP_TERMINAL_RESIZE: {
          const { cols, rows } = decodeResize(payload);
          sm.resize(sessionId, cols, rows);
          break;
        }
      }
    } else {
      // JSON 控制消息（兼容）
      try {
        const msg = JSON.parse(raw.toString());
        switch (msg.type) {
          case "input":
            sm.write(sessionId, msg.data);
            break;
          case "resize":
            sm.resize(sessionId, msg.cols, msg.rows);
            break;
          case "ping":
            ws.send(JSON.stringify({ type: "pong", ts: msg.ts }));
            break;
        }
      } catch {}
    }
  });

  ws.on("close", () => {
    sm.detach(sessionId, ws);
    console.log(`[ws] -1 → ${sessionId}`);
  });
});

// --- Start ---
const PORT = parseInt(process.env.PORT || "7681");
server.listen(PORT, "0.0.0.0", () => {
  console.log(`[cc-remote-v3] http://0.0.0.0:${PORT}`);
  console.log(`[cc-remote-v3] Protocol: Simple binary frames [opcode][payload]`);
  console.log(`[cc-remote-v3] Sessions: ${sm.list().length} existing`);
  console.log(`[cc-remote-v3] Engines: ${SessionManager.getEngines().filter((e) => e.available).map((e) => e.name).join(", ") || "none"}`);
});
