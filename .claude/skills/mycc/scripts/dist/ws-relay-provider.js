/**
 * WebSocket Relay Provider
 *
 * 替代 CloudflareProvider，通过 WebSocket 长连接到阿里云 Relay Server。
 * 实现 TunnelProvider 接口，可无缝替换。
 *
 * 工作原理：
 * 1. 连接到 Relay Server 的 /tunnel?token=xxx
 * 2. 收到 Relay 转发的 HTTP 请求
 * 3. 转发到本地 mycc HTTP server (localhost:PORT)
 * 4. 将响应（包括 SSE 流）回传给 Relay
 */
import WebSocket from "ws";
// ==================== 配置 ====================
const HEARTBEAT_INTERVAL = 25_000; // 25s（小于 Relay 的 30s 检测间隔）
const RECONNECT_DELAY = 3_000;
const MAX_RECONNECT_ATTEMPTS = 10;
// ==================== WsRelayProvider ====================
export class WsRelayProvider {
    ws = null;
    relayUrl;
    token;
    localPort = 0;
    heartbeatTimer = null;
    isConnected = false;
    isStopped = false;
    // 追踪正在进行的本地请求，以便 cancel 时中止
    activeRequests = new Map();
    /**
     * @param relayUrl Relay Server 地址，如 wss://relay.mycc.dev
     * @param token 设备 token（从 /register 获得）
     */
    constructor(relayUrl, token) {
        // HTTP(S) URL 转为 WS(S) URL
        this.relayUrl = relayUrl
            .replace(/^https:\/\//, "wss://")
            .replace(/^http:\/\//, "ws://");
        this.token = token;
    }
    async start(localPort) {
        this.localPort = localPort;
        this.isStopped = false;
        return new Promise((resolve, reject) => {
            const wsUrl = `${this.relayUrl}/tunnel?token=${this.token}`;
            console.log(`[WsRelay] 连接到 Relay: ${wsUrl.replace(this.token, this.token.slice(0, 8) + "...")}`);
            const ws = new WebSocket(wsUrl);
            this.ws = ws;
            const connectTimeout = setTimeout(() => {
                if (!this.isConnected) {
                    ws.close();
                    reject(new Error("WebSocket 连接超时"));
                }
            }, 30_000);
            ws.on("open", () => {
                clearTimeout(connectTimeout);
                this.isConnected = true;
                console.log("[WsRelay] ✓ 已连接到 Relay Server");
                // 启动心跳
                this.startHeartbeat();
                // 返回 relay 的代理 URL（手机通过这个 URL 访问）
                const proxyUrl = this.relayUrl
                    .replace(/^wss:\/\//, "https://")
                    .replace(/^ws:\/\//, "http://");
                resolve({ url: `${proxyUrl}/api/${this.token}` });
            });
            ws.on("message", (raw) => {
                this.handleMessage(raw.toString());
            });
            ws.on("close", (code, reason) => {
                this.isConnected = false;
                this.stopHeartbeat();
                if (!this.isStopped) {
                    console.log(`[WsRelay] 连接断开 (code=${code}, reason=${reason})`);
                }
            });
            ws.on("error", (err) => {
                if (!this.isConnected) {
                    clearTimeout(connectTimeout);
                    reject(new Error(`WebSocket 连接失败: ${err.message}`));
                }
                else {
                    console.error(`[WsRelay] 连接错误: ${err.message}`);
                }
            });
        });
    }
    stop() {
        this.isStopped = true;
        this.stopHeartbeat();
        // 中止所有进行中的请求
        for (const [reqId, controller] of this.activeRequests) {
            controller.abort();
        }
        this.activeRequests.clear();
        if (this.ws) {
            try {
                this.ws.close(1000, "provider_stopped");
            }
            catch { }
            this.ws = null;
        }
        this.isConnected = false;
    }
    async healthCheck() {
        return this.isConnected && this.ws?.readyState === WebSocket.OPEN;
    }
    getName() {
        return "ws-relay";
    }
    // ==================== 私有方法 ====================
    startHeartbeat() {
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ type: "heartbeat" }));
            }
        }, HEARTBEAT_INTERVAL);
    }
    stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }
    /**
     * 处理 Relay 转发过来的请求
     */
    async handleMessage(raw) {
        let msg;
        try {
            msg = JSON.parse(raw);
        }
        catch {
            return;
        }
        // 心跳响应
        if ("type" in msg && msg.type === "heartbeat-ack") {
            return;
        }
        // 取消请求
        if ("type" in msg && msg.type === "cancel") {
            const cancelMsg = msg;
            const controller = this.activeRequests.get(cancelMsg.reqId);
            if (controller) {
                controller.abort();
                this.activeRequests.delete(cancelMsg.reqId);
            }
            return;
        }
        // 正常的隧道请求
        const req = msg;
        if (!req.reqId || !req.method || !req.path)
            return;
        const controller = new AbortController();
        this.activeRequests.set(req.reqId, controller);
        try {
            await this.forwardToLocal(req, controller.signal);
        }
        catch (err) {
            if (err.name === "AbortError") {
                // 请求被取消，不发错误
                return;
            }
            // 发送错误响应
            this.sendToRelay({
                reqId: req.reqId,
                type: "error",
                body: `本地转发失败: ${err.message}`,
            });
        }
        finally {
            this.activeRequests.delete(req.reqId);
        }
    }
    /**
     * 转发请求到本地 mycc HTTP server
     */
    async forwardToLocal(req, signal) {
        const localUrl = `http://localhost:${this.localPort}${req.path}`;
        const fetchOptions = {
            method: req.method,
            headers: req.headers,
            signal,
        };
        if (req.body && req.method !== "GET" && req.method !== "HEAD") {
            fetchOptions.body = req.body;
        }
        const response = await fetch(localUrl, fetchOptions);
        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("text/event-stream")) {
            // SSE 流：逐块回传
            if (!response.body) {
                this.sendToRelay({ reqId: req.reqId, type: "sse-end" });
                return;
            }
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done)
                        break;
                    const chunk = decoder.decode(value, { stream: true });
                    this.sendToRelay({
                        reqId: req.reqId,
                        type: "sse",
                        data: chunk,
                    });
                }
            }
            finally {
                reader.releaseLock();
            }
            this.sendToRelay({ reqId: req.reqId, type: "sse-end" });
        }
        else {
            // 普通响应：一次性回传
            const body = await response.text();
            const headers = {};
            response.headers.forEach((v, k) => {
                headers[k] = v;
            });
            this.sendToRelay({
                reqId: req.reqId,
                type: "response",
                status: response.status,
                headers,
                body,
            });
        }
    }
    sendToRelay(msg) {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(msg));
        }
    }
}
//# sourceMappingURL=ws-relay-provider.js.map