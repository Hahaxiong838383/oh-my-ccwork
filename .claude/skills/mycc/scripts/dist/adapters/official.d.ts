/**
 * 官方 Claude Code SDK 实现（v2 Session API）
 */
import { type SDKSession } from "@anthropic-ai/claude-agent-sdk";
import type { CCAdapter, SSEEvent, SessionParams } from "./interface.js";
import type { ChatParams, ConversationSummary, ConversationHistory } from "../types.js";
/**
 * 官方 Claude Code SDK Adapter（v2 Session 模式）
 */
export declare class OfficialAdapter implements CCAdapter {
    /** Session 池 */
    private sessions;
    /** 每个 session 最后活跃时间 */
    private lastActivity;
    /** 超时清理定时器 */
    private cleanupTimer;
    /** Auth 状态缓存 */
    private _authOk;
    /** Auth 失败通知回调（由外部注册，用于飞书通知等） */
    private _onAuthFailed;
    constructor();
    setLifecycleCallbacks(_callbacks: {
        onSessionCreate?: (sessionId: string) => void;
        onSessionClose?: (sessionId: string) => void;
    }): void;
    /**
     * 获取或创建 v2 Session
     * 注意：新建的 session 不立即存池（sessionId 要收到第一条消息后才可用）
     * 由 chat() 在 stream 中拿到 sessionId 后调 registerSession 存入池
     */
    getOrCreateSession(params: SessionParams): SDKSession;
    /**
     * 将 session 注册到池中（新 session 收到 sessionId 后调用）
     */
    registerSession(sessionId: string, session: SDKSession): void;
    /**
     * 关闭指定 session
     */
    closeSession(sessionId: string): void;
    /**
     * 关闭所有 session
     */
    closeAllSessions(): void;
    /**
     * 注册 auth 失败回调（飞书通知等）
     */
    onAuthFailed(callback: (msg: string) => void): void;
    /**
     * 构造干净的环境变量（移除 CLAUDECODE）
     * 后端从 Claude Code session 启动时继承 CLAUDECODE=1，
     * 会导致 claude 子进程报 "Cannot be launched inside another Claude Code session"
     */
    private getCleanEnv;
    /**
     * 检查 Claude CLI auth 状态
     * 返回 true = 已登录，false = 未登录或检查失败
     */
    checkAuth(): boolean;
    /** 获取当前 auth 状态（不执行检查） */
    get authOk(): boolean;
    /** 设置 auth 状态（由 HealthMonitor 调用） */
    set authOk(ok: boolean);
    /**
     * 发送消息，返回 SSE 事件流（v2 Session 模式）
     *
     * 支持多轮推送（Agent Teams + 后台 Task subagent）：
     * - 普通对话：一轮 result 后直接结束 SSE
     * - Teams 对话：检测到 TeamCreate → 持续等待 → TeamDelete 后结束
     * - 后台 Task：检测到 Task(run_in_background) → 持续等待 → 所有任务完成后结束
     *
     * stream() 遇到 result 就 return，但底层 queryIterator 是共享的，
     * 每次调 stream() 从断点继续消费。后续消息由 CLI 内部注入触发新一轮处理。
     *
     * 退出条件（按优先级）：
     * 1. 非多轮模式 → 第一轮结束即退出
     * 2. Teams + TeamDelete → 退出
     * 3. 后台 Task + 全部完成（pending 计数归零）→ 退出
     * 4. 轮间超时（5 分钟无新消息）→ 退出
     * 5. 总安全阀（30 分钟）→ 强制退出
     */
    chat(params: ChatParams): AsyncIterable<SSEEvent>;
    /**
     * 从 system 消息中提取 sessionId
     */
    private extractSessionId;
    /**
     * 获取历史记录列表
     */
    listHistory(cwd: string, limit?: number): Promise<{
        conversations: ConversationSummary[];
        total: number;
        hasMore: boolean;
    }>;
    /**
     * 获取单个对话详情
     */
    getHistory(cwd: string, sessionId: string): Promise<ConversationHistory | null>;
    /**
     * 清理超时 session
     */
    private cleanupExpiredSessions;
}
//# sourceMappingURL=official.d.ts.map