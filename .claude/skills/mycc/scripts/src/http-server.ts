/**
 * HTTP 服务器
 * 提供 REST API 供小程序调用
 */

import http from "http";
import https from "https";
import os from "os";
import { join } from "path";
import { readFileSync, existsSync } from "fs";
import { generateToken } from "./utils.js";
import { adapter } from "./adapters/index.js";
import type { PairState } from "./types.js";
import { validateImages, type ImageData } from "./image-utils.js";
import { renameSession } from "./history.js";
import { getOrBuildIndex, searchBM25 } from "./bm25.js";
import { listSkills } from "./skills.js";
import { ChannelManager, WebChannel, FeishuChannel } from "./channels/index.js";
import { loadConfig } from "./config.js";
import type { DeviceConfig } from "./types.js";

const PORT = process.env.PORT || 18080;

export interface TlsConfig {
  certPath: string;
  keyPath: string;
}

// 配对速率限制：每 IP 5 次失败后锁定 5 分钟
const PAIR_MAX_ATTEMPTS = 5;
const PAIR_LOCK_MS = 5 * 60 * 1000;
const pairAttempts = new Map<string, { count: number; lockedUntil: number }>();

/** 测试用：重置速率限制状态 */
export function _resetPairAttempts() { pairAttempts.clear(); }

export class HttpServer {
  private server: http.Server | https.Server;
  private state: PairState;
  private cwd: string;
  private onPaired?: (token: string) => void;
  private isTls: boolean;
  private channelManager: ChannelManager;
  private currentSessionId: string | null = null; // 保存当前活跃会话 ID
  private feishuChannel: FeishuChannel | null = null; // 保存飞书通道实例

  constructor(pairCode: string, cwd: string, authToken?: string, tls?: TlsConfig) {
    this.cwd = cwd;
    // 如果传入了 authToken，说明之前已配对过
    this.state = {
      pairCode,
      paired: !!authToken,
      token: authToken || null,
    };

    // 初始化通道管理器
    this.channelManager = new ChannelManager();

    // 注册飞书通道（如果配置了环境变量）
    if (process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET) {
      this.feishuChannel = new FeishuChannel();
      // 设置飞书消息回调
      this.feishuChannel.onMessage(async (message: string, images?: Array<{ data: string; mediaType: string }>) => {
        await this.processFeishuMessage(message, images);
      });
      this.channelManager.register(this.feishuChannel);
      console.log("[Channels] 飞书通道已注册（启动时将激活）");
    } else {
      console.log("[Channels] 飞书通道未配置（设置 FEISHU_APP_ID 和 FEISHU_APP_SECRET 环境变量以启用）");
    }

    const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
      this.handleRequest(req, res);
    };

    // 如果提供了 TLS 证书，使用 HTTPS
    if (tls && existsSync(tls.certPath) && existsSync(tls.keyPath)) {
      this.server = https.createServer({
        cert: readFileSync(tls.certPath),
        key: readFileSync(tls.keyPath),
      }, handler);
      this.isTls = true;
    } else {
      this.server = http.createServer(handler);
      this.isTls = false;
    }
  }

  /** 设置配对成功回调（用于持久化 authToken） */
  setOnPaired(callback: (token: string) => void) {
    this.onPaired = callback;
  }

  /** 获取当前 authToken */
  getAuthToken(): string | null {
    return this.state.token;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://localhost:${PORT}`);

    try {
      if (url.pathname === "/health" && req.method === "GET") {
        this.handleHealth(res);
      } else if (url.pathname === "/pair" && req.method === "POST") {
        await this.handlePair(req, res);
      } else if (url.pathname === "/chat" && req.method === "POST") {
        await this.handleChat(req, res);
      } else if (url.pathname === "/history/list" && req.method === "GET") {
        await this.handleHistoryList(req, res);
      } else if (url.pathname.startsWith("/history/") && req.method === "GET") {
        await this.handleHistoryDetail(req, res, url.pathname);
      } else if (url.pathname === "/chat/rename" && req.method === "POST") {
        await this.handleRename(req, res);
      } else if (url.pathname === "/skills/list" && req.method === "GET") {
        await this.handleSkillsList(req, res, url);
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not Found" }));
      }
    } catch (error) {
      console.error("[HTTP] Error:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal Server Error" }));
    }
  }

  private handleHealth(res: http.ServerResponse) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", paired: this.state.paired, hostname: os.hostname() }));
  }

  private async handlePair(req: http.IncomingMessage, res: http.ServerResponse) {
    // 速率限制检查
    const ip = req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
    const record = pairAttempts.get(ip);
    if (record && Date.now() < record.lockedUntil) {
      const waitSec = Math.ceil((record.lockedUntil - Date.now()) / 1000);
      console.log(`[Pair] IP ${ip} 被锁定，剩余 ${waitSec}s`);
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `请求过于频繁，请 ${waitSec} 秒后重试` }));
      return;
    }

    const body = await this.readBody(req);
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }
    const { pairCode } = parsed;

    if (pairCode !== this.state.pairCode) {
      // 记录失败次数
      const attempts = record || { count: 0, lockedUntil: 0 };
      attempts.count++;
      if (attempts.count >= PAIR_MAX_ATTEMPTS) {
        attempts.lockedUntil = Date.now() + PAIR_LOCK_MS;
        attempts.count = 0;
        console.log(`[Pair] IP ${ip} 失败 ${PAIR_MAX_ATTEMPTS} 次，锁定 5 分钟`);
      }
      pairAttempts.set(ip, attempts);

      console.log(`[Pair] 配对失败: 配对码错误 (${attempts.count}/${PAIR_MAX_ATTEMPTS})`);
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "配对码错误" }));
      return;
    }

    // 配对成功，清除该 IP 的失败记录
    pairAttempts.delete(ip);

    // 如果已配对，返回相同 token（不覆盖）
    if (this.state.paired && this.state.token) {
      console.log("[Pair] 重复配对，返回现有 token");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, token: this.state.token }));
      return;
    }

    // 首次配对，生成 token
    const token = generateToken();
    this.state.paired = true;
    this.state.token = token;

    console.log("[Pair] 首次配对成功");

    // 通知外部保存 authToken
    if (this.onPaired) {
      this.onPaired(token);
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, token }));
  }

  private async handleChat(req: http.IncomingMessage, res: http.ServerResponse) {
    // 验证 token
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace("Bearer ", "");

    if (!this.state.paired || token !== this.state.token) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "未授权" }));
      return;
    }

    const body = await this.readBody(req);
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }
    const { message, sessionId, images, model } = parsed as {
      message: string;
      sessionId?: string;
      images?: ImageData[];
      model?: string;
    };

    // 校验图片
    const imageValidation = validateImages(images);
    if (!imageValidation.valid) {
      res.writeHead(imageValidation.code || 400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: imageValidation.error }));
      return;
    }

    const hasImages = images && images.length > 0;
    console.log(`[CC] 收到消息: ${message.substring(0, 50)}...${hasImages ? ` (附带 ${images.length} 张图片)` : ""}`);

    // 设置 SSE 响应头
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });

    // 创建 Web 通道
    const webChannel = new WebChannel({ res });
    // 注册 Web 通道（使用唯一 ID，因为每个请求都有独立的响应）
    const webChannelId = `web-${Date.now()}-${Math.random()}`;
    Object.defineProperty(webChannel, 'id', { value: webChannelId, writable: false });
    this.channelManager.register(webChannel);

    let currentSessionId = sessionId;

    try {
      // 使用 adapter 的 chat 方法（返回 AsyncIterable）
      for await (const data of adapter.chat({ message, sessionId, cwd: this.cwd, images, model: model || undefined })) {
        // 提取 session_id
        if (data && typeof data === "object" && "type" in data) {
          if (data.type === "system" && "session_id" in data) {
            currentSessionId = data.session_id as string;
            // 保存到全局变量，供飞书通道复用
            this.currentSessionId = currentSessionId;
            webChannel.setSessionId(currentSessionId);
          }
        }

        // 只发送到 Web 通道，不广播到飞书
        await webChannel.send(data);
      }

      // 完成 - 发送完成事件到 Web 通道
      await webChannel.send({ type: "done", sessionId: currentSessionId } as any);

      // 注销 Web 通道
      this.channelManager.unregister(webChannelId);

      // 结束 SSE 响应
      res.end();
      console.log(`[CC] 完成`);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);

      // 只发送错误到 Web 通道，不广播到飞书
      try {
        await webChannel.send({ type: "error", error: errMsg } as any);
      } catch {
        // 忽略发送错误
      }

      // 确保注销 Web 通道
      this.channelManager.unregister(webChannelId);

      res.end();
      console.error(`[CC] 错误: ${errMsg}`);
    }
  }

  /**
   * 处理飞书收到的消息
   * 由飞书通道的 WebSocket 回调调用
   *
   * 支持命令系统和普通对话：
   * - 命令以 / 开头，如 /new, /sessions, /switch, /help
   * - 普通消息会使用当前活跃会话（如果有）
   */
  private async processFeishuMessage(message: string, images?: Array<{ data: string; mediaType: string }>): Promise<void> {
    console.log(`[CC] 收到飞书消息: ${message.substring(0, 50)}...${images ? ` [${images.length} 张图片]` : ""}`);

    const trimmedMessage = message.trim();

    // 检查是否是命令（以 / 开头）
    if (trimmedMessage.startsWith("/")) {
      await this.handleFeishuCommand(trimmedMessage);
      return;
    }

    // 检查是否是运维关键字（不带 / 前缀）
    if (this.isOperationCommand(trimmedMessage)) {
      await this.handleOperationCommand(trimmedMessage);
      return;
    }

    // 普通对话：检查是否有活跃会话
    if (!this.currentSessionId) {
      console.log(`[CC] 无活跃会话，尝试自动选择最近的历史会话`);

      // 尝试获取历史会话
      try {
        const result = await adapter.listHistory(this.cwd, 1);
        if (result.conversations.length > 0) {
          // 自动选择最近的一个会话
          const latestSession = result.conversations[0];
          this.currentSessionId = latestSession.sessionId;

          const title = latestSession.customTitle || latestSession.firstPrompt?.substring(0, 30) || "历史会话";
          const timeAgo = this.formatTimeAgo(latestSession.lastTime || latestSession.modified || Date.now());

          console.log(`[CC] 自动选择会话: ${this.currentSessionId} (${title})`);

          // 通知用户已自动选择会话
          await this.sendToFeishu(`✅ 自动使用最近的会话：${title}\n🕒 ${timeAgo}\n\n继续你的对话...`);
        } else {
          // 没有任何历史会话，显示帮助信息
          console.log(`[CC] 没有历史会话，显示帮助信息`);
          const hintMessage = "💡 还没有会话记录。\n\n" +
                             "• 发送任意消息开始新对话\n" +
                             "• 发送 /help 查看所有命令";
          await this.sendToFeishu(hintMessage);
          return;
        }
      } catch (err) {
        console.error(`[CC] 获取历史会话失败:`, err);
        await this.sendToFeishu("❌ 无法加载历史会话，请重试或发送 /new 创建新会话。");
        return;
      }
    }

    console.log(`[CC] 使用当前会话: ${this.currentSessionId}`);

    try {
      // 使用 adapter 处理消息（流式发送，不累积）
      for await (const data of adapter.chat({
        message: trimmedMessage,
        sessionId: this.currentSessionId,
        cwd: this.cwd,
        images: images,
      })) {
        // 更新 session_id（如果返回了新的）
        if (data && typeof data === "object") {
          if (data.type === "system" && "session_id" in data) {
            this.currentSessionId = data.session_id as string;
            console.log(`[CC] 会话已更新: ${this.currentSessionId}`);
          }
          // v1 SDK: text 事件 - 立即发送文本
          if (data.type === "text" && data.text) {
            const text = String(data.text);
            console.log(`[CC] 发送文本: ${text.substring(0, 30)}...`);
            await this.sendToFeishu(text);
          }
          // v2 SDK: assistant 事件 - 按 content 数组顺序逐条发送
          else if (data.type === "assistant") {
            const assistantEvent = data as any;
            if (assistantEvent.message?.content) {
              for (const block of assistantEvent.message.content) {
                if (block.type === "text" && block.text) {
                  // 立即发送文本
                  const text = String(block.text);
                  console.log(`[CC] 发送文本: ${text.substring(0, 30)}...`);
                  await this.sendToFeishu(text);
                } else if (block.type === "tool_use") {
                  // 立即发送工具调用
                  const name = block.name || "unknown";
                  let toolCallText = `🔧 **使用工具: ${name}**`;
                  if (block.input && Object.keys(block.input).length > 0) {
                    const inputStr = JSON.stringify(block.input, null, 2);
                    if (inputStr.length > 300) {
                      toolCallText += `\n\`\`\`\n${inputStr.substring(0, 300)}...\n\`\`\``;
                    } else {
                      toolCallText += `\n\`\`\`\n${inputStr}\n\`\`\``;
                    }
                  }
                  console.log(`[CC] 发送工具调用: ${name}`);
                  await this.sendToFeishu(toolCallText);
                }
              }
            }
          }
        }
      }
    } catch (err) {
      console.error(`[CC] 处理飞书消息错误:`, err);
      await this.sendToFeishu("❌ 处理消息时出错，请重试。");
    } finally {
      // 任务完成后删除"正在输入"表态
      if (this.feishuChannel) {
        await this.feishuChannel.clearTypingIndicator();
      }
    }
  }

  /**
   * 处理飞书命令
   */
  private async handleFeishuCommand(command: string): Promise<void> {
    const parts = command.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    console.log(`[CC] 处理飞书命令: ${cmd}`);

    try {
      switch (cmd) {
        case "/new":
        case "/create":
          await this.handleNewSession(args.join(" "));
          break;

        case "/sessions":
        case "/list":
        case "/history":
          await this.handleListSessions();
          break;

        case "/switch":
          await this.handleSwitchSession(args[0]);
          break;

        case "/current":
          await this.handleCurrentSession();
          break;

        case "/device":
        case "/devices":
          await this.handleDevice();
          break;

        case "/help":
        case "/?":
          await this.handleHelp();
          break;

        case "/搜索":
        case "/search":
          await this.handleSearch(args.join(" "));
          break;

        default:
          await this.sendToFeishu(`❓ 未知命令: ${cmd}\n\n发送 /help 查看可用命令。`);
      }
    } catch (err) {
      console.error(`[CC] 命令处理错误:`, err);
      await this.sendToFeishu(`❌ 执行命令时出错: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 检查是否是运维命令（不带 / 前缀）
   */
  private isOperationCommand(message: string): boolean {
    const opCommands = [
      "重启mycc", "重启mycc后端", "重启后端",
      "重启", "停止", "停止mycc",
      "状态", "状态查询", "查看状态",
      "启动mycc", "启动后端"
    ];
    return opCommands.some(cmd => message.includes(cmd));
  }

  /**
   * 处理运维命令（不带 / 前缀）
   */
  private async handleOperationCommand(message: string): Promise<void> {
    console.log(`[CC] 处理运维命令: ${message}`);

    const lowerMessage = message.toLowerCase();

    try {
      if (lowerMessage.includes("重启") || lowerMessage.includes("启动")) {
        await this.handleRestart();
      } else if (lowerMessage.includes("停止")) {
        await this.handleStop();
      } else if (lowerMessage.includes("状态")) {
        await this.handleStatus();
      } else {
        await this.sendToFeishu(`❓ 无法识别运维命令: ${message}`);
      }
    } catch (err) {
      console.error(`[CC] 运维命令处理错误:`, err);
      await this.sendToFeishu(`❌ 执行运维命令时出错: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 处理重启命令
   */
  private async handleRestart(): Promise<void> {
    await this.sendToFeishu("🔄 正在重启 mycc 后端...");

    try {
      // 杀掉当前进程
      const { execSync } = await import("child_process");
      execSync("lsof -i :18080 -t | xargs kill 2>/dev/null", { stdio: "ignore" });

      await this.sendToFeishu("✅ 已停止旧进程");

      // 延迟一下再启动新进程
      await new Promise(resolve => setTimeout(resolve, 2000));

      // 启动新进程
      const { spawn } = await import("child_process");
      spawn("npx", ["tsx", "./.claude/skills/mycc/scripts/src/index.ts", "start"], {
        cwd: process.cwd(),
        detached: true,
        stdio: "ignore"
      }).unref();

      await this.sendToFeishu("✅ 已启动新进程，请稍候...");
    } catch (err) {
      console.error("[CC] 重启失败:", err);
      await this.sendToFeishu(`❌ 重启失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 处理停止命令
   */
  private async handleStop(): Promise<void> {
    await this.sendToFeishu("🔄 正在停止 mycc 后端...");

    try {
      const { execSync } = await import("child_process");
      execSync("lsof -i :18080 -t | xargs kill 2>/dev/null", { stdio: "ignore" });

      await this.sendToFeishu("✅ mycc 后端已停止");
    } catch (err) {
      console.error("[CC] 停止失败:", err);
      await this.sendToFeishu(`❌ 停止失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 处理状态查询命令
   */
  private async handleStatus(): Promise<void> {
    try {
      const { execSync } = await import("child_process");
      const pid = execSync("lsof -i :18080 -t 2>/dev/null", { encoding: "utf8" }).trim();

      if (pid) {
        const status = execSync(`ps -p ${pid} -o pid,etime,comm 2>/dev/null`, { encoding: "utf8" });
        await this.sendToFeishu(`✅ mycc 后端运行中\n\n\`\`\`\n${status}\n\`\`\``);
      } else {
        await this.sendToFeishu("❌ mycc 后端未运行");
      }
    } catch {
      await this.sendToFeishu("❌ mycc 后端未运行");
    }
  }

  /**
   * 创建新会话
   */
  private async handleNewSession(title?: string): Promise<void> {
    console.log(`[CC] 创建新会话${title ? `: ${title}` : ''}`);

    try {
      const replyParts: string[] = [];
      let newSessionId: string | undefined;
      let sessionTitle: string | undefined;

      // 不传递 sessionId，让 adapter 创建新会话
      for await (const data of adapter.chat({
        message: title || "开始新对话",
        cwd: this.cwd,
      })) {
        if (data && typeof data === "object") {
          if (data.type === "system" && "session_id" in data) {
            this.currentSessionId = data.session_id as string;
            newSessionId = data.session_id as string;
            console.log(`[CC] 新会话已创建: ${this.currentSessionId}`);
          }
          if (data.type === "text" && data.text) {
            replyParts.push(String(data.text));
          } else if (data.type === "assistant") {
            const assistantEvent = data as any;
            if (assistantEvent.message?.content) {
              for (const block of assistantEvent.message.content) {
                if (block.type === "text" && block.text) {
                  replyParts.push(String(block.text));
                }
              }
            }
          }
        }
      }

      // 构建会话信息响应
      let response = "";
      if (newSessionId) {
        response = `✅ 新会话已创建\n\n`;
        response += `📌 会话 ID: ${newSessionId}\n`;
        if (title) {
          response += `📝 标题: ${title}\n`;
          sessionTitle = title;
        }
        response += `\n`;
      }

      if (replyParts.length > 0) {
        response += replyParts.join("").trim();
      } else if (newSessionId) {
        response += `💡 现在发送的消息将使用此会话。`;
      }

      await this.sendToFeishu(response);
    } catch (err) {
      console.error(`[CC] 创建会话错误:`, err);
      await this.sendToFeishu("❌ 创建会话失败，请重试。");
    }
  }

  /**
   * 列出历史会话
   */
  private async handleListSessions(): Promise<void> {
    console.log(`[CC] 列出历史会话`);

    try {
      const result = await adapter.listHistory(this.cwd, 10);
      const conversations = result.conversations;

      // 调试：打印第一个会话的完整结构
      if (conversations.length > 0) {
        console.log(`[DEBUG] 第一个会话数据:`, JSON.stringify(conversations[0], null, 2));
      }

      if (conversations.length === 0) {
        await this.sendToFeishu("📋 还没有历史会话。\n\n发送 /new 创建第一个会话。");
        return;
      }

      let output = `📋 历史会话 (共 ${result.total} 个，显示最近 ${conversations.length} 个)\n\n`;

      conversations.forEach((conv, index) => {
        const isCurrent = conv.sessionId === this.currentSessionId ? " [当前]" : "";

        // 尝试从多个字段获取标题
        let title = "未命名会话";
        if (conv.customTitle) {
          title = conv.customTitle;
        } else if (conv.firstPrompt) {
          title = conv.firstPrompt.substring(0, 30);
        } else if (conv.lastMessagePreview) {
          title = conv.lastMessagePreview.substring(0, 30);
        }

        const timeAgo = this.formatTimeAgo(conv.lastTime || conv.modified || Date.now());
        output += `${index + 1}. ${title}${isCurrent}\n`;
        output += `   🕒 ${timeAgo}\n\n`;
      });

      output += `💡 使用 /switch <序号> 切换到某个会话`;

      await this.sendToFeishu(output);
    } catch (err) {
      console.error(`[CC] 获取会话列表错误:`, err);
      await this.sendToFeishu("❌ 获取会话列表失败，请重试。");
    }
  }

  /**
   * 切换到指定会话
   */
  private async handleSwitchSession(target: string | undefined): Promise<void> {
    console.log(`[CC] 切换会话: ${target}`);

    if (!target) {
      await this.sendToFeishu("❓ 请指定要切换的会话序号。\n\n使用 /sessions 查看所有会话。");
      return;
    }

    try {
      const result = await adapter.listHistory(this.cwd, 50);
      const conversations = result.conversations;

      // 解析目标序号
      const index = parseInt(target, 10) - 1;
      if (isNaN(index) || index < 0 || index >= conversations.length) {
        await this.sendToFeishu(`❓ 无效的序号: ${target}\n\n使用 /sessions 查看有效序号。`);
        return;
      }

      const targetSession = conversations[index];

      if (targetSession.sessionId === this.currentSessionId) {
        const title = targetSession.customTitle || targetSession.firstPrompt?.substring(0, 30) || "未命名";
        await this.sendToFeishu(`ℹ️ 已经在这个会话中了：${title}`);
        return;
      }

      // 切换会话
      this.currentSessionId = targetSession.sessionId;
      const title = targetSession.customTitle || targetSession.firstPrompt?.substring(0, 30) || "未命名";
      const timeAgo = this.formatTimeAgo(targetSession.lastTime || targetSession.modified || Date.now());

      await this.sendToFeishu(
        `✅ 已切换到会话：${title}\n\n` +
        `🕒 最后更新: ${timeAgo}\n\n` +
        `💡 现在发送的消息将使用这个会话。`
      );
    } catch (err) {
      console.error(`[CC] 切换会话错误:`, err);
      await this.sendToFeishu("❌ 切换会话失败，请重试。");
    }
  }

  /**
   * 显示当前会话信息
   */
  private async handleCurrentSession(): Promise<void> {
    console.log(`[CC] 显示当前会话`);

    if (!this.currentSessionId) {
      await this.sendToFeishu("ℹ️ 当前没有活跃的会话。\n\n使用 /new 创建会话，或 /sessions 选择一个历史会话。");
      return;
    }

    try {
      const conversation = await adapter.getHistory(this.cwd, this.currentSessionId);

      if (!conversation) {
        await this.sendToFeishu("❌ 当前会话不存在。\n\n使用 /new 创建新会话。");
        return;
      }

      // 从 messages 中提取标题和时间
      let title = "未命名会话";
      let firstMessageTime: string | undefined;
      let lastMessageTime: string | undefined;

      for (const msg of conversation.messages) {
        if (msg.type === "custom-title" && msg.customTitle) {
          title = msg.customTitle;
        }
        // 尝试从消息中提取时间（如果有的话）
        if (msg.timestamp) {
          if (!firstMessageTime) firstMessageTime = msg.timestamp;
          lastMessageTime = msg.timestamp;
        }
      }

      // 如果没有自定义标题，使用第一条用户消息作为标题
      if (title === "未命名会话") {
        const firstUserMsg = conversation.messages.find(m => m.type === "user" && m.message);
        if (firstUserMsg?.message?.content) {
          const content = firstUserMsg.message.content;
          // content 可能是字符串或对象数组
          if (typeof content === "string") {
            title = content.substring(0, 30);
          } else if (Array.isArray(content)) {
            // 查找第一个 text 类型的 block
            const textBlock = content.find((b: any) => b.type === "text" && b.text);
            if (textBlock) {
              title = textBlock.text.substring(0, 30);
            }
          }
        }
      }

      const timeStr = lastMessageTime ? this.formatTimeAgo(lastMessageTime) : "未知";
      const msgCount = conversation.messages.length;

      await this.sendToFeishu(
        `📌 当前会话信息\n\n` +
        `标题: ${title}\n` +
        `ID: ${conversation.sessionId}\n` +
        `消息数: ${msgCount}\n` +
        `最后活动: ${timeStr}`
      );
    } catch (err) {
      console.error(`[CC] 获取会话信息错误:`, err);
      await this.sendToFeishu("❌ 获取会话信息失败，请重试。");
    }
  }

  /**
   * 显示设备信息
   */
  private async handleDevice(): Promise<void> {
    console.log("[CC] 查询设备信息");

    try {
      const config = loadConfig(this.cwd) as DeviceConfig;

      if (!config) {
        await this.sendToFeishu("❌ 未找到设备配置");
        return;
      }

      const createdAt = new Date(config.createdAt);
      const createdTimeStr = createdAt.toLocaleString("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });

      let output = "📱 当前设备信息\n\n";
      output += `设备 ID: ${config.deviceId}\n`;
      output += `配对码: ${config.pairCode}\n`;

      if (config.routeToken) {
        output += `连接码: ${config.routeToken}\n`;
      }

      if (config.authToken) {
        output += `状态: ✅ 已配对\n`;
      } else {
        output += `状态: ⏳ 未配对\n`;
      }

      output += `\n创建时间: ${createdTimeStr}`;

      await this.sendToFeishu(output);
    } catch (err) {
      console.error(`[CC] 获取设备信息错误:`, err);
      await this.sendToFeishu("❌ 获取设备信息失败，请重试。");
    }
  }

  /**
   * 显示帮助信息
   */
  private async handleHelp(): Promise<void> {
    const helpText =
      "📖 飞书命令帮助\n\n" +
      "**会话管理**\n" +
      "/new [标题] - 创建新会话\n" +
      "/sessions - 查看历史会话\n" +
      "/switch <序号> - 切换到某个会话\n" +
      "/search <关键词> - 搜索历史会话\n" +
      "/current - 显示当前会话信息\n\n" +
      "**设备管理**\n" +
      "/device - 查看当前设备信息\n\n" +
      "**其他**\n" +
      "/help - 显示此帮助信息\n\n" +
      "**示例**\n" +
      "/new 分析代码\n" +
      "/sessions\n" +
      "/switch 1\n" +
      "/device\n\n" +
      "💡 提示：非命令消息会发送到当前活跃会话";

    await this.sendToFeishu(helpText);
  }

  /**
   * 搜索历史会话（BM25 关键词检索）
   */
  private async handleSearch(query: string): Promise<void> {
    const trimmedQuery = query?.trim();
    if (!trimmedQuery) {
      await this.sendToFeishu(
        "🔍 用法: /搜索 <关键词>\n\n" +
        "示例: /搜索 IPO报告\n" +
        "      /搜索 飞书机器人配置"
      );
      return;
    }

    console.log(`[CC] 搜索历史会话: ${trimmedQuery}`);

    try {
      // 获取当前项目路径
      const projectDir = this.cwd;

      // 构建/获取 BM25 索引
      const index = getOrBuildIndex(projectDir);

      if (index.N === 0) {
        await this.sendToFeishu("📭 暂无历史会话记录");
        return;
      }

      // 执行搜索
      const results = searchBM25(trimmedQuery, index, 10);

      if (results.length === 0) {
        await this.sendToFeishu(`🔍 没有找到包含 "${trimmedQuery}" 的历史会话`);
        return;
      }

      // 格式化结果
      let response = `🔍 搜索 "${trimmedQuery}" 找到 ${results.length} 个相关会话:\n\n`;

      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const preview = r.preview.length > 60 ? r.preview.substring(0, 60) + "..." : r.preview;
        response += `${i + 1}. ${preview}\n`;
        response += `   └ 会话ID: ${r.sessionId}\n\n`;
      }

      response += "💡 回复 [序号] 可切换到对应会话";

      await this.sendToFeishu(response);
    } catch (err) {
      console.error(`[CC] 搜索出错:`, err);
      await this.sendToFeishu(`❌ 搜索失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 发送消息到飞书
   */
  private async sendToFeishu(text: string): Promise<void> {
    await this.channelManager.broadcast({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
      },
    } as any);
  }

  /**
   * 格式化时间显示
   */
  private formatTimeAgo(timestamp: string | number): string {
    const now = Date.now();
    const time = typeof timestamp === "string" ? new Date(timestamp).getTime() : timestamp;
    const diff = now - time;

    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return "刚刚";
    if (minutes < 60) return `${minutes}分钟前`;
    if (hours < 24) return `${hours}小时前`;
    if (days < 7) return `${days}天前`;

    const date = new Date(time);
    return `${date.getMonth() + 1}/${date.getDate()}`;
  }

  private async handleHistoryList(req: http.IncomingMessage, res: http.ServerResponse) {
    // 验证 token
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace("Bearer ", "");

    if (!this.state.paired || token !== this.state.token) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "未授权" }));
      return;
    }

    try {
      // 解析 limit 参数（默认 20，传 0 或不传数字则返回全部）
      const url = new URL(req.url || "", `http://${req.headers.host}`);
      const limitParam = url.searchParams.get("limit");
      const limit = limitParam ? parseInt(limitParam, 10) : 20;

      // 使用 adapter 的 listHistory 方法
      const result = await adapter.listHistory(this.cwd, limit);

      console.log(`[History] 返回 ${result.conversations.length}/${result.total} 条历史记录 (cwd: ${this.cwd})`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (error) {
      console.error("[History] List error:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "获取历史记录失败" }));
    }
  }

  private async handleHistoryDetail(req: http.IncomingMessage, res: http.ServerResponse, pathname: string) {
    // 验证 token
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace("Bearer ", "");

    if (!this.state.paired || token !== this.state.token) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "未授权" }));
      return;
    }

    // 提取 sessionId: /history/{sessionId}
    const sessionId = pathname.replace("/history/", "");

    if (!sessionId || sessionId === "list") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "无效的 sessionId" }));
      return;
    }

    try {
      // 使用 adapter 的 getHistory 方法
      const conversation = await adapter.getHistory(this.cwd, sessionId);
      if (!conversation) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "对话不存在" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(conversation));
    } catch (error) {
      console.error("[History] Detail error:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "获取对话详情失败" }));
    }
  }

  private async handleRename(req: http.IncomingMessage, res: http.ServerResponse) {
    // 验证 token
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace("Bearer ", "");

    if (!this.state.paired || token !== this.state.token) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "未授权" }));
      return;
    }

    try {
      const body = await this.readBody(req);
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }
      const { sessionId, newTitle } = parsed;

      // 验证输入
      if (!sessionId || typeof newTitle !== "string") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "sessionId and newTitle are required" }));
        return;
      }

      // 执行重命名
      const success = renameSession(sessionId, newTitle, this.cwd);

      if (success) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found or title is empty" }));
      }
    } catch (error) {
      console.error("[Rename] Error:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "重命名失败" }));
    }
  }

  private async handleSkillsList(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace("Bearer ", "");

    if (!this.state.paired || token !== this.state.token) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "未授权" }));
      return;
    }

    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(url.searchParams.get("pageSize") || "20", 10) || 20));

    const skillsDir = join(this.cwd, ".claude", "skills");
    const allItems = listSkills(skillsDir);
    const total = allItems.length;
    const start = (page - 1) * pageSize;
    const items = allItems.slice(start, start + pageSize);
    const hasMore = start + pageSize < total;

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ items, total, page, pageSize, hasMore }));
  }

  private readBody(req: http.IncomingMessage, maxBytes: number = 10 * 1024 * 1024): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = "";
      let size = 0;
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy();
          reject(new Error("Request body too large"));
          return;
        }
        body += chunk;
      });
      req.on("end", () => resolve(body));
      req.on("error", reject);
    });
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      // 监听错误事件
      this.server.once('error', (err) => {
        reject(err);
      });

      const port = Number(process.env.PORT || 18080);
      this.server.listen(port, async () => {
        console.log(`[${this.isTls ? "HTTPS" : "HTTP"}] 服务启动在端口 ${port}`);

        // 启动所有通道（包括飞书长连接）
        await this.channelManager.startAll();

        resolve(port);
      });
    });
  }

  stop() {
    // 停止所有通道
    this.channelManager.stopAll();
    this.server.close();
  }
}
