/**
 * Tunnel Provider 接口抽象
 *
 * 为未来支持多种隧道方案预留接口：
 * - CloudflareProvider（当前实现）
 * - SSHProvider（待实现）
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
//# sourceMappingURL=tunnel-provider.d.ts.map