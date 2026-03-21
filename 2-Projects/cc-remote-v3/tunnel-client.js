/**
 * cc-remote v3 — Relay Tunnel Client (Layered Binary Protocol)
 *
 * Relay ↔ Tunnel 之间用完整帧 [opcode][reqId][payload]
 * Tunnel ↔ Local Server 之间用简单帧 [opcode][payload]
 * Tunnel 在边界做 reqId 插入/剥离。
 */

const WebSocket = require("ws");
const { insertReqId, stripReqId } = require("./protocol");

const RELAY_URL = process.env.RELAY_URL || "https://relay.hahaxiong.cc";
const LOCAL_PORT = parseInt(process.env.PORT || "7681");
const DEVICE_ID = process.env.DEVICE_ID || `cc-v3-${require("os").hostname()}`;

let token = null;
let tunnelWs = null;
let heartbeatTimer = null;
const localWsMap = new Map(); // reqId → local WebSocket

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
  tunnelWs = new WebSocket(wsUrl);

  tunnelWs.on("open", () => {
    console.log(`[Tunnel] 已连接 Relay`);
    heartbeatTimer = setInterval(() => {
      if (tunnelWs.readyState === WebSocket.OPEN) {
        tunnelWs.send(JSON.stringify({ type: "heartbeat" }));
      }
    }, 25000);
  });

  tunnelWs.on("message", (raw, isBinary) => {
    if (isBinary) {
      // 完整帧 [opcode][reqId][payload] → 剥离 reqId → 简单帧转发到本地
      const { reqId, simple } = stripReqId(raw);
      const ws = localWsMap.get(reqId);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(simple);
      }
    } else {
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

// ============ JSON 控制消息 ============

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
        const ws = localWsMap.get(msg.reqId);
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(msg.data);
        break;
      }
      case "ws-close": {
        const ws = localWsMap.get(msg.reqId);
        if (ws) { try { ws.close(msg.code || 1000); } catch {} localWsMap.delete(msg.reqId); }
        break;
      }
    }
  } catch (e) {
    console.error("[Tunnel] JSON 解析错误:", e.message);
  }
}

// ============ 发送 ============

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

// ============ HTTP 代理 ============

async function handleHttp(msg) {
  try {
    const headers = { ...(msg.headers || {}) };
    delete headers["host"]; delete headers["connection"]; delete headers["transfer-encoding"];

    const res = await fetch(`http://localhost:${LOCAL_PORT}${msg.path}`, {
      method: msg.method,
      headers,
      body: msg.method !== "GET" && msg.method !== "HEAD" ? msg.body : undefined,
    });

    const ct = res.headers.get("content-type") || "";
    if (ct.includes("text/event-stream")) {
      sendJson({ reqId: msg.reqId, type: "sse-start", status: res.status, headers: Object.fromEntries(res.headers.entries()) });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sendJson({ reqId: msg.reqId, type: "sse", data: dec.decode(value, { stream: true }) });
      }
      sendJson({ reqId: msg.reqId, type: "sse-end" });
    } else {
      sendJson({ reqId: msg.reqId, type: "http-response", status: res.status, headers: Object.fromEntries(res.headers.entries()), body: await res.text() });
    }
  } catch (e) {
    sendJson({ reqId: msg.reqId, type: "http-error", error: e.message });
  }
}

// ============ WS 代理（边界 reqId 插入/剥离）============

function handleWsOpen(msg) {
  try {
    const localUrl = `ws://localhost:${LOCAL_PORT}${msg.path}`;
    const ws = new WebSocket(localUrl);

    ws.on("open", () => {
      localWsMap.set(msg.reqId, ws);
      sendJson({ reqId: msg.reqId, type: "ws-opened" });
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        // 本地 Server 发来简单帧 [opcode][payload]
        // 插入 reqId → 完整帧 [opcode][reqId][payload] → 发给 Relay
        const fullFrame = insertReqId(data, msg.reqId);
        sendBinary(fullFrame);
      } else {
        // JSON 控制消息
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

main().catch((e) => { console.error(e); process.exit(1); });
