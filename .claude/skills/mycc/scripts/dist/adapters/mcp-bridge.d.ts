/**
 * MCP Bridge — 轻量 JSON-RPC over stdio 客户端
 *
 * 用于 Gemini function calling → 飞书 MCP 工具执行。
 * 单例模式：首次调用时 spawn MCP server，后续复用。
 *
 * 决策记录：2026-03-14
 * 原因：Gemini API 切换后丢失 MCP 工具调用能力，需要桥接
 */
import type { FunctionDeclaration } from "@google/generative-ai";
/**
 * 获取 Gemini FunctionDeclaration 列表（白名单内的飞书 MCP 工具）
 */
export declare function getGeminiFunctionDeclarations(): Promise<FunctionDeclaration[]>;
/**
 * 执行 MCP 工具调用
 */
export declare function callMcpTool(toolName: string, args: Record<string, unknown>): Promise<{
    success: boolean;
    result: unknown;
}>;
/**
 * 关闭 MCP server 进程（清理资源）
 */
export declare function closeMcpBridge(): void;
//# sourceMappingURL=mcp-bridge.d.ts.map