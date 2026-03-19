/**
 * Auto-Capture Memory Service
 *
 * 对话结束后，异步调用 Codex 提取新的原子记忆条目并写入 memory-items.md。
 * 设计原则：
 * - 完全非阻塞（fire-and-forget），不影响用户体验
 * - 仅在有实质性内容时触发（过滤闲聊、空回复等）
 * - Codex 使用 danger-full-access 直接读写 memory-items.md
 *
 * 基于 OpenViking Memory Plugin 的 agent_end hook 思路。
 */
/**
 * 触发 Auto-Capture（fire-and-forget）。
 * 在对话轮次结束后调用，异步提取记忆，不阻塞主流程。
 *
 * @param sessionId 会话 ID（用于冷却控制）
 * @param userMessage 用户原始消息
 * @param assistantReply 助手最终回复
 * @param cwd 工作目录（mycc 根目录）
 */
export declare function triggerAutoCapture(sessionId: string, userMessage: string, assistantReply: string, cwd: string): void;
//# sourceMappingURL=auto-capture.d.ts.map