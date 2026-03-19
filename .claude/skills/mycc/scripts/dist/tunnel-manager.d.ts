/**
 * TunnelManager - 隧道保活管理器
 *
 * 功能：
 * 1. 进程监控：cloudflared 进程退出时自动重启
 * 2. 心跳检测：定时探测隧道健康状态，连续失败触发重启
 * 3. 防重入锁：避免并发重启冲突
 * 4. 重启限制：超过最大次数后放弃，但保持心跳以便后续恢复
 */
import type { TunnelProvider } from "./tunnel-provider.js";
export interface TunnelManagerOptions {
    /** 本地服务端口 */
    localPort: number;
    /** 重启成功后的回调（用于重新注册 Worker、更新 current.json 等） */
    onRestartSuccess?: (url: string) => Promise<void>;
    /** 放弃重启时的回调 */
    onGiveUp?: () => void;
}
export interface TunnelManagerStatus {
    isRunning: boolean;
    tunnelUrl: string | null;
    isRestarting: boolean;
    failCount: number;
    restartAttempts: number;
    hasGivenUp: boolean;
    heartbeatActive: boolean;
    heartbeatCount: number;
}
export declare class TunnelManager {
    private provider;
    private localPort;
    private tunnelUrl;
    private proc;
    private isRestarting;
    private failCount;
    private restartAttempts;
    private heartbeatTimer;
    private isStopped;
    private hasGivenUp;
    private heartbeatCount;
    private onRestartSuccess?;
    private onGiveUp?;
    constructor(options: TunnelManagerOptions);
    /**
     * 启动隧道
     */
    start(provider: TunnelProvider): Promise<string>;
    /**
     * 停止隧道
     */
    stop(): void;
    /**
     * 获取当前状态
     */
    getStatus(): TunnelManagerStatus;
    /**
     * 获取当前隧道 URL
     */
    getUrl(): string | null;
    /**
     * 设置进程退出监控
     */
    private setupProcMonitor;
    /**
     * 启动心跳检测
     */
    private startHeartbeat;
    /**
     * 检测隧道健康状态
     */
    private checkHealth;
    /**
     * 重启隧道（带防重入锁）
     */
    private restart;
    /**
     * 确保心跳检测在运行
     */
    private ensureHeartbeat;
    /**
     * 等待隧道就绪
     * DNS 传播后调用，验证隧道实际可用
     */
    private waitForReady;
    /**
     * 延迟辅助函数
     */
    private sleep;
}
//# sourceMappingURL=tunnel-manager.d.ts.map