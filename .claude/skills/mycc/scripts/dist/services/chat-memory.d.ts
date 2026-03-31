/**
 * 飞书通道跨 Session 记忆管理
 *
 * 三层设计：
 * 1. Session Summary — session 超时/清除时提取对话摘要，新 session 注入
 * 2. Shared Context — 复用 context-loader 注入 memory-items + RECENT_EVENTS
 * 3. Per-Chat Facts — 按 chatId 存储原子事实，新 session 注入 Top N
 *
 * v5.5 升级（借鉴 lossless-claw DAG 层次摘要）：
 * - DAG 对话摘要：层次化压缩，支持 expand 回溯到原始消息范围
 * - 存储格式从 { summary: string } 升级为 ConversationDAG
 * - 向后兼容：旧格式自动迁移为单节点 DAG
 *
 * 决策点（2026-03-11）：
 * - 摘要提取用 Claude SDK 内联（不额外调 Codex），保持轻量
 * - per-chat facts 存文件持久化，内存缓存加速读取
 * - 注入总量控制 ≤ 2000 chars（摘要 800 + 共享记忆 800 + per-chat 400）
 */
/** DAG 节点：对话片段的层次化摘要 */
export interface DAGNode {
    id: string;
    level: number;
    sourceRange: [number, number];
    summary: string;
    children: string[];
    tokenCount: number;
}
/** 一个 chatId 的完整对话 DAG */
export interface ConversationDAG {
    chatId: string;
    nodes: DAGNode[];
    rootId: string;
    version: "dag-v1";
}
/**
 * 记录一轮对话到缓冲区（每次 processFeishuMessage 完成后调用）
 */
export declare function recordConversationTurn(chatId: string, userMsg: string, assistantReply: string): void;
/**
 * v5.5: expand — 从 DAG 回溯到子节点摘要。
 *
 * Agent 可调用此接口从根 → 中间 → 叶子逐层展开，
 * 定位到原始消息范围。
 */
export declare function expandDAGNode(dag: ConversationDAG, nodeId: string): {
    node: DAGNode;
    children: DAGNode[];
} | null;
/**
 * Session 结束时调用：从对话缓冲生成 DAG 摘要并存储。
 *
 * v5.5 升级：扁平摘要 → DAG 层次化压缩。
 * 仍保留兼容的 summaries 字段（供注入层使用）。
 * 不调 LLM，纯本地提取，保持轻量。
 */
export declare function onSessionEnd(chatId: string, cwd: string): void;
/**
 * v5.5: 获取指定 chatId 的 DAG（供外部 expand 调用）。
 * 如果没有 DAG 返回 null。
 */
export declare function getDAG(chatId: string, cwd: string): ConversationDAG | null;
/**
 * 添加 per-chat 事实（由 auto-capture 回调或手动添加）
 * v2：Jaccard 去重（阈值 0.5），替代简单 string.includes
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
export declare function buildCrossSessionContext(chatId: string, message: string, cwd: string, isNewSession: boolean): Promise<string>;
/**
 * 清除指定 chatId 的所有记忆（/clear 时调用）
 */
export declare function clearChatMemory(chatId: string): void;
//# sourceMappingURL=chat-memory.d.ts.map