/**
 * mcp-bridge.ts — MCP 工具桥接到 ToolRegistry
 *
 * 将 MCP Server 暴露的工具转换为 ToolDefinition 并注册到 ToolRegistry，
 * 让 Agent Loop 能像使用内置工具一样调用外部 MCP 工具。
 *
 * 命名规则：mcp_{serverName}_{toolName}，避免与内置工具冲突。
 */

import { z } from "zod";
import type { McpClient, McpToolInfo } from "./mcp-client.js";
import type { ToolDefinition, ToolRegistry } from "./tool-registry.js";

// ─── Types ───

/** 桥接结果 */
export interface BridgeResult {
  serverName: string;
  toolCount: number;
  toolNames: string[];
}

// ─── 工具名转换 ───

/** 给 MCP 工具名加前缀，避免冲突 */
function prefixedName(serverName: string, toolName: string): string {
  return `mcp_${serverName}_${toolName}`;
}

// ─── 单个工具转换 ───

/**
 * 将 MCP 工具信息转换为 ToolDefinition
 *
 * 由于 MCP 的 inputSchema 是 JSON Schema 而非 zod，
 * 这里用 z.any() 简化——LLM 侧仍然能看到完整 JSON Schema（通过 rawSchema 覆盖）。
 * Agent Loop 的 toOpenAITools() 会使用 zodToJsonSchema，
 * 但我们在注册时通过 rawJsonSchema 字段让 bridge 工具保留原始 schema。
 */
function mcpToolToDefinition(
  client: McpClient,
  tool: McpToolInfo,
): ToolDefinition<unknown, unknown> {
  const fullName = prefixedName(client.serverName, tool.name);
  const originalToolName = tool.name;

  return {
    name: fullName,
    description: tool.description ?? `MCP tool: ${tool.name}`,
    inputSchema: z.any(),
    rawJsonSchema: tool.inputSchema ?? { type: "object", properties: {} },
    isReadOnly: false, // 无法确定，保守地标记为非只读
    isDestructive: false,
    timeoutMs: 30_000,

    async execute(input: unknown): Promise<unknown> {
      const args = (typeof input === "object" && input !== null)
        ? input as Record<string, unknown>
        : {};
      const result = await client.callTool(originalToolName, args);
      return { result };
    },
  };
}

// ─── 桥接函数 ───

/**
 * 从 MCP Client 获取工具列表，转换并注册到 ToolRegistry
 *
 * @returns 桥接结果（工具数量和名称列表）
 */
export async function bridgeMcpTools(
  client: McpClient,
  registry: ToolRegistry,
): Promise<BridgeResult> {
  const mcpTools = await client.listTools();
  const registeredNames: string[] = [];

  for (const tool of mcpTools) {
    const definition = mcpToolToDefinition(client, tool);

    // 如果同名工具已注册，跳过（避免重复注册报错）
    if (registry.get(definition.name)) {
      continue;
    }

    registry.register(definition);
    registeredNames.push(definition.name);
  }

  return {
    serverName: client.serverName,
    toolCount: registeredNames.length,
    toolNames: registeredNames,
  };
}

