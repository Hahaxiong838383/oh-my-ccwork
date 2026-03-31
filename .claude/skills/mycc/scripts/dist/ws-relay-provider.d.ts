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
import type { TunnelProvider, TunnelResult } from "./tunnel-provider.js";
export declare class WsRelayProvider implements TunnelProvider {
    private ws;
    private relayUrl;
    private token;
    private localPort;
    private heartbeatTimer;
    private isConnected;
    private isStopped;
    private activeRequests;
    /**
     * @param relayUrl Relay Server 地址，如 wss://relay.mycc.dev
     * @param token 设备 token（从 /register 获得）
     */
    constructor(relayUrl: string, token: string);
    start(localPort: number): Promise<TunnelResult>;
    stop(): void;
    healthCheck(): Promise<boolean>;
    getName(): string;
    private startHeartbeat;
    private stopHeartbeat;
    /**
     * 处理 Relay 转发过来的请求
     */
    private handleMessage;
    /**
     * 转发请求到本地 mycc HTTP server
     */
    private forwardToLocal;
    private sendToRelay;
}
//# sourceMappingURL=ws-relay-provider.d.ts.map