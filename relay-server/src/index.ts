/**
 * MyCC Relay Server v3
 *
 * 部署在腾讯云 ECS，作为用户电脑和手机/网页之间的中继服务器。
 * 核心链路：手机 ← HTTPS → Nginx → Relay Server ← WS 隧道 → 用户电脑
 *
 * V3 优化：
 *   - 终端数据走 Binary 帧直传（不解包不封装，零拷贝透传）
 *   - 控制消息（HTTP 代理、SSE、心跳、WS 建连/关闭）走 JSON
 *   - 向下兼容 V2 JSON-only 客户端
 *
 * 接口：
 *   POST /register          设备注册
 *   GET  /info/:token        设备查询
 *   WS   /tunnel?token=xxx   隧道连接
 *   ALL  /api/:token/*       HTTP 代理（含 SSE 透传）
 *   WS   /ws/:token/*        WS 代理（终端等）
 *   GET  /health             健康检查
 *   GET  /admin/devices      管理面板
 */

import http from "http";
import crypto from "crypto";
import { WebSocketServer, WebSocket } from "ws";

// ============ 配置 ============

const PORT = parseInt(process.env.PORT || "3000");
const HEARTBEAT_TIMEOUT = 60_000;   // 60s 无心跳 → offline
const REQUEST_TIMEOUT = 120_000;    // 120s HTTP 请求超时（SSE 流可能很长）
const WS_OPEN_TIMEOUT = 10_000;     // 10s WS 建连超时

// ============ 类型 ============

interface Device {
  deviceId: string;
  pairCode: string;
  secret?: string;
  token: string;
  tunnelWs: WebSocket | null;
  online: boolean;
  lastHeartbeat: number;
  createdAt: number;
}

interface PendingHttp {
  kind: "http";
  res: http.ServerResponse;
  timer: NodeJS.Timeout;
}

interface PendingWs {
  kind: "ws";
  clientWs: WebSocket;
  timer?: NodeJS.Timeout;
}

type PendingRequest = PendingHttp | PendingWs;

// ============ 状态 ============

const devices = new Map<string, Device>();           // token → Device
const pendingRequests = new Map<string, PendingRequest>(); // reqId → Pending

// ============ 工具函数 ============

const generateToken = () => crypto.randomBytes(16).toString("hex");
const generateReqId = () => crypto.randomBytes(16).toString("hex"); // 16 bytes = 32 hex chars, 匹配 V3 protocol REQ_ID_LEN
const ts = () => new Date().toLocaleString("zh-CN", { hour12: false });

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function jsonResponse(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function findDeviceByToken(token: string): Device | undefined {
  return devices.get(token);
}

// ============ HTTP 路由 ============

const server = http.createServer(async (req, res) => {
  const rawUrl = req.url || "/";
  const qIdx = rawUrl.indexOf("?");
  const pathname = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl;

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // POST /register
  if (pathname === "/register" && req.method === "POST") {
    return handleRegister(req, res);
  }

  // GET /health
  if (pathname === "/health") {
    return handleHealth(res);
  }

  // GET /admin/devices
  if (pathname === "/admin/devices") {
    return handleAdmin(res);
  }

  // GET /info/:token
  const infoMatch = pathname.match(/^\/info\/([^/]+)$/);
  if (infoMatch) {
    return handleInfo(infoMatch[1], res);
  }

  // ALL /api/:token/*  — HTTP 代理
  const apiMatch = pathname.match(/^\/api\/([^/]+)(\/.*)?$/);
  if (apiMatch) {
    const token = apiMatch[1];
    const forwardPath = (apiMatch[2] || "/") + (qIdx >= 0 ? rawUrl.slice(qIdx) : "");
    return handleHttpProxy(req, res, token, forwardPath);
  }

  jsonResponse(res, 404, { error: "Not Found" });
});

// ============ WebSocket 升级 ============

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const rawUrl = req.url || "/";
  const qIdx = rawUrl.indexOf("?");
  const pathname = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl;
  const searchParams = new URLSearchParams(qIdx >= 0 ? rawUrl.slice(qIdx + 1) : "");

  // WS /tunnel?token=xxx
  if (pathname === "/tunnel") {
    const token = searchParams.get("token");
    if (!token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleTunnelConnection(ws, token));
    return;
  }

  // WS /ws/:token/*
  const wsMatch = pathname.match(/^\/ws\/([^/]+)(\/.*)?$/);
  if (wsMatch) {
    const token = wsMatch[1];
    const path = (wsMatch[2] || "/") + (qIdx >= 0 ? rawUrl.slice(qIdx) : "");
    wss.handleUpgrade(req, socket, head, (ws) => handleWsProxy(ws, token, path));
    return;
  }

  // WS /api/:token/* — 终端页面通过 /api/ 路径发起 WS 连接（与 HTTP 代理同路径）
  const apiWsMatch = pathname.match(/^\/api\/([^/]+)(\/.*)?$/);
  if (apiWsMatch) {
    const token = apiWsMatch[1];
    const path = (apiWsMatch[2] || "/") + (qIdx >= 0 ? rawUrl.slice(qIdx) : "");
    wss.handleUpgrade(req, socket, head, (ws) => handleWsProxy(ws, token, path));
    return;
  }

  socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
  socket.destroy();
});

// ============ 注册 ============

async function handleRegister(req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    const body = await readBody(req);
    const { deviceId, pairCode, secret } = JSON.parse(body);

    if (!deviceId || !pairCode) {
      return jsonResponse(res, 400, { error: "deviceId and pairCode required" });
    }

    // 已注册的设备：更新 pairCode
    for (const [token, device] of devices) {
      if (device.deviceId === deviceId) {
        device.pairCode = pairCode;
        if (secret) device.secret = secret;
        console.log(`[Register] ${ts()} 设备 ${deviceId} 重新注册 (token=${token.slice(0, 8)}...)`);
        return jsonResponse(res, 200, { token, isNewDevice: false });
      }
    }

    // 新设备
    const token = generateToken();
    devices.set(token, {
      deviceId,
      pairCode,
      secret,
      token,
      tunnelWs: null,
      online: false,
      lastHeartbeat: 0,
      createdAt: Date.now(),
    });

    console.log(`[Register] ${ts()} 新设备 ${deviceId} 注册成功 (token=${token.slice(0, 8)}...)`);
    return jsonResponse(res, 200, { token, isNewDevice: true });
  } catch {
    return jsonResponse(res, 400, { error: "Invalid request body" });
  }
}

// ============ 查询 ============

function handleInfo(token: string, res: http.ServerResponse) {
  const device = findDeviceByToken(token);
  if (!device) return jsonResponse(res, 404, { error: "Device not found" });

  jsonResponse(res, 200, {
    deviceId: device.deviceId,
    online: device.online,
    lastHeartbeat: device.lastHeartbeat,
  });
}

function handleHealth(res: http.ServerResponse) {
  const onlineCount = [...devices.values()].filter((d) => d.online).length;
  jsonResponse(res, 200, { status: "ok", onlineDevices: onlineCount, totalDevices: devices.size });
}

function handleAdmin(res: http.ServerResponse) {
  const list = [...devices.values()].map((d) => ({
    deviceId: d.deviceId,
    token: d.token.slice(0, 8) + "...",
    online: d.online,
    lastHeartbeat: d.lastHeartbeat ? new Date(d.lastHeartbeat).toISOString() : null,
    createdAt: new Date(d.createdAt).toISOString(),
  }));
  jsonResponse(res, 200, { devices: list });
}

// ============ 隧道连接 ============

function handleTunnelConnection(ws: WebSocket, token: string) {
  const device = findDeviceByToken(token);
  if (!device) {
    ws.close(4001, "Invalid token");
    return;
  }

  // 关闭旧连接
  if (device.tunnelWs && device.tunnelWs.readyState === WebSocket.OPEN) {
    console.log(`[Tunnel] ${ts()} 设备 ${device.deviceId} 旧连接被替换`);
    try { device.tunnelWs.close(4000, "Replaced by new connection"); } catch {}
  }

  device.tunnelWs = ws;
  device.online = true;
  device.lastHeartbeat = Date.now();
  console.log(`[Tunnel] ${ts()} 设备 ${device.deviceId} 已连接`);

  ws.on("message", (raw, isBinary) => {
    if (isBinary) {
      // ===== V3 ttyd: 透明 Binary 代理 =====
      // 格式: [16 bytes reqId][payload] → 提取 reqId 路由，payload 直发浏览器
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
      if (buf.length < 16) return;

      const reqId = buf.slice(0, 16).toString("hex");
      const payload = buf.slice(16);
      const pending = pendingRequests.get(reqId);
      if (pending && pending.kind === "ws" && pending.clientWs.readyState === WebSocket.OPEN) {
        pending.clientWs.send(payload); // 原始 payload 直发浏览器
      }
      return;
    }

    // ===== JSON 控制消息（V2 兼容 + 心跳 + HTTP 代理） =====
    try {
      const msg = JSON.parse(raw.toString());

      // 心跳
      if (msg.type === "heartbeat") {
        device.lastHeartbeat = Date.now();
        device.online = true;
        ws.send(JSON.stringify({ type: "heartbeat-ack" }));
        return;
      }

      // 路由到 pending request
      if (!msg.reqId) return;
      const pending = pendingRequests.get(msg.reqId);
      if (!pending) return;

      if (pending.kind === "http") {
        handleTunnelHttpResponse(msg, pending);
      } else if (pending.kind === "ws") {
        handleTunnelWsResponse(msg, pending);
      }
    } catch (err) {
      console.error(`[Tunnel] ${ts()} 消息解析错误:`, err);
    }
  });

  ws.on("close", () => {
    device.tunnelWs = null;
    device.online = false;
    console.log(`[Tunnel] ${ts()} 设备 ${device.deviceId} 断开`);

    // 清理该设备所有 pending 请求
    for (const [reqId, pending] of pendingRequests) {
      if (pending.kind === "http") {
        clearTimeout(pending.timer);
        if (!pending.res.headersSent) {
          jsonResponse(pending.res, 502, { error: "Device disconnected" });
        } else {
          pending.res.end();
        }
      } else if (pending.kind === "ws") {
        if (pending.timer) clearTimeout(pending.timer);
        try { pending.clientWs.close(1001, "Device disconnected"); } catch {}
      }
      pendingRequests.delete(reqId);
    }
  });

  ws.on("error", (err) => {
    console.error(`[Tunnel] ${ts()} 设备 ${device.deviceId} 错误: ${err.message}`);
  });
}

// ============ HTTP 代理 ============

function handleHttpProxy(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  token: string,
  path: string,
) {
  const device = findDeviceByToken(token);
  if (!device) return jsonResponse(res, 404, { error: "Device not found" });

  if (!device.online || !device.tunnelWs || device.tunnelWs.readyState !== WebSocket.OPEN) {
    return jsonResponse(res, 502, { error: "Device offline" });
  }

  const reqId = generateReqId();
  const chunks: Buffer[] = [];

  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString();

    // 超时定时器
    const timer = setTimeout(() => {
      pendingRequests.delete(reqId);
      if (!res.headersSent) {
        jsonResponse(res, 504, { error: "Gateway timeout" });
      } else {
        res.end();
      }
    }, REQUEST_TIMEOUT);

    pendingRequests.set(reqId, { kind: "http", res, timer });

    // 构建转发消息
    const headers = { ...req.headers } as Record<string, string | string[] | undefined>;
    // 移除 hop-by-hop 头
    delete headers["host"];
    delete headers["connection"];
    delete headers["upgrade"];
    delete headers["transfer-encoding"];

    const tunnelMsg = {
      reqId,
      type: "http-request",
      method: req.method,
      path,
      headers,
      body: body || undefined,
    };

    device.tunnelWs!.send(JSON.stringify(tunnelMsg));
  });
}

// 处理来自隧道的 HTTP 响应
function handleTunnelHttpResponse(msg: Record<string, unknown>, pending: PendingHttp) {
  const { res, timer } = pending;

  switch (msg.type) {
    case "http-response": {
      clearTimeout(timer);
      pendingRequests.delete(msg.reqId as string);
      const headers = (msg.headers || {}) as Record<string, string>;
      delete headers["transfer-encoding"];
      res.writeHead((msg.status as number) || 200, headers);
      res.end((msg.body as string) || "");
      break;
    }

    case "sse-start": {
      const rawHeaders = (msg.headers || {}) as Record<string, string>;
      const headers: Record<string, string> = {
        ...rawHeaders,
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",  // 告诉 Nginx 不要缓冲
      };
      delete headers["transfer-encoding"];
      res.writeHead((msg.status as number) || 200, headers);
      break;
    }

    case "sse": {
      // SSE chunk — 立即写入，不缓冲（核心体验）
      res.write(msg.data as string);
      break;
    }

    case "sse-end": {
      clearTimeout(timer);
      pendingRequests.delete(msg.reqId as string);
      res.end();
      break;
    }

    case "http-error": {
      clearTimeout(timer);
      pendingRequests.delete(msg.reqId as string);
      if (!res.headersSent) {
        jsonResponse(res, 502, { error: (msg.error as string) || "Proxy error" });
      } else {
        res.end();
      }
      break;
    }
  }
}

// ============ WS 代理 ============

function handleWsProxy(clientWs: WebSocket, token: string, path: string) {
  const device = findDeviceByToken(token);
  if (!device || !device.online || !device.tunnelWs || device.tunnelWs.readyState !== WebSocket.OPEN) {
    console.log(`[WsProxy] ${ts()} 设备 ${token.slice(0, 8)}... 离线，拒绝 WS`);
    clientWs.close(4002, "Device offline");
    return;
  }

  const reqId = generateReqId();
  console.log(`[WsProxy] ${ts()} 新连接 reqId=${reqId} path=${path} device=${device.deviceId}`);

  // WS 建连超时
  const timer = setTimeout(() => {
    console.log(`[WsProxy] ${ts()} 超时 reqId=${reqId}`);
    pendingRequests.delete(reqId);
    clientWs.close(4003, "WS open timeout");
  }, WS_OPEN_TIMEOUT);

  pendingRequests.set(reqId, { kind: "ws", clientWs, timer });

  // 通知设备打开 WS
  device.tunnelWs.send(JSON.stringify({ reqId, type: "ws-open", path }));

  // 客户端 → 隧道（V3: Binary 直传 + V2 JSON 兼容）
  clientWs.on("message", (data, isBinary) => {
    if (!device.tunnelWs || device.tunnelWs.readyState !== WebSocket.OPEN) return;

    if (isBinary) {
      // V3 ttyd: 浏览器原始 binary → prepend [16B reqId] → 转发给设备
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      const reqIdBuf = Buffer.from(reqId, "hex");
      const full = Buffer.allocUnsafe(16 + buf.length);
      reqIdBuf.copy(full, 0);
      buf.copy(full, 16);
      device.tunnelWs.send(full);
    } else {
      // V2 兼容：JSON 封装的终端数据
      const preview = data.toString().slice(0, 100);
      console.log(`[WsProxy] ${ts()} 浏览器→设备 reqId=${reqId} data=${preview}`);
      device.tunnelWs.send(JSON.stringify({
        reqId,
        type: "ws-data",
        data: data.toString(),
      }));
    }
  });

  // 客户端断开 → 通知设备
  clientWs.on("close", (code, reason) => {
    console.log(`[WsProxy] ${ts()} 浏览器断开 reqId=${reqId} code=${code}`);
    pendingRequests.delete(reqId);
    if (device.tunnelWs && device.tunnelWs.readyState === WebSocket.OPEN) {
      device.tunnelWs.send(JSON.stringify({
        reqId,
        type: "ws-close",
        code,
        reason: reason?.toString() || "",
      }));
    }
  });

  clientWs.on("error", (err) => {
    console.log(`[WsProxy] ${ts()} 浏览器错误 reqId=${reqId} err=${err.message}`);
    pendingRequests.delete(reqId);
  });
}

// 处理来自隧道的 WS 响应
function handleTunnelWsResponse(msg: Record<string, unknown>, pending: PendingWs) {
  const { clientWs, timer } = pending;

  switch (msg.type) {
    case "ws-opened": {
      console.log(`[WsProxy] ${ts()} 设备确认 WS 打开 reqId=${msg.reqId}`);
      if (timer) clearTimeout(timer);
      break;
    }

    case "ws-data": {
      // V2 兼容：JSON 封装的终端数据（V3 走 Binary 帧不经过这里）
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(msg.data as string);
      }
      break;
    }

    case "ws-close": {
      if (timer) clearTimeout(timer);
      pendingRequests.delete(msg.reqId as string);
      if (clientWs.readyState === WebSocket.OPEN) {
        const closeCode = typeof msg.code === "number" && msg.code >= 1000 ? msg.code : 1000;
        clientWs.close(closeCode as number, (msg.reason as string) || "");
      }
      break;
    }

    case "ws-error": {
      if (timer) clearTimeout(timer);
      pendingRequests.delete(msg.reqId as string);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.close(4004, (msg.error as string) || "WS proxy error");
      }
      break;
    }
  }
}

// ============ 心跳检测 — 标记离线 ============

setInterval(() => {
  const now = Date.now();
  for (const device of devices.values()) {
    if (device.online && device.lastHeartbeat > 0 && now - device.lastHeartbeat > HEARTBEAT_TIMEOUT) {
      device.online = false;
      console.log(`[Heartbeat] ${ts()} 设备 ${device.deviceId} 超时离线`);
    }
  }
}, 30_000);

// ============ 启动 ============

server.listen(PORT, () => {
  console.log(`[Relay] ${ts()} 服务启动 port=${PORT}`);
  console.log(`[Relay] 接口: POST /register | WS /tunnel | ALL /api/:token/* | WS /ws/:token/*`);
});
