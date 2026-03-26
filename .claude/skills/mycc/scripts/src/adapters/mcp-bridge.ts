/**
 * MCP Bridge — 轻量 JSON-RPC over stdio 客户端
 *
 * 用于 Gemini function calling → 飞书 MCP 工具执行。
 * 单例模式：首次调用时 spawn MCP server，后续复用。
 *
 * 决策记录：2026-03-14
 * 原因：Gemini API 切换后丢失 MCP 工具调用能力，需要桥接
 */

import { spawn, type ChildProcess } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import type { FunctionDeclaration } from "@google/generative-ai";

// ── JSON-RPC 协议类型 ──

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface McpToolSchema {
  name: string;
  description?: string;
  inputSchema?: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
    [k: string]: unknown;
  };
}

// ── 单例 MCP 连接 ──

let mcpProcess: ChildProcess | null = null;
let requestId = 0;
let buffer = "";
const pendingRequests = new Map<
  number,
  { resolve: (v: JsonRpcResponse) => void; timer: ReturnType<typeof setTimeout> }
>();
let cachedTools: McpToolSchema[] | null = null;
let cachedGeminiDeclarations: FunctionDeclaration[] | null = null;
let initPromise: Promise<void> | null = null;

/** Gemini 能用的工具白名单（避免注册 50+ 工具导致 token 爆炸） */
const TOOL_WHITELIST = new Set([
  "create_document",
  "get_document",
  "get_document_raw_content",
  "convert_content_to_blocks",
  "create_blocks",
  "list_bitable_tables",
  "list_bitable_fields",
  "list_bitable_records",
  "create_bitable_record",
  "send_message",
  "list_chats",
  "feishu_openapi_call",
]);

/**
 * 读取 .mcp.json 获取飞书 MCP server 配置
 */
function getMcpConfig(): { command: string; args: string[] } {
  const mcpJsonPath = join(process.cwd(), ".mcp.json");
  try {
    const raw = readFileSync(mcpJsonPath, "utf-8");
    const config = JSON.parse(raw);
    const feishu = config.mcpServers?.["open-feishu-mcp"];
    if (!feishu) throw new Error("open-feishu-mcp 未在 .mcp.json 中配置");
    return { command: feishu.command, args: feishu.args || [] };
  } catch (err: any) {
    // 兜底：硬编码路径
    console.error(`[McpBridge] 读取 .mcp.json 失败: ${err.message}，使用默认配置`);
    return {
      command: "node",
      args: [
        "/Users/rayman.chen/mycc/open-feishu-mcp-server/dist/local.js",
        "--app-id", process.env.FEISHU_APP_ID || "",
        "--app-secret", process.env.FEISHU_APP_SECRET || "",
      ],
    };
  }
}

/**
 * 处理 MCP server 的 stdout 数据：解析 JSON-RPC 响应
 */
function handleStdout(data: Buffer): void {
  buffer += data.toString();

  // JSON-RPC messages are newline-delimited
  let newlineIdx: number;
  while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.substring(0, newlineIdx).trim();
    buffer = buffer.substring(newlineIdx + 1);

    if (!line) continue;

    try {
      const msg = JSON.parse(line) as JsonRpcResponse;
      if (msg.id !== undefined) {
        const pending = pendingRequests.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          pendingRequests.delete(msg.id);
          pending.resolve(msg);
        }
      }
      // Notifications (no id) are ignored
    } catch {
      // Non-JSON line, ignore (MCP server logging)
    }
  }
}

/**
 * 启动 MCP server 进程
 */
function spawnMcpServer(): void {
  if (mcpProcess && !mcpProcess.killed) return;

  const config = getMcpConfig();
  console.log(`[McpBridge] 启动飞书 MCP server: ${config.command} ${config.args.join(" ")}`);

  mcpProcess = spawn(config.command, config.args, {
    cwd: "/Users/rayman.chen/mycc",
    env: {
      ...process.env,
      // 确保不走代理
      NO_PROXY: [process.env.NO_PROXY || "", "*.feishu.cn", "*.larksuite.com"].filter(Boolean).join(","),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  mcpProcess.stdout?.on("data", handleStdout);
  mcpProcess.stderr?.on("data", (d: Buffer) => {
    // MCP server 日志输出到 stderr，转发但不阻塞
    const msg = d.toString().trim();
    if (msg) console.error(`[McpBridge][mcp-stderr] ${msg}`);
  });

  mcpProcess.on("close", (code) => {
    console.error(`[McpBridge] MCP server 进程退出 (code=${code})`);
    mcpProcess = null;
    cachedTools = null;
    cachedGeminiDeclarations = null;
    initPromise = null;

    // 清理所有 pending 请求
    for (const [id, pending] of pendingRequests) {
      clearTimeout(pending.timer);
      pending.resolve({
        jsonrpc: "2.0",
        id,
        error: { code: -1, message: "MCP server 进程退出" },
      });
    }
    pendingRequests.clear();
  });

  mcpProcess.on("error", (err) => {
    console.error(`[McpBridge] MCP server spawn 错误:`, err.message);
  });

  buffer = "";
}

/**
 * 发送 JSON-RPC 请求并等待响应
 */
function sendRequest(method: string, params?: Record<string, unknown>, timeoutMs = 60_000): Promise<JsonRpcResponse> {
  return new Promise((resolve) => {
    if (!mcpProcess || mcpProcess.killed || !mcpProcess.stdin) {
      resolve({
        jsonrpc: "2.0",
        id: -1,
        error: { code: -1, message: "MCP server 未启动" },
      });
      return;
    }

    const id = ++requestId;
    const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };

    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      resolve({
        jsonrpc: "2.0",
        id,
        error: { code: -2, message: `请求超时 (${timeoutMs / 1000}s)` },
      });
    }, timeoutMs);

    pendingRequests.set(id, { resolve, timer });

    try {
      mcpProcess.stdin.write(JSON.stringify(req) + "\n");
    } catch (err: any) {
      clearTimeout(timer);
      pendingRequests.delete(id);
      resolve({
        jsonrpc: "2.0",
        id,
        error: { code: -1, message: `写入失败: ${err.message}` },
      });
    }
  });
}

/**
 * 初始化 MCP 连接 + 握手 + 获取工具列表
 */
async function ensureInit(): Promise<void> {
  if (cachedTools) return;

  if (initPromise) return initPromise;

  initPromise = (async () => {
    spawnMcpServer();

    // MCP 协议握手: initialize
    console.log("[McpBridge] 发送 initialize 握手...");
    const initResp = await sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "gemini-mcp-bridge", version: "1.0.0" },
    });

    if (initResp.error) {
      throw new Error(`MCP 握手失败: ${initResp.error.message}`);
    }
    console.log("[McpBridge] 握手成功");

    // 发送 initialized 通知
    if (mcpProcess?.stdin) {
      mcpProcess.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"
      );
    }

    // 获取工具列表
    console.log("[McpBridge] 获取工具列表...");
    const toolsResp = await sendRequest("tools/list", {});
    if (toolsResp.error) {
      throw new Error(`获取工具列表失败: ${toolsResp.error.message}`);
    }

    const allMcpTools = (toolsResp.result as { tools: McpToolSchema[] })?.tools || [];
    console.log(`[McpBridge] 共 ${allMcpTools.length} 个工具，白名单过滤后保留 ${TOOL_WHITELIST.size} 个`);

    // 只保留白名单工具
    cachedTools = allMcpTools.filter((t) => TOOL_WHITELIST.has(t.name));
    cachedGeminiDeclarations = null; // 重新生成
  })();

  return initPromise;
}

/**
 * Gemini API 不支持的 JSON Schema 关键字（会导致 400 Bad Request）
 */
const UNSUPPORTED_KEYS = new Set([
  "propertyNames",
  "additionalProperties",
  "patternProperties",
  "$schema",
  "if",
  "then",
  "else",
  "oneOf",
  "anyOf",
  "allOf",
  "not",
  "default",
  "const",
  "examples",
  "$ref",
  "$id",
  "$comment",
  "minProperties",
  "maxProperties",
  "dependencies",
  "contentMediaType",
  "contentEncoding",
]);

/**
 * 递归清理 JSON Schema，移除 Gemini 不支持的关键字
 */
function sanitizeSchema(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeSchema);

  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (UNSUPPORTED_KEYS.has(key)) continue;
    cleaned[key] = sanitizeSchema(value);
  }
  return cleaned;
}

/**
 * 将 MCP 工具 JSON Schema → Gemini FunctionDeclaration
 *
 * Gemini SDK 的 parameters 格式兼容 OpenAPI 3.0 子集，
 * 但不支持完整 JSON Schema（如 additionalProperties、propertyNames 等）。
 * 需要递归清理不支持的关键字。
 */
function mcpToolToGeminiFn(tool: McpToolSchema): FunctionDeclaration {
  const params = tool.inputSchema
    ? sanitizeSchema({
        type: tool.inputSchema.type,
        properties: tool.inputSchema.properties || {},
        required: tool.inputSchema.required,
      })
    : undefined;

  return {
    name: tool.name,
    description: (tool.description || "").substring(0, 500),
    parameters: params as any,
  };
}

// ── 导出 API ──

/**
 * 获取 Gemini FunctionDeclaration 列表（白名单内的飞书 MCP 工具）
 */
export async function getGeminiFunctionDeclarations(): Promise<FunctionDeclaration[]> {
  await ensureInit();

  if (!cachedGeminiDeclarations) {
    cachedGeminiDeclarations = (cachedTools || []).map(mcpToolToGeminiFn);
    console.log(`[McpBridge] 生成 ${cachedGeminiDeclarations.length} 个 Gemini FunctionDeclaration`);
  }

  return cachedGeminiDeclarations;
}

/**
 * 执行 MCP 工具调用
 */
export async function callMcpTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ success: boolean; result: unknown }> {
  await ensureInit();

  console.log(`[McpBridge] 调用工具: ${toolName}`, JSON.stringify(args).substring(0, 200));

  const resp = await sendRequest("tools/call", {
    name: toolName,
    arguments: args,
  }, 120_000); // 工具调用给 2 分钟超时

  if (resp.error) {
    console.error(`[McpBridge] 工具调用失败: ${resp.error.message}`);
    return { success: false, result: { error: resp.error.message } };
  }

  // MCP 工具返回 { content: [{ type: "text", text: "..." }] }
  const content = (resp.result as { content?: Array<{ type: string; text?: string }> })?.content;
  const textParts = content?.filter((c) => c.type === "text").map((c) => c.text) || [];
  const resultText = textParts.join("\n");

  console.log(`[McpBridge] 工具返回: ${resultText.substring(0, 200)}`);

  // 尝试解析为 JSON
  try {
    return { success: true, result: JSON.parse(resultText) };
  } catch {
    return { success: true, result: resultText };
  }
}

/**
 * 关闭 MCP server 进程（清理资源）
 */
export function closeMcpBridge(): void {
  if (mcpProcess && !mcpProcess.killed) {
    console.log("[McpBridge] 关闭 MCP server");
    mcpProcess.kill("SIGTERM");
    setTimeout(() => mcpProcess?.kill("SIGKILL"), 3000);
  }
  mcpProcess = null;
  cachedTools = null;
  cachedGeminiDeclarations = null;
  initPromise = null;
  pendingRequests.clear();
}
