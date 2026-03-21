/**
 * cc-remote v3 — AI CLI Web Console (Binary Protocol Edition)
 *
 * V3 核心优化：
 *  1. 终端 I/O 走二进制帧（opcode + reqId + payload），零 JSON 开销
 *  2. 控制消息（会话管理、心跳）走 JSON text frame
 *  3. WS 直连模式：浏览器直接连本地 WS 时，终端数据也走二进制
 *  4. 保留 REST API 兼容 V2 前端
 */

// 清除 CLAUDECODE 防止 claude CLI 误判嵌套会话
delete process.env.CLAUDECODE;

const express = require("express");
const { WebSocketServer } = require("ws");
const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");
const SessionManager = require("./session-manager");
const {
  OP_TERMINAL_OUTPUT,
  OP_TERMINAL_INPUT,
  OP_TERMINAL_RESIZE,
  OP_REPLAY_BUFFER,
  encodeBinaryFrame,
  decodeBinaryFrame,
  decodeResize,
} = require("./protocol");

const app = express();
const server = http.createServer(app);

// --- Security ---
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
  perMessageDeflate: false, // 终端二进制数据不压缩（压缩增加延迟）
  verifyClient: ({ req }, done) => {
    if (!verifyOrigin(req)) {
      console.warn("[ws] reject origin:", req.headers.origin);
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
} else {
  app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
}

app.use(express.json());

// --- REST API (兼容 V2) ---

app.get("/api/device", (req, res) => {
  res.json(SessionManager.getDeviceInfo());
});

app.get("/api/engines", (req, res) => {
  res.json(SessionManager.getEngines());
});

app.get("/api/sessions", (req, res) => {
  res.json(sm.list());
});

app.post("/api/sessions", (req, res) => {
  try {
    const { engine, cwd, name } = req.body || {};
    const session = sm.create(engine || "claude", cwd, name);
    res.json(session);
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

app.get("/api/ping", (req, res) => {
  res.json({ ts: Date.now(), version: "v3" });
});

// --- WebSocket: Binary Protocol ---

// 为每个 session 维护一个 reqId（用于 tunnel 模式下区分流）
// 直连模式下 reqId 由 sessionId 的 hex 生成
function sessionToReqId(sessionId) {
  // 取 sessionId 的 md5 前 16 bytes → 32 char hex
  const crypto = require("crypto");
  return crypto.createHash("md5").update(sessionId).digest("hex");
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Token 校验
  if (WS_TOKEN) {
    const clientToken = url.searchParams.get("token") || "";
    if (clientToken !== WS_TOKEN) {
      ws.send(JSON.stringify({ type: "error", error: "Unauthorized" }));
      ws.close(1008, "Unauthorized");
      return;
    }
  }

  const sessionId = url.searchParams.get("sessionId");
  const mode = url.searchParams.get("mode") || "binary"; // binary | legacy

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

  const reqId = sessionToReqId(sessionId);
  console.log(`[ws] +1 → ${sessionId} (mode=${mode})`);

  // 设置 PTY 输出回调：发送二进制帧给客户端
  sm.setOnData(sessionId, (sid, data) => {
    if (data === null) {
      // Session exit
      ws.send(JSON.stringify({ type: "exit" }));
      return;
    }

    if (ws.readyState !== 1) return;

    if (mode === "binary") {
      // V3: 二进制帧
      const frame = encodeBinaryFrame(OP_TERMINAL_OUTPUT, reqId, data);
      ws.send(frame);
    } else {
      // Legacy: JSON 兼容
      ws.send(JSON.stringify({ type: "output", data }));
    }
  });

  // 发送回放缓冲
  const replay = sm.getReplayBuffer(sessionId);
  if (replay) {
    if (mode === "binary") {
      const frame = encodeBinaryFrame(OP_REPLAY_BUFFER, reqId, replay);
      ws.send(frame);
    } else {
      ws.send(JSON.stringify({ type: "output", data: replay }));
    }
  }

  ws.on("message", (raw, isBinary) => {
    if (isBinary) {
      // V3: 二进制帧
      const { opcode, payload } = decodeBinaryFrame(raw);
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
      // JSON 控制消息（兼容 V2）
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
  console.log(`[cc-remote-v3] Protocol: Binary frames (terminal) + JSON (control)`);
  console.log(`[cc-remote-v3] Sessions: ${sm.list().length} existing`);
  console.log(`[cc-remote-v3] Engines: ${SessionManager.getEngines().filter((e) => e.available).map((e) => e.name).join(", ") || "none"}`);
});
