/**
 * 飞书通道跨 Session 记忆管理
 *
 * 三层设计：
 * 1. Session Summary — session 超时/清除时提取对话摘要，新 session 注入
 * 2. Shared Context — 复用 context-loader 注入 memory-items + RECENT_EVENTS
 * 3. Per-Chat Facts — 按 chatId 存储原子事实，新 session 注入 Top N
 *
 * 决策点（2026-03-11）：
 * - 摘要提取用 Claude SDK 内联（不额外调 Codex），保持轻量
 * - per-chat facts 存文件持久化，内存缓存加速读取
 * - 注入总量控制 ≤ 2000 chars（摘要 800 + 共享记忆 800 + per-chat 400）
 */
/**
 * 记录一轮对话到缓冲区（每次 processFeishuMessage 完成后调用）
 */
export declare function recordConversationTurn(chatId: string, userMsg: string, assistantReply: string): void;
/**
 * Session 结束时调用：从对话缓冲生成摘要并存储
 *
 * 采用轻量级本地摘要（不调 LLM），直接提取关键信息。
 * 决策原因：调 LLM 会增加延迟和成本，本地提取够用。
 */
export declare function onSessionEnd(chatId: string, cwd: string): void;
/**
 * 添加 per-chat 事实（由 auto-capture 回调或手动添加）
 */
export declare function addChatFact(chatId: string, fact: string, cwd: string): void;
/**
 * 提取对话中的事实并存储（轻量级本地提取，不调 LLM）
 *
 * 提取规则：
 * - 用户明确提到的偏好/要求
 * - 助手确认的关键结论/决定
 * - 项目/配置相关的具体信息
 */
export declare function extractAndStoreFacts(chatId: string, userMsg: string, assistantReply: string, cwd: string): void;
/**
 * 构建飞书通道的跨 session 上下文。
 * 在每次新消息处理前调用，注入到 prompt 前缀。
 *
 * @param chatId   飞书 chat_id
 * @param message  用户当前消息（用于 context-loader 关键词匹配）
 * @param cwd      mycc 根目录
 * @param isNewSession  是否是新 session（超时/首次）
 * @returns 格式化的上下文前缀（可能为空）
 */
export declare function buildCrossSessionContext(chatId: string, message: string, cwd: string, isNewSession: boolean): string;
/**
 * 清除指定 chatId 的所有记忆（/clear 时调用）
 */
export declare function clearChatMemory(chatId: string): void;
//# sourceMappingURL=chat-memory.d.ts.map