/**
 * Tunnel Provider 接口抽象
 *
 * 支持的隧道方案：
 * - CloudflareProvider: Quick Tunnel（随机 URL，无需配置）
 * - NamedCloudflareProvider: Named Tunnel（固定域名，解决 CNAME Cross-User Banned）
 * - WsRelayProvider: 自建 Relay Server（固定 URL，国内低延迟）
 */
import type { ChildProcess } from "child_process";
export interface TunnelResult {
    url: string;
    proc?: ChildProcess;
}
export interface TunnelProvider {
    /**
     * 启动隧道
     * @param localPort 本地服务端口
     * @returns 隧道 URL 和进程引用
     */
    start(localPort: number): Promise<TunnelResult>;
    /**
     * 停止隧道
     */
    stop(): void;
    /**
     * 健康检查
     * @returns true 表示隧道正常
     */
    healthCheck(): Promise<boolean>;
    /**
     * 获取 Provider 名称
     */
    getName(): string;
}
export declare class CloudflareProvider implements TunnelProvider {
    private proc;
    private tunnelUrl;
    private startTimeout;
    private localPort;
    /**
     * @param startTimeout 启动超时时间（毫秒），默认 60 秒
     * cloudflared 连接 Cloudflare Edge 可能需要较长时间，特别是网络不稳定时
     */
    constructor(startTimeout?: number);
    start(localPort: number): Promise<TunnelResult>;
    stop(): void;
    healthCheck(): Promise<boolean>;
    getName(): string;
    /**
     * 获取当前隧道 URL
     */
    getUrl(): string | null;
    /**
     * 获取进程引用（用于外部监控）
     */
    getProc(): ChildProcess | null;
}
export declare class NamedCloudflareProvider implements TunnelProvider {
    private proc;
    private tunnelToken;
    private tunnelId;
    private tunnelUrl;
    private hostname;
    private startTimeout;
    /**
     * @param tunnelToken Cloudflare Tunnel Token（从 Dashboard 获取）
     * @param hostname 绑定的域名（如 cli.hahaxiong.top）
     * @param startTimeout 启动超时时间（毫秒），默认 120 秒
     */
    constructor(tunnelToken: string, hostname: string, startTimeout?: number);
    /**
     * 从 tunnel token 中提取 tunnel UUID
     * Token 格式：base64({"a":"account_tag","t":"tunnel_id","s":"tunnel_secret"})
     */
    private extractTunnelId;
    /**
     * 获取 tunnel UUID（用于创建 CNAME 指向 {uuid}.cfargotunnel.com）
     */
    getTunnelId(): string;
    start(localPort: number): Promise<TunnelResult>;
    stop(): void;
    healthCheck(): Promise<boolean>;
    getName(): string;
    getUrl(): string | null;
    getProc(): ChildProcess | null;
}
export declare class WsRelayProvider implements TunnelProvider {
    private ws;
    private relayUrl;
    private deviceId;
    private token;
    private localPort;
    private heartbeatTimer;
    private proxyUrl;
    private localWsMap;
    /**
     * @param relayUrl Relay Server 地址（如 https://relay.mycc.dev）
     * @param deviceId 设备 ID
     * @param token 已有的注册 token（可选，重启时复用）
     */
    constructor(relayUrl: string, deviceId: string, token?: string);
    start(localPort: number): Promise<TunnelResult>;
    stop(): void;
    healthCheck(): Promise<boolean>;
    getName(): string;
    getUrl(): string | null;
    getToken(): string | null;
    private register;
    private startHeartbeat;
    private stopHeartbeat;
    private cleanupLocalWs;
    private handleTunnelMessage;
    /**
     * HTTP 代理：Relay → fetch localhost → 回传响应/SSE 流
     */
    private handleHttpRequest;
    /**
     * WS 代理：连接本地 WS → 双向透传（终端等场景）
     */
    private handleWsOpen;
    private sendTunnel;
}
//# sourceMappingURL=tunnel-provider.d.ts.map