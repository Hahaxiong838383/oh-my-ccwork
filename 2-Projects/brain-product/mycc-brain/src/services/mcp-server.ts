/**
 * mcp-server.ts — MCP (Model Context Protocol) Server
 *
 * 手写 JSON-RPC 2.0 over stdio 实现，不依赖第三方包。
 * 从 ToolRegistry 自动转换工具定义为 MCP 格式，
 * 支持 initialize / tools/list / tools/call 三个核心方法。
 */

import { createInterface } from "readline";
import type { ToolRegistry, ToolContext, ToolDefinition } from "./tool-registry.js";

// ─── MCP 协议常量 ───

const MCP_PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "mycc-brain";
const SERVER_VERSION = "0.3.0";

// ─── JSON-RPC 类型 ───

interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
  id?: string | number | null;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// ─── JSON-RPC 标准错误码 ───

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

// ─── MCP 工具格式 ───

interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface McpToolCallContent {
  type: "text";
  text: string;
}

interface McpToolCallResult {
  content: McpToolCallContent[];
  isError?: boolean;
}

// ─── zodToJsonSchema（复用 tool-registry 的逻辑，生成完整 JSON Schema）───

function zodToJsonSchema(schema: unknown): Record<string, unknown> {
  const def = (schema as any)?._zod?.def;
  if (!def) return { type: "object" };

  switch (def.type) {
    case "string":
      return { type: "string" };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "enum": {
      const values = Object.values(def.entries) as string[];
      return { type: "string", enum: values };
    }
    case "optional": {
      const inner = def.innerType;
      return inner ? zodToJsonSchema(inner) : {};
    }
    case "array": {
      const element = def.element;
      return { type: "array", items: element ? zodToJsonSchema(element) : {} };
    }
    case "object": {
      const shape = def.shape as Record<string, unknown> | undefined;
      if (!shape) return { type: "object", properties: {} };

      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      for (const [key, fieldSchema] of Object.entries(shape)) {
        const fieldDef = (fieldSchema as any)?._zod?.def;
        properties[key] = zodToJsonSchema(fieldSchema);
        if (fieldDef?.type !== "optional") {
          required.push(key);
        }
      }

      const result: Record<string, unknown> = { type: "object", properties };
      if (required.length > 0) result.required = required;
      return result;
    }
    default:
      return {};
  }
}

// ─── ToolRegistry → MCP 工具列表 ───

function registryToMcpTools(registry: ToolRegistry): McpToolDefinition[] {
  return registry.list().map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: zodToJsonSchema(tool.inputSchema),
  }));
}

// ─── MCP Server ───

export interface McpServerOptions {
  registry: ToolRegistry;
  toolContext: ToolContext;
}

export class McpServer {
  private readonly registry: ToolRegistry;
  private readonly toolContext: ToolContext;
  private initialized = false;

  constructor(opts: McpServerOptions) {
    this.registry = opts.registry;
    this.toolContext = opts.toolContext;
  }

  /** 启动 stdio transport，监听 stdin 逐行读取 JSON-RPC */
  start(): void {
    const rl = createInterface({ input: process.stdin, terminal: false });

    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      void this.handleLine(trimmed);
    });

    rl.on("close", () => {
      process.exit(0);
    });

    // 防止 stdout 写入报错导致崩溃
    process.stdout.on("error", () => {
      process.exit(1);
    });
  }

  /** 处理一行 JSON-RPC 输入 */
  private async handleLine(line: string): Promise<void> {
    let request: JsonRpcRequest;

    try {
      request = JSON.parse(line) as JsonRpcRequest;
    } catch {
      this.sendError(null, PARSE_ERROR, "Parse error: invalid JSON");
      return;
    }

    // 基本校验
    if (request.jsonrpc !== "2.0" || !request.method) {
      this.sendError(
        request.id ?? null,
        INVALID_REQUEST,
        "Invalid request: missing jsonrpc or method",
      );
      return;
    }

    // 通知（无 id）不需要回复
    const isNotification = request.id === undefined || request.id === null;

    try {
      const result = await this.dispatch(request);

      // 通知不回复
      if (isNotification) return;

      this.sendResult(request.id!, result);
    } catch (err: unknown) {
      if (isNotification) return;

      if (err instanceof JsonRpcException) {
        this.sendError(request.id!, err.code, err.message, err.data);
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        this.sendError(request.id!, INTERNAL_ERROR, msg);
      }
    }
  }

  /** 方法路由 */
  private async dispatch(request: JsonRpcRequest): Promise<unknown> {
    const { method, params } = request;

    switch (method) {
      case "initialize":
        return this.handleInitialize(params ?? {});

      case "notifications/initialized":
        // 客户端确认初始化完成，不需要回复
        this.initialized = true;
        return undefined;

      case "tools/list":
        this.ensureInitialized();
        return this.handleToolsList();

      case "tools/call":
        this.ensureInitialized();
        return this.handleToolsCall(params ?? {});

      case "ping":
        return {};

      default:
        throw new JsonRpcException(METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  // ─── 方法处理器 ───

  /** initialize: 返回 server info + capabilities */
  private handleInitialize(
    _params: Record<string, unknown>,
  ): Record<string, unknown> {
    this.initialized = true;
    return {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
    };
  }

  /** tools/list: 列出所有已注册工具 */
  private handleToolsList(): { tools: McpToolDefinition[] } {
    return { tools: registryToMcpTools(this.registry) };
  }

  /** tools/call: 执行指定工具 */
  private async handleToolsCall(
    params: Record<string, unknown>,
  ): Promise<McpToolCallResult> {
    const toolName = params.name as string | undefined;
    if (!toolName) {
      throw new JsonRpcException(INVALID_PARAMS, "Missing required param: name");
    }

    const tool: ToolDefinition | undefined = this.registry.get(toolName);
    if (!tool) {
      throw new JsonRpcException(
        INVALID_PARAMS,
        `Tool not found: ${toolName}`,
      );
    }

    const rawArgs = (params.arguments ?? {}) as Record<string, unknown>;

    try {
      // 用 zod 校验输入
      const validatedInput = tool.inputSchema.parse(rawArgs);

      // 执行工具（带超时）
      const output = await this.executeWithTimeout(tool, validatedInput);

      // 返回结果
      const text = typeof output === "string"
        ? output
        : JSON.stringify(output, null, 2);

      return {
        content: [{ type: "text", text }],
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `工具执行失败: ${msg}` }],
        isError: true,
      };
    }
  }

  // ─── 辅助方法 ───

  /** 带超时的工具执行 */
  private async executeWithTimeout(
    tool: ToolDefinition,
    input: unknown,
  ): Promise<unknown> {
    const timeoutMs = tool.timeoutMs || 30_000;

    return Promise.race([
      tool.execute(input, this.toolContext),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`工具 "${tool.name}" 执行超时 (${timeoutMs}ms)`)),
          timeoutMs,
        ),
      ),
    ]);
  }

  /** 确保已初始化 */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new JsonRpcException(INTERNAL_ERROR, "Server not initialized");
    }
  }

  /** 发送成功响应 */
  private sendResult(id: string | number, result: unknown): void {
    const response: JsonRpcResponse = {
      jsonrpc: "2.0",
      id,
      result: result ?? {},
    };
    this.send(response);
  }

  /** 发送错误响应 */
  private sendError(
    id: string | number | null,
    code: number,
    message: string,
    data?: unknown,
  ): void {
    const error: JsonRpcError = { code, message };
    if (data !== undefined) error.data = data;

    const response: JsonRpcResponse = {
      jsonrpc: "2.0",
      id,
      error,
    };
    this.send(response);
  }

  /** 写入 stdout（line-delimited JSON） */
  private send(response: JsonRpcResponse): void {
    const line = JSON.stringify(response);
    process.stdout.write(line + "\n");
  }
}

// ─── JSON-RPC 异常 ───

class JsonRpcException extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}
