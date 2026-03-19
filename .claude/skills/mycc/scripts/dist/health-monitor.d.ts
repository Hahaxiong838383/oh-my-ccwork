/**
 * 进程健康监控模块
 *
 * 功能：
 * 1. 监测 mycc 后端进程状态
 * 2. 监测飞书 WebSocket 连接状态
 * 3. 自动检测并恢复断连
 * 4. 定时发送心跳消息到飞书（保持连接活跃）
 */
import { HttpServer } from "./http-server.js";
import { TunnelManager } from "./tunnel-manager.js";
import type { OfficialAdapter } from "./adapters/official.js";
export interface HealthMonitorConfig {
    /** 健康检查间隔（毫秒） */
    checkInterval?: number;
    /** 飞书心跳间隔（毫秒） */
    feishuHeartbeatInterval?: number;
    /** 最大重启次数 */
    maxRestartAttempts?: number;
    /** 重启冷却时间（毫秒） */
    restartCooldown?: number;
    /** 飞书通道（用于发送心跳） */
    feishuChannel?: any;
    /** 飞书是否已连接 */
    feishuConnected?: boolean;
}
export declare class HealthMonitor {
    private timer;
    private authCheckTimer;
    private feishuMcpCheckTimer;
    private feishuHeartbeatTimer;
    private restartCount;
    private lastRestartTime;
    private httpServer;
    private tunnelManager;
    private adapter;
    private config;
    private onRestartCallback;
    private authFailCount;
    private feishuMcpOk;
    constructor(config?: HealthMonitorConfig);
    /**
     * 设置服务器实例
     */
    setHttpServer(server: HttpServer): void;
    /**
     * 设置 Adapter（用于 auth 检查）
     */
    setAdapter(adapter: OfficialAdapter): void;
    /**
     * 设置 Tunnel 管理器
     */
    setTunnelManager(manager: TunnelManager | null): void;
    /**
     * 设置飞书通道
     */
    setFeishuChannel(channel: any): void;
    /**
     * 更新飞书连接状态
     */
    setFeishuConnected(connected: boolean): void;
    /**
     * 设置重启回调
     */
    onRestart(callback: () => Promise<void>): void;
    /**
     * 启动健康监控
     */
    start(): void;
    /**
     * 执行健康检查
     */
    private performHealthCheck;
    /**
     * 检查 HTTP 服务器
     */
    private checkHttpServer;
    /**
     * 检查 Tunnel 状态
     */
    private checkTunnel;
    /**
     * 检查飞书连接状态
     */
    private checkFeishuConnection;
    /**
     * 重连飞书
     */
    private reconnectFeishu;
    /**
     * 构造干净的环境变量（移除 CLAUDECODE，避免子进程被拒绝）
     * 后端从 Claude Code session 启动时会继承 CLAUDECODE=1，
     * 导致 execSync 的 claude 子进程报 "Cannot be launched inside another Claude Code session"
     */
    private getCleanEnv;
    /**
     * 主动刷新 Claude CLI auth token
     * 每次都通过 `claude -p "ping"` 发起真实 API 调用，迫使 CLI 完成 OAuth refresh flow，
     * 确保 Keychain 中的 token 始终有效，SDK 子进程可以读到新 token。
     */
    private refreshAuthToken;
    /**
     * 强制触发 token 刷新
     * 启动一个临时 claude 进程发送空消息，迫使 CLI 完成 OAuth refresh flow。
     * 关键：必须移除 CLAUDECODE 环境变量，否则 claude CLI 会拒绝启动。
     */
    private forceTokenRefresh;
    /**
     * 检查飞书 MCP token 状态
     * 三层防护：1.检测文件存在 2.检测过期并刷新 3.备份恢复
     */
    private checkFeishuMcpToken;
    /**
     * 用 refresh_token 刷新飞书 MCP access_token
     */
    private refreshFeishuMcpToken;
    /**
     * 备份飞书 MCP token 文件
     */
    private backupFeishuMcpToken;
    /**
     * 发送飞书心跳（保持连接活跃）
     */
    private sendFeishuHeartbeat;
    /**
     * 是否应该触发重启
     */
    private shouldRestart;
    /**
     * 触发重启
     */
    private triggerRestart;
    /**
     * 获取监控状态
     */
    getStatus(): {
        running: boolean;
        restartCount: number;
        feishuConnected: boolean;
        httpOk: boolean;
        tunnelOk: boolean;
        authOk: boolean;
        feishuMcpOk: boolean;
    };
    /**
     * 重置重启计数
     */
    resetRestartCount(): void;
    /**
     * 停止健康监控
     */
    stop(): void;
}
//# sourceMappingURL=health-monitor.d.ts.map