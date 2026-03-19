/**
 * 会话归属管理
 *
 * 维护 sessionId → channelId 的映射关系，实现飞书通道级会话隔离。
 * 数据存储在 ~/.claude/projects/{encodedPath}/channel-sessions.json
 *
 * 设计原则：
 * - 内存缓存：首次 load 后走缓存，避免频繁磁盘读取
 * - 原子写入：temp + rename，并发安全
 * - 向后兼容：无归属记录的老会话对所有通道可见
 */
export declare class SessionOwnership {
    private filePath;
    private cache;
    constructor(cwd: string);
    /**
     * 从磁盘加载归属数据（仅首次调用时读盘，之后走缓存）
     */
    private load;
    /**
     * 原子写入归属数据到磁盘（temp + rename）
     */
    private save;
    /**
     * 注册会话归属（幂等，不抢占已被其他通道占用的会话）
     * 返回 true 表示成功，false 表示被其他通道占用
     */
    claim(sessionId: string, channelId: string): boolean;
    /**
     * 查询会话归属，null 表示无标记（老会话）
     */
    getOwner(sessionId: string): string | null;
    /**
     * 判断某会话对某通道是否可见
     * - 无归属记录 → 对所有通道可见
     * - 归属匹配 → 可见
     * - 归属不匹配 → 不可见
     */
    isVisibleTo(sessionId: string, channelId: string): boolean;
    /**
     * 过滤列表，只保留对指定通道可见的条目
     * 泛型兼容 ConversationSummary 和 SearchResult（都有 sessionId 字段）
     */
    filterForChannel<T extends {
        sessionId: string;
    }>(list: T[], channelId: string): T[];
}
//# sourceMappingURL=session-ownership.d.ts.map