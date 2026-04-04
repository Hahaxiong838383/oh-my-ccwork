/**
 * mcp-client.ts — MCP Client 核心
 *
 * 通过 stdio transport 连接外部 MCP Server（spawn child process），
 * 实现 JSON-RPC 2.0 消息协议。
 *
 * 职责：
 *   - connect(): 启动 MCP Server 进程 + initialize 握手
 *   - listTools(): 获取可用工具列表
 *   - callTool(): 执行工具调用
 *   - disconnect(): 关闭连接
 */

import { spawn, type ChildProcess } from "child_process";

// ─── Types ───

/** MCP 工具定义（Server 返回的格式） */
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** JSON-RPC 2.0 请求 */
interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
  id?: number;
}

/** JSON-RPC 2.0 响应 */
interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** 工具调用结果中的内容块 */
interface McpContentBlock {
  type: string;
  text?: string;
}

/** 等待中的请求 */
interface PendingRequest {
  resolve: (value: JsonRpcResponse) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ─── McpClient ───

export class McpClient {
  private process: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private buffer = "";
  private connected = false;
  private readonly defaultTimeoutMs: number;

  /** Server 名称（用于日志和前缀） */
  readonly serverName: string;

  constructor(serverName: string, timeoutMs = 30_000) {
    this.serverName = serverName;
    this.defaultTimeoutMs = timeoutMs;
  }

  /** 是否已连接 */
  isConnected(): boolean {
    return this.connected && this.process !== null && this.process.exitCode === null;
  }

  /**
   * 启动 MCP Server 进程并完成 initialize 握手
   */
  async connect(
    command: string,
    args: string[],
    env?: Record<string, string>,
  ): Promise<void> {
    if (this.isConnected()) return;

    // 合并环境变量
    const mergedEnv = { ...process.env, ...env };

    this.process = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: mergedEnv,
    });

    // 监听 stdout，解析 JSON-RPC 消息
    this.process.stdout?.on("data", (chunk: Buffer) => {
      this.handleStdout(chunk.toString());
    });

    // stderr 仅打印警告
    this.process.stderr?.on("data", (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg) {
        console.warn(`[mcp:${this.serverName}:stderr] ${msg}`);
      }
    });

    // 进程退出时清理
    this.process.on("exit", (code) => {
      this.connected = false;
      // 拒绝所有等待中的请求
      for (const [id, req] of this.pending) {
        clearTimeout(req.timer);
        req.reject(new Error(`MCP Server "${this.serverName}" exited with code ${code}`));
      }
      this.pending.clear();
    });

    this.process.on("error", (err) => {
      console.error(`[mcp:${this.serverName}] process error: ${err.message}`);
      this.connected = false;
    });

    // 发送 initialize 请求
    const initResult = await this.sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "mycc-brain", version: "0.3.0" },
    });

    if (!initResult.result) {
      throw new Error(`MCP initialize failed for "${this.serverName}": ${JSON.stringify(initResult.error)}`);
    }

    // 发送 notifications/initialized（无 id，不等响应）
    this.sendNotification("notifications/initialized", {});

    this.connected = true;
    console.log(`[mcp:${this.serverName}] connected`);
  }

  /**
   * 获取 MCP Server 提供的工具列表
   */
  async listTools(): Promise<McpToolInfo[]> {
    this.ensureConnected();
    const resp = await this.sendRequest("tools/list", {});
    if (resp.error) {
      throw new Error(`tools/list failed: ${resp.error.message}`);
    }
    const result = resp.result as { tools?: McpToolInfo[] } | undefined;
    return result?.tools ?? [];
  }

  /**
   * 调用 MCP 工具
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    this.ensureConnected();
    const resp = await this.sendRequest("tools/call", {
      name,
      arguments: args,
    });
    if (resp.error) {
      throw new Error(`tools/call "${name}" failed: ${resp.error.message}`);
    }
    // 提取 content[0].text
    const result = resp.result as { content?: McpContentBlock[] } | undefined;
    const content = result?.content;
    if (Array.isArray(content) && content.length > 0) {
      // 拼接所有 text 类型的内容块
      return content
        .filter((block) => block.type === "text" && block.text)
        .map((block) => block.text!)
        .join("\n");
    }
    return JSON.stringify(result);
  }

  /**
   * 关闭连接
   */
  disconnect(): void {
    if (this.process) {
      this.process.stdin?.end();
      this.process.kill("SIGTERM");
      this.process = null;
    }
    this.connected = false;
    // 清理等待中的请求
    for (const [, req] of this.pending) {
      clearTimeout(req.timer);
      req.reject(new Error(`MCP Client "${this.serverName}" disconnected`));
    }
    this.pending.clear();
    this.buffer = "";
    console.log(`[mcp:${this.serverName}] disconnected`);
  }

  // ─── 内部方法 ───

  /** 确保已连接 */
  private ensureConnected(): void {
    if (!this.isConnected()) {
      throw new Error(`MCP Client "${this.serverName}" is not connected`);
    }
  }

  /** 发送 JSON-RPC 请求（有 id，等待响应） */
  private sendRequest(
    method: string,
    params: Record<string, unknown>,
  ): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      method,
      params,
      id,
    };

    return new Promise<JsonRpcResponse>((resolve, reject) => {
      // 超时处理
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out after ${this.defaultTimeoutMs}ms`));
      }, this.defaultTimeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.writeMessage(request);
    });
  }

  /** 发送 JSON-RPC 通知（无 id，不等响应） */
  private sendNotification(
    method: string,
    params: Record<string, unknown>,
  ): void {
    const notification: JsonRpcRequest = {
      jsonrpc: "2.0",
      method,
      params,
    };
    this.writeMessage(notification);
  }

  /** 写入消息到 stdin */
  private writeMessage(msg: JsonRpcRequest): void {
    if (!this.process?.stdin?.writable) {
      throw new Error(`MCP Client "${this.serverName}" stdin not writable`);
    }
    const raw = JSON.stringify(msg);
    // MCP 使用换行分隔的 JSON 消息
    this.process.stdin.write(raw + "\n");
  }

  /** 处理 stdout 数据，解析 JSON-RPC 响应 */
  private handleStdout(data: string): void {
    this.buffer += data;

    // 按换行分割，处理完整的 JSON 消息
    const lines = this.buffer.split("\n");
    // 最后一行可能不完整，保留在 buffer 中
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as JsonRpcResponse;
        this.handleResponse(msg);
      } catch {
        // 非 JSON 输出，忽略（可能是 Server 的 debug 日志）
      }
    }
  }

  /** 处理单条 JSON-RPC 响应 */
  private handleResponse(msg: JsonRpcResponse): void {
    // 通知类消息（无 id），忽略
    if (msg.id === undefined || msg.id === null) return;

    const pending = this.pending.get(msg.id);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pending.delete(msg.id);
    pending.resolve(msg);
  }
}
