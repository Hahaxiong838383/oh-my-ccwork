/**
 * 历史记录处理
 * 读取 ~/.claude/projects/{encodedProjectName}/ 下的 JSONL 文件
 *
 * v2.0：纯文件系统扫描（兼容 CC 2.1.33+）
 * - 不再依赖 sessions-index.json
 * - 不再依赖文件权限判断活跃状态
 * - 使用 head/tail 16KB 快速读取（与 CC 官方实现一致）
 */
import type { ConversationSummary, ConversationHistory } from "./types.js";
export type { ConversationSummary, ConversationHistory };
/**
 * 将项目路径编码为 Claude 使用的目录名
 * /Users/aster/AIproject/mylife → -Users-aster-AIproject-mylife
 *
 * 自动检测项目根目录（查找 .claude/ 或 CLAUDE.md），确保历史记录路径一致性
 */
export declare function encodeProjectPath(projectPath: string): string;
/**
 * 获取历史记录目录
 */
export declare function getHistoryDir(cwd: string): string;
/**
 * 扫描目录中所有 .jsonl 会话文件
 * 对应 CC 源码的 g$q 函数
 */
export declare function scanSessionFiles(dir: string): Map<string, {
    path: string;
    mtime: number;
    ctime: number;
    size: number;
}>;
/**
 * 从 head 内容中提取第一条 user 消息
 * 对应 CC 源码的 b5z 函数
 *
 * 跳过：file-history-snapshot、tool_result、isMeta: true
 */
export declare function extractFirstPrompt(headContent: string): string;
/**
 * 从内容中提取最后一个匹配的 JSON 字段值
 * 对应 CC 源码的 rP1 函数
 *
 * 用于从 tail 内容中找 customTitle 等字段
 */
export declare function extractLastField(content: string, fieldName: string): string | undefined;
/**
 * 读取文件摘要（head + tail 16KB）
 * 对应 CC 源码的 x5z 函数
 */
export declare function readFileSummary(filePath: string, fileSize: number): {
    firstPrompt: string;
    customTitle?: string;
};
/**
 * 获取具体对话内容
 * 优化：只返回最后一个 summary 之后的消息，节省流量
 */
export declare function getConversation(cwd: string, sessionId: string): ConversationHistory | null;
/**
 * 获取对话列表
 * 纯文件系统扫描 + head/tail 16KB 快速读取（CC 2.1.33 方案）
 *
 * @param cwd 工作目录
 * @param limit 限制返回数量（在 hydrate 前应用，提升性能）
 */
export declare function getConversationList(cwd: string, limit?: number): ConversationSummary[];
/**
 * 重命名会话
 * 简化版：只追加 custom-title 到 .jsonl，不更新索引
 */
export declare function renameSession(sessionId: string, newTitle: string, projectPath: string): boolean;
//# sourceMappingURL=history.d.ts.map