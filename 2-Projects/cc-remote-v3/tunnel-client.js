/**
 * cc-remote v3 — Relay Tunnel Client (ttyd edition)
 *
 * 透明代理：ttyd 的 HTTP + WS 流量通过 Relay 中转到公网。
 * Binary WS 数据用 [16 bytes reqId][payload] 前缀路由，无自定义协议。
 *
 * 用法: RELAY_URL=https://relay.hahaxiong.cc DEVICE_ID=mac-mini node tunnel-client.js
 */

const WebSocket = require("ws");

const RELAY_URL = process.env.RELAY_URL || "https://relay.hahaxiong.cc";
const LOCAL_PORT = parseInt(process.env.PORT || "7681");
const DEVICE_ID = process.env.DEVICE_ID || `cc-v3-${require("os").hostname()}`;
const REQ_ID_LEN = 16; // bytes

let token = null;
let tunnelWs = null;
let heartbeatTimer = null;
const localWsMap = new Map(); // reqId(hex) → local WebSocket

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
  console.log(`[Tunnel] 注册${data.isNewDevice ? "（新设备）" : ""} device=${DEVICE_ID}`);
  console.log(`[Tunnel] 公网地址: ${RELAY_URL}/api/${token}/`);
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
      // Binary: [16 bytes reqId][payload] → strip reqId → forward payload to local WS
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      if (buf.length < REQ_ID_LEN) return;
      const reqId = buf.slice(0, REQ_ID_LEN).toString("hex");
      const payload = buf.slice(REQ_ID_LEN);
      const ws = localWsMap.get(reqId);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    } else {
      handleJson(raw);
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

function handleJson(raw) {
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
        // V2 兼容：JSON 封装的文本 WS 数据
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
    console.error("[Tunnel] JSON 错误:", e.message);
  }
}

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
      let body = await res.text();
      const ct = res.headers.get("content-type") || "";

      // ttyd HTML 注入 <base> 标签：让资源和 WS 路径正确解析到 /api/TOKEN/ 下
      if (ct.includes("text/html") && token) {
        const basePath = `/api/${token}/`;
        body = body.replace("<head>", `<head><base href="${basePath}">`);
      }

      sendJson({ reqId: msg.reqId, type: "http-response", status: res.status, headers: Object.fromEntries(res.headers.entries()), body });
    }
  } catch (e) {
    sendJson({ reqId: msg.reqId, type: "http-error", error: e.message });
  }
}

// ============ WS 代理（透明 Binary 转发）============

function handleWsOpen(msg) {
  try {
    const ws = new WebSocket(`ws://localhost:${LOCAL_PORT}${msg.path}`);

    ws.on("open", () => {
      localWsMap.set(msg.reqId, ws);
      sendJson({ reqId: msg.reqId, type: "ws-opened" });
    });

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        // ttyd binary → prepend [reqId] → send to relay
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        const reqIdBuf = Buffer.from(msg.reqId, "hex");
        const full = Buffer.allocUnsafe(REQ_ID_LEN + buf.length);
        reqIdBuf.copy(full, 0);
        buf.copy(full, REQ_ID_LEN);
        sendBinary(full);
      } else {
        // Text WS data → JSON wrap
        sendJson({ reqId: msg.reqId, type: "ws-data", data: data.toString() });
      }
    });

    ws.on("close", (code) => {
      localWsMap.delete(msg.reqId);
      sendJson({ reqId: msg.reqId, type: "ws-close", code: typeof code === "number" ? code : 1000 });
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
