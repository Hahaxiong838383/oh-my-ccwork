/**
 * cc-remote-v2 Relay Tunnel Client
 *
 * 将 cc-remote-v2 (localhost:7681) 通过 Relay Server 暴露到公网
 * 用法: RELAY_URL=https://relay.hahaxiong.cc node tunnel-client.js
 */

const WebSocket = require("ws");
const http = require("http");

const RELAY_URL = process.env.RELAY_URL || "https://relay.hahaxiong.cc";
const LOCAL_PORT = parseInt(process.env.PORT || "7681");
const DEVICE_ID = process.env.DEVICE_ID || "cc-remote-v2";

let token = null;
let tunnelWs = null;
let heartbeatTimer = null;
const localWsMap = new Map(); // reqId → local WebSocket

async function register() {
  const pairCode = Math.random().toString(36).slice(2, 8).toUpperCase();
  const res = await fetch(`${RELAY_URL}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: DEVICE_ID, pairCode }),
  });
  const data = await res.json();
  token = data.token;
  console.log(`[Tunnel] 注册${data.isNewDevice ? "（新设备）" : ""} token=${token.slice(0, 8)}...`);
}

function connect() {
  const wsUrl = RELAY_URL.replace(/^http/, "ws") + `/tunnel?token=${token}`;
  console.log(`[Tunnel] 连接 ${wsUrl.replace(token, token.slice(0, 8) + "...")}`);

  tunnelWs = new WebSocket(wsUrl);

  tunnelWs.on("open", () => {
    console.log(`[Tunnel] 已连接`);
    console.log(`[Tunnel] 代理地址: ${RELAY_URL}/api/${token}`);
    heartbeatTimer = setInterval(() => {
      if (tunnelWs.readyState === WebSocket.OPEN) {
        tunnelWs.send(JSON.stringify({ type: "heartbeat" }));
      }
    }, 25000);
  });

  tunnelWs.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "heartbeat-ack") return;
      if (msg.type === "http-request") handleHttp(msg);
      else if (msg.type === "ws-open") handleWsOpen(msg);
      else if (msg.type === "ws-data") {
        const ws = localWsMap.get(msg.reqId);
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(msg.data);
      } else if (msg.type === "ws-close") {
        const ws = localWsMap.get(msg.reqId);
        if (ws) { try { ws.close(msg.code || 1000); } catch {} localWsMap.delete(msg.reqId); }
      }
    } catch (e) { console.error("[Tunnel] 解析错误:", e.message); }
  });

  tunnelWs.on("close", () => {
    console.log("[Tunnel] 断开，5s 后重连...");
    clearInterval(heartbeatTimer);
    localWsMap.forEach(ws => { try { ws.close(); } catch {} });
    localWsMap.clear();
    setTimeout(connect, 5000);
  });

  tunnelWs.on("error", (e) => console.error("[Tunnel] 错误:", e.message));
}

function send(msg) {
  if (tunnelWs && tunnelWs.readyState === WebSocket.OPEN) {
    tunnelWs.send(JSON.stringify(msg));
  }
}

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
      send({ reqId: msg.reqId, type: "sse-start", status: res.status, headers: Object.fromEntries(res.headers.entries()) });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        send({ reqId: msg.reqId, type: "sse", data: dec.decode(value, { stream: true }) });
      }
      send({ reqId: msg.reqId, type: "sse-end" });
    } else {
      send({ reqId: msg.reqId, type: "http-response", status: res.status, headers: Object.fromEntries(res.headers.entries()), body: await res.text() });
    }
  } catch (e) {
    send({ reqId: msg.reqId, type: "http-error", error: e.message });
  }
}

function handleWsOpen(msg) {
  try {
    const ws = new WebSocket(`ws://localhost:${LOCAL_PORT}${msg.path}`);
    ws.on("open", () => { localWsMap.set(msg.reqId, ws); send({ reqId: msg.reqId, type: "ws-opened" }); });
    ws.on("message", (data) => send({ reqId: msg.reqId, type: "ws-data", data: data.toString() }));
    ws.on("close", (code) => { localWsMap.delete(msg.reqId); send({ reqId: msg.reqId, type: "ws-close", code }); });
    ws.on("error", (e) => { localWsMap.delete(msg.reqId); send({ reqId: msg.reqId, type: "ws-error", error: e.message }); });
  } catch (e) { send({ reqId: msg.reqId, type: "ws-error", error: e.message }); }
}

async function main() {
  await register();
  connect();
}

main().catch(e => { console.error(e); process.exit(1); });
