/**
 * cc-remote v3 — Relay Tunnel Client (Binary Protocol Edition)
 *
 * V3 核心优化：
 *  1. 终端 WS 数据走 Binary 帧直传（不做 JSON 封装）
 *  2. Relay ↔ Tunnel 之间：Binary frame = 终端数据透传, Text frame = JSON 控制消息
 *  3. HTTP 代理 / SSE 仍走 JSON（与 V2 相同）
 *  4. 心跳也走 Binary 节省解析开销
 *
 * 用法: RELAY_URL=https://relay.hahaxiong.cc DEVICE_ID=mac-mini node tunnel-client.js
 */

const WebSocket = require("ws");
const {
  OP_TERMINAL_OUTPUT,
  OP_TERMINAL_INPUT,
  OP_TERMINAL_RESIZE,
  OP_REPLAY_BUFFER,
  encodeBinaryFrame,
  decodeBinaryFrame,
} = require("./protocol");

const RELAY_URL = process.env.RELAY_URL || "https://relay.hahaxiong.cc";
const LOCAL_PORT = parseInt(process.env.PORT || "7681");
const DEVICE_ID = process.env.DEVICE_ID || `cc-v3-${require("os").hostname()}`;

let token = null;
let tunnelWs = null;
let heartbeatTimer = null;

// reqId → local WebSocket (for WS proxy)
const localWsMap = new Map();

// ============ 注册 ============

async function register() {
  const pairCode = Math.random().toString(36).slice(2, 8).toUpperCase();
  const res = await fetch(`${RELAY_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: DEVICE_ID, pairCode }),
  });
  const data = await res.json();
  token = data.token;
  console.log(`[Tunnel] 注册${data.isNewDevice ? "（新设备）" : ""} device=${DEVICE_ID} token=${token.slice(0, 8)}...`);
  console.log(`[Tunnel] 公网访问地址: ${RELAY_URL}/api/${token}/`);
}

// ============ 隧道连接 ============

function connect() {
  const wsUrl = RELAY_URL.replace(/^http/, "ws") + `/tunnel?token=${token}`;
  console.log(`[Tunnel] 连接 Relay...`);

  tunnelWs = new WebSocket(wsUrl);

  tunnelWs.on("open", () => {
    console.log(`[Tunnel] 已连接 Relay`);

    // 心跳：每 25s 发送一次（Binary 帧，1 byte opcode 0xFF）
    heartbeatTimer = setInterval(() => {
      if (tunnelWs.readyState === WebSocket.OPEN) {
        // 仍然用 JSON 心跳保持兼容（Relay 可能还需要解析）
        tunnelWs.send(JSON.stringify({ type: "heartbeat" }));
      }
    }, 25000);
  });

  tunnelWs.on("message", (raw, isBinary) => {
    if (isBinary) {
      // ===== 二进制帧：终端数据 =====
      // 来自浏览器的输入/resize，直接转发到本地 WS
      handleBinaryFromRelay(raw);
    } else {
      // ===== JSON 控制消息 =====
      handleJsonFromRelay(raw);
    }
  });

  tunnelWs.on("close", () => {
    console.log("[Tunnel] 断开，5s 后重连...");
    clearInterval(heartbeatTimer);
    localWsMap.forEach((ws) => { try { ws.close(); } catch {} });
    localWsMap.clear();
    setTimeout(connect, 5000);
  });

  tunnelWs.on("error", (e) => console.error("[Tunnel] 错误:", e.message));
}

// ============ 二进制帧处理 ============

function handleBinaryFromRelay(raw) {
  const { opcode, reqId, payload } = decodeBinaryFrame(raw);

  switch (opcode) {
    case OP_TERMINAL_INPUT:
    case OP_TERMINAL_RESIZE: {
      // 转发到对应的本地 WS 连接
      const ws = localWsMap.get(reqId);
      if (ws && ws.readyState === WebSocket.OPEN) {
        // 直接转发二进制帧到本地 cc-remote-v3 server
        ws.send(raw);
      }
      break;
    }
  }
}

// ============ JSON 控制消息处理 ============

function handleJsonFromRelay(raw) {
  try {
    const msg = JSON.parse(raw.toString());

    if (msg.type === "heartbeat-ack") return;

    switch (msg.type) {
      case "http-request":
        handleHttp(msg);
        break;

      case "ws-open":
        handleWsOpen(msg);
        break;

      case "ws-data": {
        // V2 兼容：JSON 封装的 WS 数据
        const ws = localWsMap.get(msg.reqId);
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(msg.data);
        }
        break;
      }

      case "ws-close": {
        const ws = localWsMap.get(msg.reqId);
        if (ws) {
          try { ws.close(msg.code || 1000); } catch {}
          localWsMap.delete(msg.reqId);
        }
        break;
      }
    }
  } catch (e) {
    console.error("[Tunnel] JSON 解析错误:", e.message);
  }
}

// ============ 发送到 Relay ============

function sendJson(msg) {
  if (tunnelWs && tunnelWs.readyState === WebSocket.OPEN) {
    tunnelWs.send(JSON.stringify(msg));
  }
}

function sendBinary(buf) {
  if (tunnelWs && tunnelWs.readyState === WebSocket.OPEN) {
    tunnelWs.send(buf);
  }
}

// ============ HTTP 代理（与 V2 相同） ============

async function handleHttp(msg) {
  try {
    const headers = { ...(msg.headers || {}) };
    delete headers["host"];
    delete headers["connection"];
    delete headers["transfer-encoding"];

    const res = await fetch(`http://localhost:${LOCAL_PORT}${msg.path}`, {
      method: msg.method,
      headers,
      body: msg.method !== "GET" && msg.method !== "HEAD" ? msg.body : undefined,
    });

    const ct = res.headers.get("content-type") || "";
    if (ct.includes("text/event-stream")) {
      sendJson({
        reqId: msg.reqId,
        type: "sse-start",
        status: res.status,
        headers: Object.fromEntries(res.headers.entries()),
      });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sendJson({ reqId: msg.reqId, type: "sse", data: dec.decode(value, { stream: true }) });
      }
      sendJson({ reqId: msg.reqId, type: "sse-end" });
    } else {
      sendJson({
        reqId: msg.reqId,
        type: "http-response",
        status: res.status,
        headers: Object.fromEntries(res.headers.entries()),
        body: await res.text(),
      });
    }
  } catch (e) {
    sendJson({ reqId: msg.reqId, type: "http-error", error: e.message });
  }
}

// ============ WS 代理（V3：终端数据走 Binary 直传） ============

function handleWsOpen(msg) {
  try {
    // 连接本地 cc-remote-v3 server 的 WS（带 binary mode）
    const localUrl = `ws://localhost:${LOCAL_PORT}${msg.path}`;
    const ws = new WebSocket(localUrl);

    ws.on("open", () => {
      localWsMap.set(msg.reqId, ws);
      sendJson({ reqId: msg.reqId, type: "ws-opened" });
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        // ===== V3: 终端输出 Binary 帧 → 直接透传给 Relay =====
        // 不做任何封装，Relay 直接转发给浏览器
        sendBinary(data);
      } else {
        // JSON 控制消息（exit 等）
        sendJson({ reqId: msg.reqId, type: "ws-data", data: data.toString() });
      }
    });

    ws.on("close", (code) => {
      localWsMap.delete(msg.reqId);
      sendJson({ reqId: msg.reqId, type: "ws-close", code });
    });

    ws.on("error", (e) => {
      localWsMap.delete(msg.reqId);
      sendJson({ reqId: msg.reqId, type: "ws-error", error: e.message });
    });
  } catch (e) {
    sendJson({ reqId: msg.reqId, type: "ws-error", error: e.message });
  }
}

// ============ 启动 ============

async function main() {
  await register();
  connect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
