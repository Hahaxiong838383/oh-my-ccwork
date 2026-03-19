/**
 * 会话统计模块
 *
 * 从 HttpServer 提取的会话级工具调用统计和消息计数
 */
export declare class SessionStats {
    /** 每个 session 的工具调用统计 */
    readonly toolStatsMap: Map<string, {
        Write: number;
        Read: number;
        Bash: number;
    }>;
    /** 每个 session 的消息计数（只算 user + assistant） */
    readonly messageCountMap: Map<string, number>;
    /**
     * 累计工具调用统计
     * Write/Edit/NotebookEdit → Write++
     * Read/Glob/Grep → Read++
     * Bash → Bash++
     */
    incrementToolStat(sessionId: string | undefined, toolName: string): void;
    /**
     * 累计消息计数
     */
    incrementMessageCount(sessionId: string | undefined): void;
    /**
     * 获取指定 session 的工具统计
     */
    getToolStats(sessionId: string): {
        Write: number;
        Read: number;
        Bash: number;
    };
    /**
     * 获取指定 session 的消息计数
     */
    getMessageCount(sessionId: string): number;
    /**
     * 获取所有已知 session ID（合并 toolStats 和 messageCount 的 key）
     */
    getAllSessionIds(): string[];
    /**
     * 清理指定 session 的所有统计数据
     */
    cleanup(sessionId: string): void;
    /**
     * 获取活跃 session 数量（以 toolStats 的 key 数量为准，与心跳行为一致）
     */
    getActiveCount(): number;
}
//# sourceMappingURL=session-stats.d.ts.map