/**
 * 飞书私聊记录归档 + 记忆提取
 *
 * 两层设计：
 * 1. 原文归档 → 0-System/chat-history/p2p/YYYY-MM-DD.md
 * 2. 记忆提取 → 复用 auto-capture（Codex 提取原子事实到 memory-items.md）
 *
 * 全部 fire-and-forget，不阻塞主流程。
 */
/**
 * 保存私聊对话记录并触发记忆提取。
 *
 * @param chatId  飞书 chat_id（用于标识来源）
 * @param userMsg 用户原始消息
 * @param reply   cc 的回复
 * @param cwd     mycc 根目录
 */
export declare function saveChatAndExtractMemory(chatId: string, userMsg: string, reply: string, cwd: string): void;
//# sourceMappingURL=chat-history.d.ts.map