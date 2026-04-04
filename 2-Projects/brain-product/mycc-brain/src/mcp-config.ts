/**
 * mcp-config.ts — MCP Server 配置加载
 *
 * 从 mcp-servers.json 文件或环境变量加载 MCP Server 列表。
 * 配置文件路径：项目根目录下的 mcp-servers.json
 */

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

// ─── Types ───

export interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
  enabled: boolean;
}

export type McpServersConfig = Record<string, McpServerConfig>;

// ─── 加载配置 ───

/**
 * 从 mcp-servers.json 加载 MCP Server 配置
 *
 * 配置文件不存在时返回空对象（graceful 降级）。
 * 环境变量可用 MCP_SERVERS_PATH 指定自定义路径。
 */
export function loadMcpServersConfig(): McpServersConfig {
  const brainRoot = resolve(import.meta.dirname, "..");
  const customPath = process.env.MCP_SERVERS_PATH;
  const configPath = customPath ?? resolve(brainRoot, "mcp-servers.json");

  if (!existsSync(configPath)) {
    return {};
  }

  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as McpServersConfig;

    // 基础校验
    const validated: McpServersConfig = {};
    for (const [name, cfg] of Object.entries(parsed)) {
      if (!cfg.command || !Array.isArray(cfg.args)) {
        console.warn(`[mcp-config] 跳过无效配置: ${name}（缺少 command 或 args）`);
        continue;
      }
      validated[name] = {
        command: cfg.command,
        args: cfg.args,
        env: cfg.env ?? undefined,
        enabled: cfg.enabled !== false, // 默认启用
      };
    }

    return validated;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[mcp-config] 加载 ${configPath} 失败: ${msg}`);
    return {};
  }
}

/**
 * 获取已启用的 MCP Server 配置
 */
export function getEnabledMcpServers(): McpServersConfig {
  const all = loadMcpServersConfig();
  const enabled: McpServersConfig = {};
  for (const [name, cfg] of Object.entries(all)) {
    if (cfg.enabled) {
      enabled[name] = cfg;
    }
  }
  return enabled;
}
