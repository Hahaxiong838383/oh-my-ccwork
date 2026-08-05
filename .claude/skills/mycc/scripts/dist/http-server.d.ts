/**
 * HTTP 服务器
 * 提供 REST API 供小程序调用
 */
import http from "http";
import https from "https";
export interface TlsConfig {
    certPath: string;
    keyPath: string;
}
/** 测试用：重置速率限制状态 */
export declare function _resetPairAttempts(): void;
export declare class HttpServer {
    private server;
    private state;
    private cwd;
    private onPaired?;
    private isTls;
    private channelManager;
    /** 每通道独立上下文：会话 + 回复路由完全隔离 */
    private channelContexts;
    private feishuChannel;
    private sessionOwnership;
    /** 每通道的中止控制器（非队列任务用） */
    private channelAbortControllers;
    private terminalPassword;
    constructor(pairCode: string, cwd: string, authToken?: string, tls?: TlsConfig);
    /** 设置配对成功回调（用于持久化 authToken） */
    setOnPaired(callback: (token: string) => void): void;
    /** 获取当前 authToken */
    getAuthToken(): string | null;
    private handleRequest;
    private handleMemoryRollback;
    private handleMemoryExtract;
    private handleMemoryDream;
    private handleHealth;
    private handlePair;
    private handleChat;
    /**
     * 处理飞书收到的消息
     *
     * 隔离机制：
     * - ctx.currentSessionId 每通道独立，互不影响
     * - sendToChannel(ctx, ...) 只回给发消息的通道
     * - adapter/MCP/skills 共用底层进程
     */
    private processFeishuMessage;
    /**
     * 后台异步任务执行（双主分离 - 任务主 Agent）
     *
     * 关键设计：
     * - 使用独立 session（sessionId: undefined），不占用对话 session
     * - 任务完成/失败后主动回飞书
     * - 不更新 ctx.currentSessionId（避免污染对话状态）
     */
    private runTaskAsync;
    /**
     * 管道模式：Gemini 分析 → Codex 写入飞书
     *
     * 分摊 cc 负担：
     * - Gemini 负责内容分析/生成（多模态能力强，token 便宜）
     * - Codex 负责飞书 MCP 写入（有完整 MCP 权限）
     * - cc 只做编排，不消耗 token
     */
    private runPipeline;
    /**
     * CLI 引擎消息处理（codex / gemini）
     * 无 session 概念，每次调用都是独立的子进程。
     */
    private processCliEngineMessage;
    /**
     * 团队模式关键词检测
     */
    private static TEAM_MODE_KEYWORDS;
    private detectTeamMode;
    /**
     * 团队模式：cc 主控，并行调用三引擎，卡片实时更新进度
     */
    private processTeamMode;
    /**
     * 生成 Mermaid 风格的文本流程总结
     */
    private buildMermaidSummary;
    /**
     * 运行 cc 引擎并收集文本输出（供团队模式使用）
     */
    private runCcEngine;
    private handleFeishuCommand;
    private pendingConfirm;
    /**
     * 检查是否是对待确认操作的回复
     */
    private checkPendingConfirm;
    /**
     * 高风险运维操作需要确认
     */
    private isHighRiskOperation;
    private isOperationCommand;
    private handleOperationCommand;
    private handleRestart;
    private handleStop;
    private handleStatus;
    private handleNewSession;
    private handleListSessions;
    private handleSwitchSession;
    private handleCurrentSession;
    private handleDevice;
    /** 获取或创建通道的 AbortController */
    private getChannelAbort;
    /**
     * /stop - 一键停止当前正在执行的任务
     * 1. 中止任务队列（当前任务 + 待执行）
     * 2. 关闭当前 Claude session（打断 stream）
     * 3. CLI 引擎子进程由 AbortSignal 自动 kill
     */
    private handleStopTask;
    /**
     * /reset - 重置会话（比 /new 更彻底：关闭 session + 清空上下文）
     */
    private handleResetSession;
    /**
     * /queue - 查看当前通道的任务队列状态
     */
    private handleQueueInfo;
    private handleHelp;
    private handleSearch;
    /**
     * 发送消息到指定飞书通道（隔离路由，不广播到其他通道）
     */
    private sendToChannel;
    /**
     * 向所有飞书通道广播消息（用于系统级通知，如 auth 过期）
     */
    broadcastToFeishu(text: string): Promise<void>;
    sendSchedulerOwnerNotification(text: string): Promise<boolean>;
    sendSchedulerGroupNotification(text: string): Promise<boolean>;
    private formatTimeAgo;
    private handleHistoryList;
    private handleHistoryDetail;
    private handleRename;
    private handleSkillsList;
    private handleSkillsReload;
    setTerminalPassword(password: string): void;
    getHttpServer(): http.Server | https.Server;
    validateTerminalToken(token: string): boolean;
    private handleTerminalAuth;
    private serveTerminalFrontend;
    private getInlineTerminalHtml;
    private readBody;
    start(): Promise<number>;
    /**
     * 飞书 MCP Token 保活 — 每 30 分钟刷新一次
     *
     * 飞书 OAuth access_token 有效期 2h，refresh_token 有效期 30 天。
     * 定期调用一次简单 API，触发 MCP server 内部的 auto-refresh 机制，
     * 确保 token 文件始终有效，3 个机器人随时可调用。
     */
    private tokenKeepaliveTimer;
    private startTokenKeepalive;
    stop(): void;
}
//# sourceMappingURL=http-server.d.ts.map