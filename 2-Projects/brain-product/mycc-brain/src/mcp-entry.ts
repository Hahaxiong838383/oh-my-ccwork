/**
 * mcp-entry.ts — MCP Server 入口
 *
 * 独立进程入口，通过 stdio 与 Claude Code 通信。
 * 用法：node dist/mcp-entry.js
 * 环境变量：DATA_DIR（记忆数据目录路径）
 */

import { resolve } from "path";
import { ToolRegistry } from "./services/tool-registry.js";
import { McpServer } from "./services/mcp-server.js";
import { searchMemoryTool } from "./tools/search-memory.js";
import { listMemoriesTool } from "./tools/list-memories.js";
import { runDiagnosisTool } from "./tools/run-diagnosis.js";
import { lookAtTool } from "./services/vision-tool.js";
import { DEFAULT_DATA_DIR } from "./env.js";

// ─── 配置 ───

const brainRoot = resolve(import.meta.dirname, "..");
const dataDir = DEFAULT_DATA_DIR;

// ─── 注册工具 ───

const registry = new ToolRegistry();
registry.register(searchMemoryTool);
registry.register(listMemoriesTool);
registry.register(runDiagnosisTool);
registry.register(lookAtTool);

// ─── 启动 MCP Server ───

const server = new McpServer({
  registry,
  toolContext: { brainRoot, dataDir },
});

// 禁止 stderr 以外的日志污染 stdout（MCP 协议要求 stdout 只传 JSON-RPC）
const logToStderr = (msg: string): void => {
  process.stderr.write(`[mycc-brain-mcp] ${msg}\n`);
};

logToStderr(`启动 MCP Server — brainRoot=${brainRoot}, dataDir=${dataDir}`);
logToStderr(`已注册工具: ${registry.list().map((t) => t.name).join(", ")}`);

server.start();
