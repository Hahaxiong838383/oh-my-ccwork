/**
 * Tunnel Provider 接口抽象
 *
 * 支持的隧道方案：
 * - CloudflareProvider: Quick Tunnel（随机 URL，无需配置）
 * - NamedCloudflareProvider: Named Tunnel（固定域名，解决 CNAME Cross-User Banned）
 * - WsRelayProvider: 自建 Relay Server（固定 URL，国内低延迟）
 */
import { spawn, execSync } from "child_process";
import { detectCloudflaredPath, NULL_DEVICE } from "./platform.js";
import WebSocket from "ws";
const isWindows = process.platform === "win32";
// ============ CloudflareProvider 实现 ============
export class CloudflareProvider {
    proc = null;
    tunnelUrl = null;
    startTimeout;
    localPort = 0;
    /**
     * @param startTimeout 启动超时时间（毫秒），默认 60 秒
     * cloudflared 连接 Cloudflare Edge 可能需要较长时间，特别是网络不稳定时
     */
    constructor(startTimeout = 60000) {
        this.startTimeout = startTimeout;
    }
    async start(localPort) {
        this.localPort = localPort; // 保存端口号用于后续清理
        return new Promise((resolve, reject) => {
            // 获取 cloudflared 路径
            const cloudflaredPath = detectCloudflaredPath();
            const proc = spawn(cloudflaredPath, [
                'tunnel',
                '--config', NULL_DEVICE,
                '--url', `http://localhost:${localPort}`
            ], {
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
            });
            this.proc = proc;
            let resolved = false;
            // quick tunnel URL 格式: word1-word2-word3-word4.trycloudflare.com
            // 必须包含至少一个连字符，排除 api.trycloudflare.com 等系统域名
            const urlPattern = /https:\/\/[a-z0-9]+-[a-z0-9-]+\.trycloudflare\.com/;
            const handleOutput = (data) => {
                const output = data.toString();
                const match = output.match(urlPattern);
                if (match && !resolved) {
                    resolved = true;
                    this.tunnelUrl = match[0];
                    resolve({ url: match[0], proc });
                }
            };
            proc.stdout?.on("data", handleOutput);
            proc.stderr?.on("data", handleOutput);
            proc.on("error", (err) => {
                if (!resolved) {
                    resolved = true;
                    this.proc = null;
                    reject(new Error(`Tunnel 启动失败: ${err.message}`));
                }
            });
            setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    // 超时，杀掉进程
                    try {
                        proc.kill();
                    }
                    catch { }
                    this.proc = null;
                    reject(new Error("Tunnel 启动超时"));
                }
            }, this.startTimeout);
        });
    }
    stop() {
        if (this.proc) {
            try {
                // 直接强杀，不搞优雅那套
                this.proc.kill("SIGKILL");
            }
            catch { }
            this.proc = null;
        }
        // 杀掉所有 cloudflared 子进程（shell spawn 可能留下孤儿）
        // 注意：killPortProcess 杀的是 HTTP Server，不是 cloudflared！
        // cloudflared 不占用 localPort，它只是转发到 localhost:localPort
        try {
            if (isWindows) {
                // Windows: 按进程名杀
                execSync('taskkill /F /IM cloudflared.exe 2>nul', { stdio: 'ignore' });
            }
            else {
                // Unix: 按命令行模式匹配杀
                execSync("pkill -9 -f 'cloudflared tunnel' 2>/dev/null || true", { stdio: 'ignore' });
            }
        }
        catch {
            // 静默处理失败
        }
        this.tunnelUrl = null;
        this.localPort = 0;
    }
    async healthCheck() {
        if (!this.tunnelUrl) {
            return false;
        }
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000);
            const response = await fetch(`${this.tunnelUrl}/health`, {
                signal: controller.signal,
            });
            clearTimeout(timeoutId);
            return response.ok;
        }
        catch {
            return false;
        }
    }
    getName() {
        return "cloudflare";
    }
    /**
     * 获取当前隧道 URL
     */
    getUrl() {
        return this.tunnelUrl;
    }
    /**
     * 获取进程引用（用于外部监控）
     */
    getProc() {
        return this.proc;
    }
}
// ============ NamedCloudflareProvider 实现 ============
// 解决 Error 1014: CNAME Cross-User Banned
// Quick Tunnel 生成 *.trycloudflare.com URL，CNAME 过去被 Cloudflare 拦截
// Named Tunnel 使用 {uuid}.cfargotunnel.com，不触发此限制
export class NamedCloudflareProvider {
    proc = null;
    tunnelToken;
    tunnelId;
    tunnelUrl = null;
    hostname;
    startTimeout;
    /**
     * @param tunnelToken Cloudflare Tunnel Token（从 Dashboard 获取）
     * @param hostname 绑定的域名（如 cli.hahaxiong.top）
     * @param startTimeout 启动超时时间（毫秒），默认 120 秒
     */
    constructor(tunnelToken, hostname, startTimeout = 120000) {
        this.tunnelToken = tunnelToken;
        this.hostname = hostname;
        this.startTimeout = startTimeout;
        this.tunnelId = this.extractTunnelId(tunnelToken);
    }
    /**
     * 从 tunnel token 中提取 tunnel UUID
     * Token 格式：base64({"a":"account_tag","t":"tunnel_id","s":"tunnel_secret"})
     */
    extractTunnelId(token) {
        try {
            const decoded = JSON.parse(Buffer.from(token, "base64").toString());
            if (!decoded.t) {
                throw new Error("Token 中缺少 tunnel ID (字段 t)");
            }
            return decoded.t;
        }
        catch (err) {
            throw new Error(`无效的 tunnel token: ${err.message}`);
        }
    }
    /**
     * 获取 tunnel UUID（用于创建 CNAME 指向 {uuid}.cfargotunnel.com）
     */
    getTunnelId() {
        return this.tunnelId;
    }
    async start(localPort) {
        return new Promise((resolve, reject) => {
            const cloudflaredPath = detectCloudflaredPath();
            const proc = spawn(cloudflaredPath, [
                "tunnel", "run", "--token", this.tunnelToken,
            ], {
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
            });
            this.proc = proc;
            let resolved = false;
            // Named Tunnel 就绪标志：cloudflared 会在 stderr 输出连接注册信息
            const readyPattern = /Registered tunnel connection|Connection [a-z0-9-]+ registered/i;
            const handleOutput = (data) => {
                const output = data.toString();
                if (readyPattern.test(output) && !resolved) {
                    resolved = true;
                    this.tunnelUrl = `https://${this.hostname}`;
                    resolve({ url: this.tunnelUrl, proc });
                }
            };
            proc.stdout?.on("data", handleOutput);
            proc.stderr?.on("data", handleOutput);
            proc.on("error", (err) => {
                if (!resolved) {
                    resolved = true;
                    this.proc = null;
                    reject(new Error(`Named Tunnel 启动失败: ${err.message}`));
                }
            });
            setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    try {
                        proc.kill();
                    }
                    catch { }
                    this.proc = null;
                    reject(new Error("Named Tunnel 启动超时"));
                }
            }, this.startTimeout);
        });
    }
    stop() {
        if (this.proc) {
            try {
                this.proc.kill("SIGKILL");
            }
            catch { }
            this.proc = null;
        }
        try {
            if (isWindows) {
                execSync('taskkill /F /IM cloudflared.exe 2>nul', { stdio: "ignore" });
            }
            else {
                execSync("pkill -9 -f 'cloudflared tunnel' 2>/dev/null || true", { stdio: "ignore" });
            }
        }
        catch { }
        this.tunnelUrl = null;
    }
    async healthCheck() {
        if (!this.tunnelUrl)
            return false;
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000);
            const response = await fetch(`${this.tunnelUrl}/health`, {
                signal: controller.signal,
            });
            clearTimeout(timeoutId);
            return response.ok;
        }
        catch {
            return false;
        }
    }
    getName() {
        return "cloudflare-named";
    }
    getUrl() {
        return this.tunnelUrl;
    }
    getProc() {
        return this.proc;
    }
}
// ============ WsRelayProvider 实现 ============
// cc-remote V2：自建 Relay Server，告别 Cloudflare
// 优势：URL 固定、国内访问快、无外部二进制依赖、SSE 流式透传、WS 终端透传
export class WsRelayProvider {
    ws = null;
    relayUrl;
    deviceId;
    token = null;
    localPort = 0;
    heartbeatTimer = null;
    proxyUrl = null;
    // WS 代理：reqId → 本地 WebSocket（终端等场景）
    localWsMap = new Map();
    /**
     * @param relayUrl Relay Server 地址（如 https://relay.mycc.dev）
     * @param deviceId 设备 ID
     * @param token 已有的注册 token（可选，重启时复用）
     */
    constructor(relayUrl, deviceId, token) {
        this.relayUrl = relayUrl.replace(/\/$/, "");
        this.deviceId = deviceId;
        this.token = token || null;
    }
    async start(localPort) {
        this.localPort = localPort;
        // 1. 注册设备（或复用 token）
        if (!this.token) {
            await this.register();
        }
        // 2. 连接 WS 隧道
        const wsUrl = this.relayUrl.replace(/^http/, "ws") + `/tunnel?token=${this.token}`;
        console.log(`[WsRelay] 连接 Relay: ${wsUrl.replace(this.token, this.token.slice(0, 8) + "...")}`);
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(wsUrl);
            this.ws = ws;
            let resolved = false;
            ws.on("open", () => {
                if (resolved)
                    return;
                resolved = true;
                this.proxyUrl = `${this.relayUrl}/api/${this.token}`;
                this.startHeartbeat();
                console.log(`[WsRelay] 隧道已连接，代理 URL: ${this.proxyUrl}`);
                resolve({ url: this.proxyUrl });
            });
            ws.on("message", (raw) => {
                try {
                    const msg = JSON.parse(raw.toString());
                    this.handleTunnelMessage(msg);
                }
                catch (err) {
                    console.error("[WsRelay] 消息解析错误:", err);
                }
            });
            ws.on("close", (code, reason) => {
                console.log(`[WsRelay] 隧道断开: code=${code} reason=${reason?.toString() || ""}`);
                this.stopHeartbeat();
                this.cleanupLocalWs();
                if (!resolved) {
                    resolved = true;
                    reject(new Error(`Relay WS 断开: ${code}`));
                }
            });
            ws.on("error", (err) => {
                console.error("[WsRelay] 隧道错误:", err.message);
                if (!resolved) {
                    resolved = true;
                    reject(new Error(`Relay WS 连接失败: ${err.message}`));
                }
            });
            // 连接超时
            setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    try {
                        ws.close();
                    }
                    catch { }
                    reject(new Error("Relay WS 连接超时 (15s)"));
                }
            }, 15_000);
        });
    }
    stop() {
        this.stopHeartbeat();
        this.cleanupLocalWs();
        if (this.ws) {
            try {
                this.ws.close();
            }
            catch { }
            this.ws = null;
        }
        this.proxyUrl = null;
    }
    async healthCheck() {
        return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
    }
    getName() {
        return "ws-relay";
    }
    getUrl() {
        return this.proxyUrl;
    }
    getToken() {
        return this.token;
    }
    // ============ 私有方法 ============
    async register() {
        const pairCode = Math.random().toString(36).slice(2, 8).toUpperCase();
        const res = await fetch(`${this.relayUrl}/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ deviceId: this.deviceId, pairCode }),
        });
        if (!res.ok) {
            throw new Error(`注册失败: ${res.status} ${await res.text()}`);
        }
        const data = await res.json();
        this.token = data.token;
        console.log(`[WsRelay] 设备注册${data.isNewDevice ? "（新设备）" : ""}，token=${this.token.slice(0, 8)}...`);
    }
    startHeartbeat() {
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ type: "heartbeat" }));
            }
        }, 25_000);
    }
    stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }
    cleanupLocalWs() {
        for (const [, localWs] of this.localWsMap) {
            try {
                localWs.close();
            }
            catch { }
        }
        this.localWsMap.clear();
    }
    // ============ 隧道消息处理 ============
    handleTunnelMessage(msg) {
        const type = msg.type;
        if (type === "heartbeat-ack")
            return;
        if (type === "http-request") {
            this.handleHttpRequest(msg);
        }
        else if (type === "ws-open") {
            this.handleWsOpen(msg);
        }
        else if (type === "ws-data") {
            const localWs = this.localWsMap.get(msg.reqId);
            if (localWs && localWs.readyState === WebSocket.OPEN) {
                localWs.send(msg.data);
            }
        }
        else if (type === "ws-close") {
            const localWs = this.localWsMap.get(msg.reqId);
            if (localWs) {
                try {
                    localWs.close(msg.code || 1000, msg.reason || "");
                }
                catch { }
                this.localWsMap.delete(msg.reqId);
            }
        }
    }
    /**
     * HTTP 代理：Relay → fetch localhost → 回传响应/SSE 流
     */
    async handleHttpRequest(msg) {
        const reqId = msg.reqId;
        const method = msg.method;
        const path = msg.path;
        const headers = (msg.headers || {});
        const body = msg.body;
        try {
            const url = `http://localhost:${this.localPort}${path}`;
            const fetchHeaders = { ...headers };
            delete fetchHeaders["host"];
            delete fetchHeaders["connection"];
            delete fetchHeaders["transfer-encoding"];
            const res = await fetch(url, {
                method,
                headers: fetchHeaders,
                body: method !== "GET" && method !== "HEAD" ? body : undefined,
            });
            const contentType = res.headers.get("content-type") || "";
            if (contentType.includes("text/event-stream")) {
                // SSE 流式 — 逐 chunk 透传（核心体验）
                this.sendTunnel({
                    reqId,
                    type: "sse-start",
                    status: res.status,
                    headers: Object.fromEntries(res.headers.entries()),
                });
                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                while (true) {
                    const { done, value } = await reader.read();
                    if (done)
                        break;
                    this.sendTunnel({
                        reqId,
                        type: "sse",
                        data: decoder.decode(value, { stream: true }),
                    });
                }
                this.sendTunnel({ reqId, type: "sse-end" });
            }
            else {
                const responseBody = await res.text();
                this.sendTunnel({
                    reqId,
                    type: "http-response",
                    status: res.status,
                    headers: Object.fromEntries(res.headers.entries()),
                    body: responseBody,
                });
            }
        }
        catch (err) {
            this.sendTunnel({
                reqId,
                type: "http-error",
                error: err.message,
            });
        }
    }
    /**
     * WS 代理：连接本地 WS → 双向透传（终端等场景）
     */
    handleWsOpen(msg) {
        const reqId = msg.reqId;
        const path = msg.path;
        try {
            const localWsUrl = `ws://localhost:${this.localPort}${path}`;
            const localWs = new WebSocket(localWsUrl);
            localWs.on("open", () => {
                this.localWsMap.set(reqId, localWs);
                this.sendTunnel({ reqId, type: "ws-opened" });
            });
            localWs.on("message", (data) => {
                this.sendTunnel({ reqId, type: "ws-data", data: data.toString() });
            });
            localWs.on("close", (code, reason) => {
                this.localWsMap.delete(reqId);
                this.sendTunnel({ reqId, type: "ws-close", code, reason: reason?.toString() || "" });
            });
            localWs.on("error", (err) => {
                this.localWsMap.delete(reqId);
                this.sendTunnel({ reqId, type: "ws-error", error: err.message });
            });
        }
        catch (err) {
            this.sendTunnel({ reqId, type: "ws-error", error: err.message });
        }
    }
    sendTunnel(msg) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(msg));
        }
    }
}
//# sourceMappingURL=tunnel-provider.js.map