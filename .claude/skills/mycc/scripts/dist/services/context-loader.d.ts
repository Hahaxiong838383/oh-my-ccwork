/**
 * 共享记忆上下文加载器
 *
 * 为 Codex / Gemini CLI 调用动态注入记忆上下文。
 * 两层：
 * 1. RECENT_EVENTS.md 尾部（最近事件）
 * 2. memory-items.md 关键词匹配类别（[user/*] 始终注入，[project/*] 按需）
 *
 * 设计原则：
 * - 总注入量控制在 ~3000 字符以内（避免 prompt 膨胀）
 * - 每个类别最多 Top 10 条（按 ★ 优先级排序）
 * - fire-and-forget 读取，文件缺失不报错
 */
/**
 * 根据 prompt 内容，加载共享记忆上下文。
 *
 * @param prompt 用户原始消息
 * @param cwd   mycc 根目录
 * @returns 格式化的 context 前缀（可能为空）
 */
export declare function loadSharedContext(prompt: string, cwd: string): string;
//# sourceMappingURL=context-loader.d.ts.map