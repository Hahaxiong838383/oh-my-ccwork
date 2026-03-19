/**
 * 会话统计模块
 *
 * 从 HttpServer 提取的会话级工具调用统计和消息计数
 */
export class SessionStats {
    /** 每个 session 的工具调用统计 */
    toolStatsMap = new Map();
    /** 每个 session 的消息计数（只算 user + assistant） */
    messageCountMap = new Map();
    /**
     * 累计工具调用统计
     * Write/Edit/NotebookEdit → Write++
     * Read/Glob/Grep → Read++
     * Bash → Bash++
     */
    incrementToolStat(sessionId, toolName) {
        if (!sessionId)
            return;
        if (!this.toolStatsMap.has(sessionId)) {
            this.toolStatsMap.set(sessionId, { Write: 0, Read: 0, Bash: 0 });
        }
        const stats = this.toolStatsMap.get(sessionId);
        if (["Write", "Edit", "NotebookEdit"].includes(toolName)) {
            stats.Write++;
        }
        else if (["Read", "Glob", "Grep"].includes(toolName)) {
            stats.Read++;
        }
        else if (toolName === "Bash") {
            stats.Bash++;
        }
    }
    /**
     * 累计消息计数
     */
    incrementMessageCount(sessionId) {
        if (!sessionId)
            return;
        this.messageCountMap.set(sessionId, (this.messageCountMap.get(sessionId) || 0) + 1);
    }
    /**
     * 获取指定 session 的工具统计
     */
    getToolStats(sessionId) {
        return this.toolStatsMap.get(sessionId) || { Write: 0, Read: 0, Bash: 0 };
    }
    /**
     * 获取指定 session 的消息计数
     */
    getMessageCount(sessionId) {
        return this.messageCountMap.get(sessionId) || 0;
    }
    /**
     * 获取所有已知 session ID（合并 toolStats 和 messageCount 的 key）
     */
    getAllSessionIds() {
        const ids = new Set();
        for (const id of this.toolStatsMap.keys())
            ids.add(id);
        for (const id of this.messageCountMap.keys())
            ids.add(id);
        return Array.from(ids);
    }
    /**
     * 清理指定 session 的所有统计数据
     */
    cleanup(sessionId) {
        this.toolStatsMap.delete(sessionId);
        this.messageCountMap.delete(sessionId);
    }
    /**
     * 获取活跃 session 数量（以 toolStats 的 key 数量为准，与心跳行为一致）
     */
    getActiveCount() {
        return this.toolStatsMap.size;
    }
}
//# sourceMappingURL=session-stats.js.map