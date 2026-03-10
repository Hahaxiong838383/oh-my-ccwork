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
import type { ProgressCard, ProgressEngine } from "./channels/feishu.js";
import { runCliEngine, type EngineType } from "./adapters/cli-engine.js";
import { getAdaptiveTimeout, recordExecution } from "./adaptive-timeout.js";
import { loadConfig } from "./config.js";
import type { DeviceConfig } from "./types.js";
import { SessionOwnership } from "./session-ownership.js";
import { classifyMessage, taskQueueManager } from "./task-queue.js";
import { triggerAutoCapture } from "./services/auto-capture.js";
import { saveChatAndExtractMemory } from "./services/chat-history.js";

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

/**
 * 每个飞书通道的独立上下文。
 *
 * 隔离范围：会话历史、任务、记忆（均绑定 sessionId）
 * 共享范围：MCP 工具、skills、多智能体调用链（进程级共享）
 */
interface ChannelContext {
  channelId: string;
  channel: FeishuChannel;
  currentSessionId: string | null;
  /** 按 chat_id 隔离的 session 表（群聊各群独立，私聊每次新建不存储） */
  chatSessions: Map<string, string>;
  /** 引擎类型：undefined/claude = Claude SDK, codex/gemini = CLI */
  engine?: "codex" | "gemini";
  /** 当前正在处理的消息来源 chat_id（请求级，防止异步期间被后续消息覆盖） */
  replyChatId?: string;
  /** 消息来源类型：p2p（私聊）或 group（群聊） */
  replyChatType?: string;
  /** 回复/多选的父消息 ID（飞书原生信号，用于判断是否注入上下文） */
  replyParentId?: string;
}

export class HttpServer {
  private server: http.Server | https.Server;
  private state: PairState;
  private cwd: string;
  private onPaired?: (token: string) => void;
  private isTls: boolean;
  private channelManager: ChannelManager;
  /** 每通道独立上下文：会话 + 回复路由完全隔离 */
  private channelContexts: Map<string, ChannelContext> = new Map();
  private feishuChannel: FeishuChannel | null = null; // 第一个通道，供 introspection 使用
  private sessionOwnership: SessionOwnership;
  /** 每通道的中止控制器（非队列任务用） */
  private channelAbortControllers: Map<string, AbortController> = new Map();

  constructor(pairCode: string, cwd: string, authToken?: string, tls?: TlsConfig) {
    this.cwd = cwd;
    this.state = {
      pairCode,
      paired: !!authToken,
      token: authToken || null,
    };

    this.channelManager = new ChannelManager();
    this.sessionOwnership = new SessionOwnership(cwd);

    // 注册飞书通道（每个通道独立会话，互不干扰；MCP/skills/多智能体共用底层进程）
    const feishuSlots = [
      {
        id: 'feishu-personal',
        appId: process.env.FEISHU_APP_ID,
        appSecret: process.env.FEISHU_APP_SECRET,
        receiveUserId: process.env.FEISHU_RECEIVE_USER_ID,
        receiveIdType: process.env.FEISHU_RECEIVE_ID_TYPE as "open_id" | "chat_id" | undefined,
        connectionMode: process.env.FEISHU_CONNECTION_MODE as "websocket" | "poll" | undefined,
        encryptKey: process.env.FEISHU_ENCRYPT_KEY,
        verificationToken: process.env.FEISHU_VERIFICATION_TOKEN,
        showToolUse: process.env.FEISHU_SHOW_TOOL_USE !== 'false',
      },
      {
        id: 'feishu-futurus-rayman',
        appId: process.env.FEISHU2_APP_ID,
        appSecret: process.env.FEISHU2_APP_SECRET,
        receiveUserId: process.env.FEISHU2_RECEIVE_USER_ID,
        receiveIdType: process.env.FEISHU2_RECEIVE_ID_TYPE as "open_id" | "chat_id" | undefined,
        connectionMode: process.env.FEISHU2_CONNECTION_MODE as "websocket" | "poll" | undefined,
        encryptKey: process.env.FEISHU2_ENCRYPT_KEY,
        verificationToken: process.env.FEISHU2_VERIFICATION_TOKEN,
        showToolUse: process.env.FEISHU2_SHOW_TOOL_USE !== 'false',
      },
      {
        id: 'feishu-futurus-alex',
        appId: process.env.FEISHU3_APP_ID,
        appSecret: process.env.FEISHU3_APP_SECRET,
        receiveUserId: process.env.FEISHU3_RECEIVE_USER_ID,
        receiveIdType: process.env.FEISHU3_RECEIVE_ID_TYPE as "open_id" | "chat_id" | undefined,
        connectionMode: process.env.FEISHU3_CONNECTION_MODE as "websocket" | "poll" | undefined,
        encryptKey: process.env.FEISHU3_ENCRYPT_KEY,
        verificationToken: process.env.FEISHU3_VERIFICATION_TOKEN,
        showToolUse: process.env.FEISHU3_SHOW_TOOL_USE !== 'false',
      },
      {
        id: 'feishu-codex',
        appId: process.env.FEISHU4_APP_ID,
        appSecret: process.env.FEISHU4_APP_SECRET,
        receiveUserId: process.env.FEISHU4_RECEIVE_USER_ID,
        receiveIdType: process.env.FEISHU4_RECEIVE_ID_TYPE as "open_id" | "chat_id" | undefined,
        connectionMode: process.env.FEISHU4_CONNECTION_MODE as "websocket" | "poll" | undefined,
        encryptKey: process.env.FEISHU4_ENCRYPT_KEY,
        verificationToken: process.env.FEISHU4_VERIFICATION_TOKEN,
        showToolUse: process.env.FEISHU4_SHOW_TOOL_USE !== 'false',
        engine: process.env.FEISHU4_ENGINE as string | undefined,
      },
      {
        id: 'feishu-gemini',
        appId: process.env.FEISHU5_APP_ID,
        appSecret: process.env.FEISHU5_APP_SECRET,
        receiveUserId: process.env.FEISHU5_RECEIVE_USER_ID,
        receiveIdType: process.env.FEISHU5_RECEIVE_ID_TYPE as "open_id" | "chat_id" | undefined,
        connectionMode: process.env.FEISHU5_CONNECTION_MODE as "websocket" | "poll" | undefined,
        encryptKey: process.env.FEISHU5_ENCRYPT_KEY,
        verificationToken: process.env.FEISHU5_VERIFICATION_TOKEN,
        showToolUse: process.env.FEISHU5_SHOW_TOOL_USE !== 'false',
        engine: process.env.FEISHU5_ENGINE as string | undefined,
      },
    ];

    let registeredCount = 0;
    for (const slot of feishuSlots) {
      if (!slot.appId || !slot.appSecret) continue;
      const cfg = {
        id: slot.id,
        appId: slot.appId,
        appSecret: slot.appSecret,
        receiveUserId: slot.receiveUserId,
        receiveIdType: slot.receiveIdType,
        connectionMode: slot.connectionMode,
        encryptKey: slot.encryptKey,
        verificationToken: slot.verificationToken,
        showToolUse: slot.showToolUse,
      };
      const ch = new FeishuChannel(cfg);
      // 每个通道独立上下文，会话和回复完全隔离
      const engine = (slot as any).engine as "codex" | "gemini" | undefined;
      const ctx: ChannelContext = { channelId: slot.id, channel: ch, currentSessionId: null, chatSessions: new Map(), engine };
      this.channelContexts.set(slot.id, ctx);
      ch.onMessage(async (message: string, images?: Array<{ data: string; mediaType: string }>, _messageId?: string, chatId?: string, chatType?: string, parentId?: string) => {
        // 记录请求级 replyChatId + replyChatType + replyParentId，防止异步处理期间被后续消息覆盖
        // chatSessions 是引用类型，processFeishuMessage 内的写入直接生效
        const requestCtx = { ...ctx, replyChatId: chatId || ctx.replyChatId, replyChatType: chatType, replyParentId: parentId };
        await this.processFeishuMessage(requestCtx, message, images);
        // 同步兼容字段
        ctx.currentSessionId = requestCtx.currentSessionId;
      });
      this.channelManager.register(ch);
      if (!this.feishuChannel) this.feishuChannel = ch; // 第一个通道用于 introspection
      console.log(`[Channels] 飞书通道 ${slot.id} 已注册${engine ? ` [引擎: ${engine}]` : ""}（启动时将激活）`);
      registeredCount++;
    }
    if (registeredCount === 0) {
      console.log("[Channels] 飞书通道未配置（设置 FEISHU_APP_ID 和 FEISHU_APP_SECRET 环境变量以启用）");
    }

    const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
      this.handleRequest(req, res);
    };

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

    pairAttempts.delete(ip);

    if (this.state.paired && this.state.token) {
      console.log("[Pair] 重复配对，返回现有 token");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, token: this.state.token }));
      return;
    }

    const token = generateToken();
    this.state.paired = true;
    this.state.token = token;
    console.log("[Pair] 首次配对成功");

    if (this.onPaired) {
      this.onPaired(token);
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, token }));
  }

  private async handleChat(req: http.IncomingMessage, res: http.ServerResponse) {
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

    const imageValidation = validateImages(images);
    if (!imageValidation.valid) {
      res.writeHead(imageValidation.code || 400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: imageValidation.error }));
      return;
    }

    const hasImages = images && images.length > 0;
    console.log(`[CC] 收到消息: ${message.substring(0, 50)}...${hasImages ? ` (附带 ${images.length} 张图片)` : ""}`);

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });

    const webChannel = new WebChannel({ res });
    const webChannelId = `web-${Date.now()}-${Math.random()}`;
    Object.defineProperty(webChannel, 'id', { value: webChannelId, writable: false });
    this.channelManager.register(webChannel);

    let currentSessionId = sessionId;

    try {
      for await (const data of adapter.chat({ message, sessionId, cwd: this.cwd, images, model: model || undefined })) {
        if (data && typeof data === "object" && "type" in data) {
          if (data.type === "system" && "session_id" in data) {
            currentSessionId = data.session_id as string;
            webChannel.setSessionId(currentSessionId);
          }
        }
        // Web 通道专用，不广播到飞书
        await webChannel.send(data);
      }

      await webChannel.send({ type: "done", sessionId: currentSessionId } as any);
      this.channelManager.unregister(webChannelId);
      res.end();
      console.log(`[CC] 完成`);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      try {
        await webChannel.send({ type: "error", error: errMsg } as any);
      } catch {
        // 忽略发送错误
      }
      this.channelManager.unregister(webChannelId);
      res.end();
      console.error(`[CC] 错误: ${errMsg}`);
    }
  }

  /**
   * 处理飞书收到的消息
   *
   * 隔离机制：
   * - ctx.currentSessionId 每通道独立，互不影响
   * - sendToChannel(ctx, ...) 只回给发消息的通道
   * - adapter/MCP/skills 共用底层进程
   */
  private async processFeishuMessage(ctx: ChannelContext, message: string, images?: Array<{ data: string; mediaType: string }>): Promise<void> {
    console.log(`[CC][${ctx.channelId}] 收到消息: ${message.substring(0, 50)}...${images ? ` [${images.length} 张图片]` : ""}`);

    const trimmedMessage = message.trim();

    if (trimmedMessage.startsWith("/")) {
      await this.handleFeishuCommand(ctx, trimmedMessage);
      return;
    }

    if (this.isOperationCommand(trimmedMessage)) {
      await this.handleOperationCommand(ctx, trimmedMessage);
      return;
    }

    // 上下文注入策略：
    // - 群聊：始终注入最近 15 条历史
    // - 私聊：仅在飞书"回复"或"多选"操作时，获取被回复的那条消息作为上下文；其他情况不注入
    let contextPrefix = "";
    if (ctx.replyChatType === "group" && ctx.replyChatId) {
      try {
        const history = await ctx.channel.fetchChatHistory(ctx.replyChatId, 15);
        if (history) {
          contextPrefix = `[以下是群聊最近的对话记录，供你了解上下文]\n${history}\n[对话记录结束]\n\n`;
          console.log(`[CC][${ctx.channelId}] 已注入群聊上下文 (${history.split("\n").length} 条)`);
        }
      } catch (err) {
        console.warn(`[CC][${ctx.channelId}] 获取群聊上下文失败:`, err);
      }
    } else if (ctx.replyChatType === "p2p" && ctx.replyParentId) {
      try {
        const parentMsg = await ctx.channel.fetchMessageById(ctx.replyParentId);
        if (parentMsg) {
          contextPrefix = `[以下是用户回复的原始消息]\n${parentMsg}\n[原始消息结束]\n\n`;
          console.log(`[CC][${ctx.channelId}] 已注入回复上下文: ${parentMsg.substring(0, 80)}...`);
        }
      } catch (err) {
        console.warn(`[CC][${ctx.channelId}] 获取回复消息失败:`, err);
      }
    }

    // 团队模式检测（仅 cc 通道）：并行调用三引擎，汇总输出
    // 注意：cc 引擎接收完整上下文，codex/gemini 只接收任务本体（群聊上下文是噪音，浪费 token 且拖慢执行）
    if (!ctx.engine) {
      const teamResult = this.detectTeamMode(trimmedMessage);
      if (teamResult.isTeamMode && teamResult.cleanMessage) {
        await this.processTeamMode(ctx, teamResult.cleanMessage, contextPrefix, images);
        return;
      }
    }

    // CLI 引擎分流：codex/gemini 走 CLI 子进程，无 session 概念
    if (ctx.engine === "codex" || ctx.engine === "gemini") {
      await this.processCliEngineMessage(ctx, contextPrefix + trimmedMessage);
      return;
    }

    // 双主分离：任务型消息异步入队，立即 ack，不阻塞对话通道
    if (!ctx.engine) {
      const msgType = classifyMessage(trimmedMessage);
      if (msgType === "task") {
        const pending = taskQueueManager.getPendingCount(ctx.channelId);
        const busy = taskQueueManager.isChannelBusy(ctx.channelId);
        const queueTip = pending > 0 ? `，队列中还有 ${pending} 个任务` : "";
        const busyTip = busy ? "，当前有任务正在执行" : "";

        // 快速 ack
        await this.sendToChannel(ctx, `📋 任务已接收${busyTip}${queueTip}，后台处理中，完成后通知你。`);

        // 冻结 ctx 快照（避免异步执行期间 replyChatId 被后续消息覆盖）
        const frozenCtx = { ...ctx };

        taskQueueManager.submit(ctx.channelId, trimmedMessage, async (_task, signal) => {
          await this.runTaskAsync(frozenCtx, contextPrefix + trimmedMessage, images, signal);
        });
        return;
      }
    }

    // Session 隔离策略（按 chat_id）：
    // - 私聊（p2p）：每条消息创建新 session（无状态，不串上下文）
    // - 群聊（group）：按 chat_id 隔离，同一个群复用 session，不同群独立
    const chatId = ctx.replyChatId || "default";
    let effectiveSessionId: string | null = null;
    if (ctx.replyChatType === "p2p") {
      effectiveSessionId = null; // 私聊：强制新 session
      console.log(`[CC][${ctx.channelId}] 私聊 ${chatId}：创建独立 session（无状态）`);
    } else {
      effectiveSessionId = ctx.chatSessions.get(chatId) || null; // 群聊：按 chat_id 查找
      console.log(`[CC][${ctx.channelId}] 群聊 ${chatId}：session=${effectiveSessionId || "新建"}`);
    }

    if (!effectiveSessionId) {
      console.log(`[CC][${ctx.channelId}] 将创建新会话`);
    }

    const startTime = Date.now();
    const taskPreview = trimmedMessage.substring(0, 60);

    // 发送单引擎进度卡片
    const engineState: ProgressEngine = { name: "cc (Claude)", status: "running" };
    const card: ProgressCard = {
      title: "cc 处理中",
      task: taskPreview + (taskPreview.length >= 60 ? "..." : ""),
      engines: [engineState],
      footer: "思考中...",
    };

    const feishuChannel = ctx.channel as FeishuChannel;
    let cardMessageId: string | null = null;
    if (typeof feishuChannel.sendProgressCard === "function") {
      cardMessageId = await feishuChannel.sendProgressCard(card, ctx.replyChatId);
    }

    try {
      const replyParts: string[] = [];
      const toolNames: string[] = [];
      let lastCardUpdate = 0;

      for await (const data of adapter.chat({
        message: contextPrefix + trimmedMessage,
        sessionId: effectiveSessionId ?? undefined,
        cwd: this.cwd,
        images: images,
      })) {
        if (data && typeof data === "object") {
          if (data.type === "system" && "session_id" in data) {
            const newSessionId = data.session_id as string;
            // 群聊：按 chat_id 存储 session，供同群后续消息复用
            // 私聊：不存储（每次独立）
            if (ctx.replyChatType !== "p2p") {
              ctx.chatSessions.set(chatId, newSessionId);
              ctx.currentSessionId = newSessionId; // 兼容旧引用
              this.sessionOwnership.claim(newSessionId, ctx.channelId);
            }
            console.log(`[CC][${ctx.channelId}] 会话更新: ${newSessionId} [chat=${chatId}]${ctx.replyChatType === "p2p" ? "（私聊，不持久化）" : ""}`);
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
                if (block.type === "tool_use") {
                  const name = block.name || "unknown";
                  toolNames.push(name);
                  console.log(`[CC][${ctx.channelId}] 工具调用: ${name}`);
                  // 智能节流：首次立即更新，后续 500ms 节流
                  const throttle = lastCardUpdate === 0 ? 0 : 500;
                  if (cardMessageId && Date.now() - lastCardUpdate > throttle) {
                    lastCardUpdate = Date.now();
                    engineState.detail = `${toolNames.length} 个工具 (${name})`;
                    // 渐近进度：每个工具调用递增，上限 95%（完成时才 100%）
                    card.progress = Math.min(95, Math.round(100 * (1 - Math.exp(-toolNames.length / 10))));
                    card.footer = `耗时 ${((Date.now() - startTime) / 1000).toFixed(1)}s`;
                    await feishuChannel.updateProgressCard(cardMessageId, card).catch(() => {});
                  }
                }
              }
            }
          }
        }
      }

      // 更新卡片为完成状态
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      engineState.status = "done";
      engineState.elapsed = `${elapsed}s`;
      engineState.detail = toolNames.length > 0 ? `${toolNames.length} 个工具调用` : undefined;
      card.progress = 100;
      card.title = "cc 完成";
      card.footer = `总耗时 ${elapsed}s`;
      if (cardMessageId) {
        await feishuChannel.updateProgressCard(cardMessageId, card).catch(() => {});
      }

      // 发送最终结果
      const finalReply = replyParts.join("\n").trim();
      if (finalReply) {
        const MAX_CHUNK = 3500;
        if (finalReply.length <= MAX_CHUNK) {
          await this.sendToChannel(ctx, finalReply);
        } else {
          for (let i = 0; i < finalReply.length; i += MAX_CHUNK) {
            await this.sendToChannel(ctx, finalReply.substring(i, i + MAX_CHUNK));
          }
        }
      }

      // 私聊：归档聊天记录 + 记忆提取（含 auto-capture）
      // 群聊：仅 auto-capture（有 sessionId 时）
      if (finalReply) {
        if (ctx.replyChatType === "p2p" && ctx.replyChatId) {
          saveChatAndExtractMemory(ctx.replyChatId, trimmedMessage, finalReply, this.cwd);
        } else if (ctx.currentSessionId) {
          triggerAutoCapture(ctx.currentSessionId, trimmedMessage, finalReply, this.cwd);
        }
      }
    } catch (err) {
      console.error(`[CC][${ctx.channelId}] 处理消息错误:`, err);
      // 更新卡片为错误状态
      engineState.status = "error";
      engineState.elapsed = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
      engineState.detail = String(err).substring(0, 60);
      card.title = "cc 出错";
      if (cardMessageId) {
        await feishuChannel.updateProgressCard(cardMessageId, card).catch(() => {});
      }
      await this.sendToChannel(ctx, "❌ 处理消息时出错，请重试。");
    } finally {
      await ctx.channel.clearTypingIndicator();
    }
  }

  /**
   * 后台异步任务执行（双主分离 - 任务主 Agent）
   *
   * 关键设计：
   * - 使用独立 session（sessionId: undefined），不占用对话 session
   * - 任务完成/失败后主动回飞书
   * - 不更新 ctx.currentSessionId（避免污染对话状态）
   */
  private async runTaskAsync(
    ctx: ChannelContext,
    message: string,
    images?: Array<{ data: string; mediaType: string }>,
    signal?: AbortSignal,
  ): Promise<void> {
    const startTime = Date.now();
    const taskPreview = message.replace(/\[以下是群聊.*?\[对话记录结束\]\n\n/s, "").substring(0, 60);

    const feishuChannel = ctx.channel as FeishuChannel;
    const engineState: ProgressEngine = { name: "cc (后台任务)", status: "running" };
    const card: ProgressCard = {
      title: "后台任务执行中",
      task: taskPreview + (taskPreview.length >= 60 ? "..." : ""),
      engines: [engineState],
      footer: "思考中...",
    };

    let cardMessageId: string | null = null;
    if (typeof feishuChannel.sendProgressCard === "function") {
      cardMessageId = await feishuChannel.sendProgressCard(card, ctx.replyChatId).catch(() => null);
    }

    try {
      const replyParts: string[] = [];
      const toolNames: string[] = [];
      let lastCardUpdate = 0;

      for await (const data of adapter.chat({
        message,
        sessionId: undefined, // 独立 session，不复用对话 session
        cwd: this.cwd,
        images,
      })) {
        // 检查中止信号
        if (signal?.aborted) {
          console.log(`[CC][${ctx.channelId}] 后台任务被用户中止`);
          engineState.status = "error";
          engineState.elapsed = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
          engineState.detail = "用户中止";
          card.title = "后台任务已中止";
          card.footer = `已中止`;
          if (cardMessageId) {
            await feishuChannel.updateProgressCard(cardMessageId, card).catch(() => {});
          }
          return;
        }
        if (data && typeof data === "object") {
          if (data.type === "text" && data.text) {
            replyParts.push(String(data.text));
          } else if (data.type === "assistant") {
            const assistantEvent = data as any;
            if (assistantEvent.message?.content) {
              for (const block of assistantEvent.message.content) {
                if (block.type === "text" && block.text) {
                  replyParts.push(String(block.text));
                }
                if (block.type === "tool_use") {
                  const name = block.name || "unknown";
                  toolNames.push(name);
                  // 智能节流：首次立即更新，后续 500ms 节流
                  const taskThrottle = lastCardUpdate === 0 ? 0 : 500;
                  if (cardMessageId && Date.now() - lastCardUpdate > taskThrottle) {
                    lastCardUpdate = Date.now();
                    engineState.detail = `${toolNames.length} 个工具 (${name})`;
                    card.progress = Math.min(95, Math.round(100 * (1 - Math.exp(-toolNames.length / 10))));
                    card.footer = `耗时 ${((Date.now() - startTime) / 1000).toFixed(1)}s`;
                    await feishuChannel.updateProgressCard(cardMessageId, card).catch(() => {});
                  }
                }
              }
            }
          }
        }
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      engineState.status = "done";
      engineState.elapsed = `${elapsed}s`;
      engineState.detail = toolNames.length > 0 ? `${toolNames.length} 个工具调用` : undefined;
      card.progress = 100;
      card.title = "后台任务完成";
      card.footer = `总耗时 ${elapsed}s`;
      if (cardMessageId) {
        await feishuChannel.updateProgressCard(cardMessageId, card).catch(() => {});
      }

      const finalReply = replyParts.join("\n").trim();
      if (finalReply) {
        const MAX_CHUNK = 3500;
        if (finalReply.length <= MAX_CHUNK) {
          await this.sendToChannel(ctx, finalReply);
        } else {
          for (let i = 0; i < finalReply.length; i += MAX_CHUNK) {
            await this.sendToChannel(ctx, finalReply.substring(i, i + MAX_CHUNK));
          }
        }
      }
    } catch (err) {
      console.error(`[CC][${ctx.channelId}] 后台任务出错:`, err);
      engineState.status = "error";
      engineState.elapsed = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
      engineState.detail = String(err).substring(0, 60);
      card.title = "后台任务出错";
      if (cardMessageId) {
        await feishuChannel.updateProgressCard(cardMessageId, card).catch(() => {});
      }
      await this.sendToChannel(ctx, `❌ 后台任务执行出错：${String(err).substring(0, 100)}`);
      throw err; // 让 TaskQueue 记录 error 状态
    }
  }

  /**
   * CLI 引擎消息处理（codex / gemini）
   * 无 session 概念，每次调用都是独立的子进程。
   */
  private async processCliEngineMessage(ctx: ChannelContext, message: string): Promise<void> {
    const engine = ctx.engine as EngineType;
    console.log(`[CC][${ctx.channelId}] CLI 引擎: ${engine}, 消息: ${message.substring(0, 50)}...`);

    const startTime = Date.now();
    const taskPreview = message.replace(/\[以下是群聊.*?\[对话记录结束\]\n\n/s, "").substring(0, 60);

    // 发送进度卡片
    const engineState: ProgressEngine = { name: engine, status: "running" };
    const card: ProgressCard = {
      title: `${engine} 处理中`,
      task: taskPreview + (taskPreview.length >= 60 ? "..." : ""),
      engines: [engineState],
      footer: "执行中...",
    };

    const feishuChannel = ctx.channel as FeishuChannel;
    let cardMessageId: string | null = null;
    if (typeof feishuChannel.sendProgressCard === "function") {
      cardMessageId = await feishuChannel.sendProgressCard(card, ctx.replyChatId);
    }

    try {
      // SOP 自动注入：识别任务关键词，注入对应的标准操作流程
      let sopPrefix = "";
      let matchedSopKey = "default"; // 用于自适应超时的 pattern key
      const sopMap: Array<{ keywords: RegExp; sopPath: string }> = [
        { keywords: /理论雷达|theory.?radar|前沿论文|论文调研|每日论文|arxiv/i, sopPath: join(this.cwd, ".claude/skills/theory-radar/SOP.md") },
      ];
      for (const { keywords, sopPath } of sopMap) {
        if (keywords.test(message) && existsSync(sopPath)) {
          const sopContent = readFileSync(sopPath, "utf-8");
          sopPrefix = `[标准操作流程 - 必须严格按此执行，禁止自由发挥]\n\n${sopContent}\n\n[用户指令]\n`;
          matchedSopKey = sopPath; // 用 SOP 文件路径作为任务标识
          console.log(`[CC][${ctx.channelId}] 已注入 SOP: ${sopPath}`);
          break;
        }
      }

      // 自适应超时：基于历史执行数据动态计算
      const adaptiveTimeout = getAdaptiveTimeout(matchedSopKey, engine);

      // 注入署名规则：任务完成后必须署名，便于追溯和排查问题
      const engineLabel = engine === "codex" ? "codex（OpenAI Codex）" : "gemini（Google Gemini）";
      const now = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }).replace(/\//g, "-").replace(",", "");
      const signatureRule = `\n\n[系统规则] 完成任务后，在回复最末尾必须附上署名，格式严格如下（不得省略）：\n---\n署名：${engineLabel} | ${now}`;
      const channelAbort = this.getChannelAbort(ctx.channelId);
      const result = await runCliEngine(engine, sopPrefix + message + signatureRule, this.cwd, { timeout: adaptiveTimeout, signal: channelAbort.signal });
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      // 记录执行结果，供自适应超时学习
      recordExecution(matchedSopKey, engine, Date.now() - startTime, !!result.timedOut);

      // 用户中止
      if (result.error === "USER_ABORTED") {
        engineState.status = "error";
        engineState.elapsed = `${elapsed}s`;
        engineState.detail = "已被用户中止";
        card.title = `${engine} 已中止`;
        if (cardMessageId) {
          await feishuChannel.updateProgressCard(cardMessageId, card).catch(() => {});
        }
        return; // /stop 已回复了用户，不重复
      }

      if (result.error && !result.output) {
        engineState.status = "error";
        engineState.elapsed = `${elapsed}s`;
        engineState.detail = result.error.substring(0, 60);
        card.title = `${engine} 出错`;
        if (cardMessageId) {
          await feishuChannel.updateProgressCard(cardMessageId, card).catch(() => {});
        }
        await this.sendToChannel(ctx, `❌ ${engine} 执行出错:\n${result.error.substring(0, 500)}`);
        return;
      }

      // 更新卡片为完成状态
      const output = result.output.trim();
      engineState.status = "done";
      engineState.elapsed = `${elapsed}s`;
      engineState.detail = output ? `${output.length} 字` : "无输出";
      card.title = `${engine} 完成`;
      card.footer = `总耗时 ${elapsed}s`;
      if (cardMessageId) {
        await feishuChannel.updateProgressCard(cardMessageId, card).catch(() => {});
      }

      if (output) {
        const MAX_CHUNK = 3500;
        if (output.length <= MAX_CHUNK) {
          await this.sendToChannel(ctx, output);
        } else {
          for (let i = 0; i < output.length; i += MAX_CHUNK) {
            await this.sendToChannel(ctx, output.substring(i, i + MAX_CHUNK));
          }
        }
      } else {
        await this.sendToChannel(ctx, `✅ ${engine} 执行完成（无输出）`);
      }

      if (result.error) {
        await this.sendToChannel(ctx, `⚠️ ${engine} 警告:\n${result.error.substring(0, 300)}`);
      }
    } catch (err: any) {
      console.error(`[CC][${ctx.channelId}] CLI 引擎错误:`, err);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      engineState.status = "error";
      engineState.elapsed = `${elapsed}s`;
      engineState.detail = err.message?.substring(0, 60);
      card.title = `${engine} 异常`;
      if (cardMessageId) {
        await feishuChannel.updateProgressCard(cardMessageId, card).catch(() => {});
      }
      await this.sendToChannel(ctx, `❌ ${engine} 异常: ${err.message}`);
    } finally {
      await ctx.channel.clearTypingIndicator();
    }
  }

  /**
   * 团队模式关键词检测
   */
  private static TEAM_MODE_KEYWORDS = ["团队模式", "三人组", "一起干", "team mode", "team"];

  private detectTeamMode(message: string): { isTeamMode: boolean; cleanMessage: string } {
    const lower = message.toLowerCase();
    for (const keyword of HttpServer.TEAM_MODE_KEYWORDS) {
      if (lower.includes(keyword.toLowerCase())) {
        const cleanMessage = message.replace(new RegExp(keyword, "gi"), "").replace(/[：:]\s*/, "").trim();
        return { isTeamMode: true, cleanMessage };
      }
    }
    return { isTeamMode: false, cleanMessage: message };
  }

  /**
   * 团队模式：cc 主控，并行调用三引擎，卡片实时更新进度
   */
  private async processTeamMode(ctx: ChannelContext, taskMessage: string, contextPrefix: string, images?: Array<{ data: string; mediaType: string }>): Promise<void> {
    console.log(`[CC][${ctx.channelId}] 团队模式: ${taskMessage.substring(0, 50)}...`);

    // cc 引擎拿完整上下文 + 任务，codex/gemini 只拿任务（减少 prompt 体积，避免超时）
    const ccMessage = contextPrefix ? contextPrefix + taskMessage : taskMessage;
    const cliMessage = taskMessage;

    const taskPreview = taskMessage.substring(0, 60);
    const startTime = Date.now();

    // 引擎状态跟踪
    const engineStates: ProgressEngine[] = [
      { name: "cc (Claude)", status: "running" },
      { name: "codex", status: "running" },
      { name: "gemini", status: "running" },
    ];
    const engineStartTimes = [startTime, startTime, startTime];

    const card: ProgressCard = {
      title: "团队模式",
      task: taskPreview + (taskPreview.length >= 60 ? "..." : ""),
      engines: engineStates,
      footer: "三引擎并行处理中",
    };

    // Phase A: 发送初始进度卡片
    const feishuChannel = ctx.channel as FeishuChannel;
    let cardMessageId: string | null = null;
    if (typeof feishuChannel.sendProgressCard === "function") {
      cardMessageId = await feishuChannel.sendProgressCard(card, ctx.replyChatId);
    }
    if (!cardMessageId) {
      // 降级：卡片发送失败，用文本
      await this.sendToChannel(ctx, "🤝 **团队模式启动** — cc + codex + gemini 并行思考中...");
    }

    const formatElapsed = (idx: number) => {
      const ms = Date.now() - engineStartTimes[idx];
      return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
    };

    // 更新卡片的辅助函数（带节流，最多 1 次/秒）
    let lastUpdate = 0;
    const updateCard = async () => {
      if (!cardMessageId) return;
      const now = Date.now();
      if (now - lastUpdate < 1000) return;
      lastUpdate = now;
      card.footer = `耗时 ${((now - startTime) / 1000).toFixed(1)}s`;
      await feishuChannel.updateProgressCard(cardMessageId, card).catch(() => {});
    };

    // Phase B: 并行执行三引擎，每个完成时更新卡片
    const ccPromise = this.runCcEngine(ctx, ccMessage, images).then(async (v) => {
      engineStates[0].status = "done";
      engineStates[0].elapsed = formatElapsed(0);
      engineStates[0].detail = v ? `${v.length} 字` : "无输出";
      await updateCard();
      return v;
    }).catch(async (err) => {
      engineStates[0].status = "error";
      engineStates[0].elapsed = formatElapsed(0);
      engineStates[0].detail = String(err).substring(0, 60);
      await updateCard();
      throw err;
    });

    // 团队模式: codex 固定 high reasoning（xhigh 太慢），超时 15 分钟
    const teamTimeout = 15 * 60 * 1000;

    const channelAbort = this.getChannelAbort(ctx.channelId);
    const codexPromise = runCliEngine("codex", cliMessage, this.cwd, { timeout: teamTimeout, reasoningEffort: "high", signal: channelAbort.signal }).then(async (v) => {
      if (v.error || v.timedOut) {
        engineStates[1].status = "error";
        engineStates[1].elapsed = formatElapsed(1);
        engineStates[1].detail = v.timedOut ? "超时" : (v.error?.substring(0, 60) || "未知错误");
      } else {
        engineStates[1].status = "done";
        engineStates[1].elapsed = formatElapsed(1);
        engineStates[1].detail = v.output?.trim() ? `${v.output.trim().length} 字` : "无输出";
      }
      await updateCard();
      return v;
    });

    const geminiPromise = runCliEngine("gemini", cliMessage, this.cwd, { timeout: teamTimeout, signal: channelAbort.signal }).then(async (v) => {
      if (v.error || v.timedOut) {
        engineStates[2].status = "error";
        engineStates[2].elapsed = formatElapsed(2);
        engineStates[2].detail = v.timedOut ? "超时" : (v.error?.substring(0, 60) || "未知错误");
      } else {
        engineStates[2].status = "done";
        engineStates[2].elapsed = formatElapsed(2);
        engineStates[2].detail = v.output?.trim() ? `${v.output.trim().length} 字` : "无输出";
      }
      await updateCard();
      return v;
    });

    const [ccResult, codexResult, geminiResult] = await Promise.allSettled([
      ccPromise, codexPromise, geminiPromise,
    ]);

    // Phase C: 最终更新卡片为完成状态
    const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const hasError = engineStates.some(e => e.status === "error");
    card.title = hasError ? "团队模式（部分失败）" : "团队模式完成";
    card.footer = `总耗时 ${totalElapsed}s`;
    if (cardMessageId) {
      await feishuChannel.updateProgressCard(cardMessageId, card).catch(() => {});
    }

    // Phase D: 发送各引擎的详细输出
    const parts: string[] = [];

    parts.push("## 🧠 cc（Claude）");
    if (ccResult.status === "fulfilled") {
      parts.push(ccResult.value || "（无输出）");
    } else {
      parts.push(`❌ 出错: ${ccResult.reason}`);
    }

    parts.push("\n## 💻 codex");
    if (codexResult.status === "fulfilled") {
      const r = codexResult.value;
      parts.push(r.output?.trim() || "（无输出）");
      if (r.error) parts.push(`⚠️ ${r.error.substring(0, 200)}`);
    } else {
      parts.push(`❌ 出错: ${codexResult.reason}`);
    }

    parts.push("\n## ✨ gemini");
    if (geminiResult.status === "fulfilled") {
      const r = geminiResult.value;
      parts.push(r.output?.trim() || "（无输出）");
      if (r.error) parts.push(`⚠️ ${r.error.substring(0, 200)}`);
    } else {
      parts.push(`❌ 出错: ${geminiResult.reason}`);
    }

    const combined = parts.join("\n");

    // Phase E: 发送 Mermaid 流程总结图（文本版，飞书不支持 Mermaid 渲染）
    const mermaidSummary = this.buildMermaidSummary(engineStates, totalElapsed);
    const fullOutput = combined + "\n\n---\n" + mermaidSummary;

    const MAX_CHUNK = 3500;
    if (fullOutput.length <= MAX_CHUNK) {
      await this.sendToChannel(ctx, fullOutput);
    } else {
      for (let i = 0; i < fullOutput.length; i += MAX_CHUNK) {
        await this.sendToChannel(ctx, fullOutput.substring(i, i + MAX_CHUNK));
      }
    }

    await ctx.channel.clearTypingIndicator();
  }

  /**
   * 生成 Mermaid 风格的文本流程总结
   */
  private buildMermaidSummary(engines: ProgressEngine[], totalElapsed: string): string {
    const statusIcon = (e: ProgressEngine) =>
      e.status === "done" ? "✅" : e.status === "error" ? "❌" : "⬜";

    const lines = [
      "**流程总结**",
      "```",
      `用户提问 ──▶ 团队模式分发`,
      `             ├── ${statusIcon(engines[0])} cc      ${engines[0].elapsed || ""} ${engines[0].detail || ""}`,
      `             ├── ${statusIcon(engines[1])} codex   ${engines[1].elapsed || ""} ${engines[1].detail || ""}`,
      `             └── ${statusIcon(engines[2])} gemini  ${engines[2].elapsed || ""} ${engines[2].detail || ""}`,
      `                      ▼`,
      `              汇总输出 (${totalElapsed}s)`,
      "```",
    ];
    return lines.join("\n");
  }

  /**
   * 运行 cc 引擎并收集文本输出（供团队模式使用）
   */
  private async runCcEngine(ctx: ChannelContext, message: string, images?: Array<{ data: string; mediaType: string }>): Promise<string> {
    const parts: string[] = [];
    const chatId = ctx.replyChatId || "default";
    const sessionForChat = ctx.replyChatType === "p2p" ? undefined : (ctx.chatSessions.get(chatId) ?? undefined);

    for await (const data of adapter.chat({
      message,
      sessionId: sessionForChat,
      cwd: this.cwd,
      images,
    })) {
      if (data && typeof data === "object") {
        if (data.type === "system" && "session_id" in data) {
          const newSid = data.session_id as string;
          if (ctx.replyChatType !== "p2p") {
            ctx.chatSessions.set(chatId, newSid);
            ctx.currentSessionId = newSid;
          }
          this.sessionOwnership.claim(newSid, ctx.channelId);
        }
        if (data.type === "text" && data.text) {
          parts.push(String(data.text));
        } else if (data.type === "assistant") {
          const assistantEvent = data as any;
          if (assistantEvent.message?.content) {
            for (const block of assistantEvent.message.content) {
              if (block.type === "text" && block.text) {
                parts.push(String(block.text));
              }
            }
          }
        }
      }
    }

    return parts.join("\n").trim();
  }

  private async handleFeishuCommand(ctx: ChannelContext, command: string): Promise<void> {
    const parts = command.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    console.log(`[CC][${ctx.channelId}] 命令: ${cmd}`);

    try {
      switch (cmd) {
        case "/new":
        case "/create":
          await this.handleNewSession(ctx, args.join(" "));
          break;
        case "/sessions":
        case "/list":
        case "/history":
          await this.handleListSessions(ctx);
          break;
        case "/switch":
          await this.handleSwitchSession(ctx, args[0]);
          break;
        case "/current":
          await this.handleCurrentSession(ctx);
          break;
        case "/device":
        case "/devices":
          await this.handleDevice(ctx);
          break;
        case "/stop":
        case "/停止":
          await this.handleStopTask(ctx);
          break;
        case "/reset":
        case "/重置":
          await this.handleResetSession(ctx);
          break;
        case "/queue":
        case "/队列":
          await this.handleQueueInfo(ctx);
          break;
        case "/restart":
        case "/重启":
          await this.handleRestart(ctx);
          break;
        case "/help":
        case "/?":
          await this.handleHelp(ctx);
          break;
        case "/搜索":
        case "/search":
          await this.handleSearch(ctx, args.join(" "));
          break;
        default:
          await this.sendToChannel(ctx, `❓ 未知命令: ${cmd}\n\n发送 /help 查看可用命令。`);
      }
    } catch (err) {
      console.error(`[CC][${ctx.channelId}] 命令处理错误:`, err);
      await this.sendToChannel(ctx, `❌ 执行命令时出错: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private isOperationCommand(message: string): boolean {
    // 严格匹配：消息去掉标点空格后必须完全等于命令，防止"看看状态"误匹配
    const normalized = message.replace(/[，。！？\s]/g, "").toLowerCase();
    const opCommands = [
      "重启mycc", "重启mycc后端", "重启后端",
      "重启", "停止mycc", "停止后端",
      "状态", "状态查询", "查看状态",
      "启动mycc", "启动后端"
    ];
    return opCommands.some(cmd => normalized === cmd);
  }

  private async handleOperationCommand(ctx: ChannelContext, message: string): Promise<void> {
    console.log(`[CC][${ctx.channelId}] 运维命令: ${message}`);
    const lowerMessage = message.toLowerCase();
    try {
      if (lowerMessage.includes("重启") || lowerMessage.includes("启动")) {
        await this.handleRestart(ctx);
      } else if (lowerMessage.includes("停止")) {
        await this.handleStop(ctx);
      } else if (lowerMessage.includes("状态")) {
        await this.handleStatus(ctx);
      } else {
        await this.sendToChannel(ctx, `❓ 无法识别运维命令: ${message}`);
      }
    } catch (err) {
      console.error(`[CC][${ctx.channelId}] 运维命令错误:`, err);
      await this.sendToChannel(ctx, `❌ 执行运维命令时出错: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleRestart(ctx: ChannelContext): Promise<void> {
    await this.sendToChannel(ctx, "🔄 正在重启 mycc 后端...");
    try {
      const { execSync } = await import("child_process");
      execSync("lsof -i :18080 -t | xargs kill 2>/dev/null", { stdio: "ignore" });
      await this.sendToChannel(ctx, "✅ 已停止旧进程");
      await new Promise(resolve => setTimeout(resolve, 2000));
      const { spawn } = await import("child_process");
      spawn("npx", ["tsx", "./.claude/skills/mycc/scripts/src/index.ts", "start"], {
        cwd: process.cwd(),
        detached: true,
        stdio: "ignore"
      }).unref();
      await this.sendToChannel(ctx, "✅ 已启动新进程，请稍候...");
    } catch (err) {
      console.error("[CC] 重启失败:", err);
      await this.sendToChannel(ctx, `❌ 重启失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleStop(ctx: ChannelContext): Promise<void> {
    await this.sendToChannel(ctx, "🔄 正在停止 mycc 后端...");
    try {
      const { execSync } = await import("child_process");
      execSync("lsof -i :18080 -t | xargs kill 2>/dev/null", { stdio: "ignore" });
      await this.sendToChannel(ctx, "✅ mycc 后端已停止");
    } catch (err) {
      console.error("[CC] 停止失败:", err);
      await this.sendToChannel(ctx, `❌ 停止失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleStatus(ctx: ChannelContext): Promise<void> {
    try {
      const { execSync } = await import("child_process");
      const pid = execSync("lsof -i :18080 -t 2>/dev/null", { encoding: "utf8" }).trim();
      if (pid) {
        const status = execSync(`ps -p ${pid} -o pid,etime,comm 2>/dev/null`, { encoding: "utf8" });
        await this.sendToChannel(ctx, `✅ mycc 后端运行中\n\n\`\`\`\n${status}\n\`\`\``);
      } else {
        await this.sendToChannel(ctx, "❌ mycc 后端未运行");
      }
    } catch {
      await this.sendToChannel(ctx, "❌ mycc 后端未运行");
    }
  }

  private async handleNewSession(ctx: ChannelContext, title?: string): Promise<void> {
    console.log(`[CC][${ctx.channelId}] 创建新会话${title ? `: ${title}` : ''}`);
    try {
      const replyParts: string[] = [];
      let newSessionId: string | undefined;

      for await (const data of adapter.chat({
        message: title || "开始新对话",
        cwd: this.cwd,
      })) {
        if (data && typeof data === "object") {
          if (data.type === "system" && "session_id" in data) {
            ctx.currentSessionId = data.session_id as string;
            newSessionId = data.session_id as string;
            this.sessionOwnership.claim(newSessionId, ctx.channelId);
            console.log(`[CC][${ctx.channelId}] 新会话: ${ctx.currentSessionId}`);
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

      let response = "";
      if (newSessionId) {
        response = `✅ 新会话已创建\n\n📌 会话 ID: ${newSessionId}\n`;
        if (title) response += `📝 标题: ${title}\n`;
        response += "\n";
      }
      response += replyParts.length > 0 ? replyParts.join("").trim() : (newSessionId ? "💡 现在发送的消息将使用此会话。" : "");

      await this.sendToChannel(ctx, response);
    } catch (err) {
      console.error(`[CC][${ctx.channelId}] 创建会话错误:`, err);
      await this.sendToChannel(ctx, "❌ 创建会话失败，请重试。");
    }
  }

  private async handleListSessions(ctx: ChannelContext): Promise<void> {
    console.log(`[CC][${ctx.channelId}] 列出历史会话`);
    try {
      const result = await adapter.listHistory(this.cwd);
      const allVisible = this.sessionOwnership.filterForChannel(result.conversations, ctx.channelId);
      const conversations = allVisible.slice(0, 10);

      if (conversations.length === 0) {
        await this.sendToChannel(ctx, "📋 还没有历史会话。\n\n发送 /new 创建第一个会话。");
        return;
      }

      let output = `📋 历史会话 (共 ${allVisible.length} 个，显示最近 ${conversations.length} 个)\n\n`;

      conversations.forEach((conv, index) => {
        const isCurrent = conv.sessionId === ctx.currentSessionId ? " [当前]" : "";
        let title = "未命名会话";
        if (conv.customTitle) {
          title = conv.customTitle;
        } else if (conv.firstPrompt) {
          title = conv.firstPrompt.substring(0, 30);
        } else if (conv.lastMessagePreview) {
          title = conv.lastMessagePreview.substring(0, 30);
        }
        const timeAgo = this.formatTimeAgo(conv.lastTime || conv.modified || Date.now());
        output += `${index + 1}. ${title}${isCurrent}\n   🕒 ${timeAgo}\n\n`;
      });

      output += `💡 使用 /switch <序号> 切换到某个会话`;
      await this.sendToChannel(ctx, output);
    } catch (err) {
      console.error(`[CC][${ctx.channelId}] 获取会话列表错误:`, err);
      await this.sendToChannel(ctx, "❌ 获取会话列表失败，请重试。");
    }
  }

  private async handleSwitchSession(ctx: ChannelContext, target: string | undefined): Promise<void> {
    console.log(`[CC][${ctx.channelId}] 切换会话: ${target}`);
    if (!target) {
      await this.sendToChannel(ctx, "❓ 请指定要切换的会话序号。\n\n使用 /sessions 查看所有会话。");
      return;
    }
    try {
      const result = await adapter.listHistory(this.cwd);
      const conversations = this.sessionOwnership.filterForChannel(result.conversations, ctx.channelId);
      const index = parseInt(target, 10) - 1;
      if (isNaN(index) || index < 0 || index >= conversations.length) {
        await this.sendToChannel(ctx, `❓ 无效的序号: ${target}\n\n使用 /sessions 查看有效序号。`);
        return;
      }
      const targetSession = conversations[index];
      if (targetSession.sessionId === ctx.currentSessionId) {
        const title = targetSession.customTitle || targetSession.firstPrompt?.substring(0, 30) || "未命名";
        await this.sendToChannel(ctx, `ℹ️ 已经在这个会话中了：${title}`);
        return;
      }
      if (!this.sessionOwnership.claim(targetSession.sessionId, ctx.channelId)) {
        const owner = this.sessionOwnership.getOwner(targetSession.sessionId);
        await this.sendToChannel(ctx, `❌ 该会话已被通道 ${owner} 占用，无法切换。\n\n使用 /new 创建新会话。`);
        return;
      }
      ctx.currentSessionId = targetSession.sessionId;
      const title = targetSession.customTitle || targetSession.firstPrompt?.substring(0, 30) || "未命名";
      const timeAgo = this.formatTimeAgo(targetSession.lastTime || targetSession.modified || Date.now());
      await this.sendToChannel(ctx,
        `✅ 已切换到会话：${title}\n\n🕒 最后更新: ${timeAgo}\n\n💡 现在发送的消息将使用这个会话。`
      );
    } catch (err) {
      console.error(`[CC][${ctx.channelId}] 切换会话错误:`, err);
      await this.sendToChannel(ctx, "❌ 切换会话失败，请重试。");
    }
  }

  private async handleCurrentSession(ctx: ChannelContext): Promise<void> {
    console.log(`[CC][${ctx.channelId}] 显示当前会话`);
    if (!ctx.currentSessionId) {
      await this.sendToChannel(ctx, "ℹ️ 当前没有活跃的会话。\n\n使用 /new 创建会话，或 /sessions 选择一个历史会话。");
      return;
    }
    try {
      const conversation = await adapter.getHistory(this.cwd, ctx.currentSessionId);
      if (!conversation) {
        await this.sendToChannel(ctx, "❌ 当前会话不存在。\n\n使用 /new 创建新会话。");
        return;
      }
      let title = "未命名会话";
      let lastMessageTime: string | undefined;
      for (const msg of conversation.messages) {
        if (msg.type === "custom-title" && msg.customTitle) title = msg.customTitle;
        if (msg.timestamp) lastMessageTime = msg.timestamp;
      }
      if (title === "未命名会话") {
        const firstUserMsg = conversation.messages.find(m => m.type === "user" && m.message);
        if (firstUserMsg?.message?.content) {
          const content = firstUserMsg.message.content;
          if (typeof content === "string") {
            title = content.substring(0, 30);
          } else if (Array.isArray(content)) {
            const textBlock = content.find((b: any) => b.type === "text" && b.text);
            if (textBlock) title = textBlock.text.substring(0, 30);
          }
        }
      }
      const timeStr = lastMessageTime ? this.formatTimeAgo(lastMessageTime) : "未知";
      await this.sendToChannel(ctx,
        `📌 当前会话信息\n\n标题: ${title}\nID: ${conversation.sessionId}\n消息数: ${conversation.messages.length}\n最后活动: ${timeStr}`
      );
    } catch (err) {
      console.error(`[CC][${ctx.channelId}] 获取会话信息错误:`, err);
      await this.sendToChannel(ctx, "❌ 获取会话信息失败，请重试。");
    }
  }

  private async handleDevice(ctx: ChannelContext): Promise<void> {
    console.log(`[CC][${ctx.channelId}] 查询设备信息`);
    try {
      const config = loadConfig(this.cwd) as DeviceConfig;
      if (!config) {
        await this.sendToChannel(ctx, "❌ 未找到设备配置");
        return;
      }
      const createdAt = new Date(config.createdAt);
      const createdTimeStr = createdAt.toLocaleString("zh-CN", {
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit",
      });
      let output = "📱 当前设备信息\n\n";
      output += `设备 ID: ${config.deviceId}\n配对码: ${config.pairCode}\n`;
      if (config.routeToken) output += `连接码: ${config.routeToken}\n`;
      output += config.authToken ? "状态: ✅ 已配对\n" : "状态: ⏳ 未配对\n";
      output += `\n创建时间: ${createdTimeStr}`;
      await this.sendToChannel(ctx, output);
    } catch (err) {
      console.error(`[CC][${ctx.channelId}] 获取设备信息错误:`, err);
      await this.sendToChannel(ctx, "❌ 获取设备信息失败，请重试。");
    }
  }

  /** 获取或创建通道的 AbortController */
  private getChannelAbort(channelId: string): AbortController {
    let ac = this.channelAbortControllers.get(channelId);
    if (!ac || ac.signal.aborted) {
      ac = new AbortController();
      this.channelAbortControllers.set(channelId, ac);
    }
    return ac;
  }

  /**
   * /stop - 一键停止当前正在执行的任务
   * 1. 中止任务队列（当前任务 + 待执行）
   * 2. 关闭当前 Claude session（打断 stream）
   * 3. CLI 引擎子进程由 AbortSignal 自动 kill
   */
  private async handleStopTask(ctx: ChannelContext): Promise<void> {
    console.log(`[CC][${ctx.channelId}] /stop 一键停止`);
    const parts: string[] = [];

    // 1. 中止任务队列
    const queueResult = taskQueueManager.abort(ctx.channelId);
    if (queueResult.abortedRunning) {
      parts.push("已中止正在执行的后台任务");
    }
    if (queueResult.cancelledCount > 0) {
      parts.push(`已取消 ${queueResult.cancelledCount} 个排队任务`);
    }

    // 2. 中止非队列任务（CLI 引擎等）
    const ac = this.channelAbortControllers.get(ctx.channelId);
    if (ac && !ac.signal.aborted) {
      ac.abort();
      parts.push("已中止 CLI 引擎任务");
    }
    // 重置 abort controller
    this.channelAbortControllers.set(ctx.channelId, new AbortController());

    // 3. 关闭当前 Claude session（打断正在进行的 stream）
    if (ctx.currentSessionId) {
      adapter.closeSession(ctx.currentSessionId);
      parts.push(`已关闭会话 ${ctx.currentSessionId.substring(0, 8)}...`);
      ctx.currentSessionId = null;
    }

    if (parts.length === 0) {
      await this.sendToChannel(ctx, "当前没有正在执行的任务。");
    } else {
      await this.sendToChannel(ctx, `⏹️ 已停止\n\n${parts.map(p => `• ${p}`).join("\n")}`);
    }
  }

  /**
   * /reset - 重置会话（比 /new 更彻底：关闭 session + 清空上下文）
   */
  private async handleResetSession(ctx: ChannelContext): Promise<void> {
    console.log(`[CC][${ctx.channelId}] /reset 重置会话`);

    // 先停止任务
    const queueResult = taskQueueManager.abort(ctx.channelId);

    // 关闭当前 session
    if (ctx.currentSessionId) {
      adapter.closeSession(ctx.currentSessionId);
    }
    ctx.currentSessionId = null;

    const extra = queueResult.abortedRunning || queueResult.cancelledCount > 0
      ? `（同时停止了 ${queueResult.abortedRunning ? "当前任务" : ""}${queueResult.cancelledCount > 0 ? ` + ${queueResult.cancelledCount} 个排队任务` : ""}）`
      : "";

    await this.sendToChannel(ctx, `🔄 会话已重置${extra}\n\n下一条消息将开始全新对话。`);
  }

  /**
   * /queue - 查看当前通道的任务队列状态
   */
  private async handleQueueInfo(ctx: ChannelContext): Promise<void> {
    const info = taskQueueManager.getQueueInfo(ctx.channelId);

    if (!info.running && info.pending === 0) {
      await this.sendToChannel(ctx, "📭 当前没有任务在队列中。");
      return;
    }

    const lines: string[] = ["📋 任务队列状态\n"];

    if (info.currentTask) {
      const elapsed = info.currentTask.startedAt
        ? ((Date.now() - info.currentTask.startedAt.getTime()) / 1000).toFixed(0)
        : "?";
      const preview = info.currentTask.message.substring(0, 50);
      lines.push(`▶️ 正在执行: ${preview}${preview.length >= 50 ? "..." : ""}`);
      lines.push(`   已运行 ${elapsed}s`);
    }

    if (info.pending > 0) {
      lines.push(`\n⏳ 排队中: ${info.pending} 个任务`);
    }

    lines.push(`\n💡 发送 /stop 可中止所有任务`);
    await this.sendToChannel(ctx, lines.join("\n"));
  }

  private async handleHelp(ctx: ChannelContext): Promise<void> {
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
      "**任务控制**\n" +
      "/stop - 停止当前任务（一键中止）\n" +
      "/queue - 查看任务队列状态\n" +
      "/reset - 重置会话（关闭 session + 清空上下文）\n" +
      "/restart - 重启 mycc 后端\n\n" +
      "**其他**\n" +
      "/help - 显示此帮助信息\n\n" +
      "**示例**\n" +
      "/new 分析代码\n/sessions\n/switch 1\n/stop\n/restart\n\n" +
      "💡 提示：非命令消息会发送到当前活跃会话";
    await this.sendToChannel(ctx, helpText);
  }

  private async handleSearch(ctx: ChannelContext, query: string): Promise<void> {
    const trimmedQuery = query?.trim();
    if (!trimmedQuery) {
      await this.sendToChannel(ctx, "🔍 用法: /搜索 <关键词>\n\n示例: /搜索 IPO报告\n      /搜索 飞书机器人配置");
      return;
    }
    console.log(`[CC][${ctx.channelId}] 搜索: ${trimmedQuery}`);
    try {
      const index = getOrBuildIndex(this.cwd);
      if (index.N === 0) {
        await this.sendToChannel(ctx, "📭 暂无历史会话记录");
        return;
      }
      const rawResults = searchBM25(trimmedQuery, index, 50);
      const results = this.sessionOwnership.filterForChannel(rawResults, ctx.channelId).slice(0, 10);
      if (results.length === 0) {
        await this.sendToChannel(ctx, `🔍 没有找到包含 "${trimmedQuery}" 的历史会话`);
        return;
      }
      let response = `🔍 搜索 "${trimmedQuery}" 找到 ${results.length} 个相关会话:\n\n`;
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const preview = r.preview.length > 60 ? r.preview.substring(0, 60) + "..." : r.preview;
        response += `${i + 1}. ${preview}\n   └ 会话ID: ${r.sessionId}\n\n`;
      }
      response += "💡 回复 [序号] 可切换到对应会话";
      await this.sendToChannel(ctx, response);
    } catch (err) {
      console.error(`[CC][${ctx.channelId}] 搜索出错:`, err);
      await this.sendToChannel(ctx, `❌ 搜索失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 发送消息到指定飞书通道（隔离路由，不广播到其他通道）
   */
  private async sendToChannel(ctx: ChannelContext, text: string): Promise<void> {
    await ctx.channel.send({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
      },
    } as any, ctx.replyChatId);
  }

  /**
   * 向所有飞书通道广播消息（用于系统级通知，如 auth 过期）
   */
  async broadcastToFeishu(text: string): Promise<void> {
    for (const ctx of this.channelContexts.values()) {
      try {
        await this.sendToChannel(ctx, text);
      } catch (err) {
        console.error(`[CC][${ctx.channelId}] 广播失败:`, err);
      }
    }
  }

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
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace("Bearer ", "");
    if (!this.state.paired || token !== this.state.token) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "未授权" }));
      return;
    }
    try {
      const url = new URL(req.url || "", `http://${req.headers.host}`);
      const limitParam = url.searchParams.get("limit");
      const limit = limitParam ? parseInt(limitParam, 10) : 20;
      const result = await adapter.listHistory(this.cwd, limit);
      console.log(`[History] 返回 ${result.conversations.length}/${result.total} 条历史记录`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (error) {
      console.error("[History] List error:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "获取历史记录失败" }));
    }
  }

  private async handleHistoryDetail(req: http.IncomingMessage, res: http.ServerResponse, pathname: string) {
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace("Bearer ", "");
    if (!this.state.paired || token !== this.state.token) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "未授权" }));
      return;
    }
    const sessionId = pathname.replace("/history/", "");
    if (!sessionId || sessionId === "list") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "无效的 sessionId" }));
      return;
    }
    try {
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
      if (!sessionId || typeof newTitle !== "string") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "sessionId and newTitle are required" }));
        return;
      }
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
      this.server.once('error', (err) => {
        reject(err);
      });
      const port = Number(process.env.PORT || 18080);
      this.server.listen(port, async () => {
        console.log(`[${this.isTls ? "HTTPS" : "HTTP"}] 服务启动在端口 ${port}`);
        await this.channelManager.startAll();
        this.startTokenKeepalive();
        resolve(port);
      });
    });
  }

  /**
   * 飞书 MCP Token 保活 — 每 30 分钟刷新一次
   *
   * 飞书 OAuth access_token 有效期 2h，refresh_token 有效期 30 天。
   * 定期调用一次简单 API，触发 MCP server 内部的 auto-refresh 机制，
   * 确保 token 文件始终有效，3 个机器人随时可调用。
   */
  private tokenKeepaliveTimer: ReturnType<typeof setInterval> | null = null;

  private startTokenKeepalive(): void {
    const INTERVAL = 30 * 60_000; // 30 min
    const TOKEN_FILE = join(process.env.HOME || "/tmp", ".feishu-mcp/tokens.json");

    const refreshToken = async () => {
      try {
        if (!existsSync(TOKEN_FILE)) {
          console.log("[TokenKeepalive] tokens.json 不存在，跳过（需手动授权）");
          return;
        }
        const tokens = JSON.parse(readFileSync(TOKEN_FILE, "utf-8"));
        const appId = "cli_a9f1cd1366751bc7";
        const cached = tokens[appId];
        if (!cached) {
          console.log("[TokenKeepalive] 无 MCP token 缓存，跳过");
          return;
        }

        const remainingMin = (cached.expiresAt - Date.now()) / 60_000;
        console.log(`[TokenKeepalive] token 剩余 ${remainingMin.toFixed(1)} 分钟`);

        // 如果还有超过 60 分钟有效期，不需要刷新
        if (remainingMin > 60) {
          console.log("[TokenKeepalive] token 充足，无需刷新");
          return;
        }

        // 用 refresh_token 主动刷新
        if (!cached.refreshToken) {
          console.log("[TokenKeepalive] 无 refresh_token，需手动重新授权");
          return;
        }

        console.log("[TokenKeepalive] token 即将过期，主动刷新...");
        const resp = await fetch("https://open.feishu.cn/open-apis/authen/v2/oauth/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            grant_type: "refresh_token",
            refresh_token: cached.refreshToken,
            client_id: appId,
            client_secret: "RCCkaaPGkGn9n3pEDkjjzhrUDEWhmioy",
          }),
        });
        const data = await resp.json() as any;

        if (data.access_token) {
          tokens[appId] = {
            ...cached,
            accessToken: data.access_token,
            refreshToken: data.refresh_token || cached.refreshToken,
            expiresAt: Date.now() + (data.expires_in || 7200) * 1000,
          };
          const { writeFileSync: ws, mkdirSync: md } = await import("fs");
          const dir = join(process.env.HOME || "/tmp", ".feishu-mcp");
          if (!existsSync(dir)) md(dir, { recursive: true });
          ws(TOKEN_FILE, JSON.stringify(tokens, null, 2), "utf-8");
          console.log("[TokenKeepalive] token 刷新成功 ✓");
        } else {
          console.error("[TokenKeepalive] 刷新失败:", JSON.stringify(data));
        }
      } catch (err: any) {
        console.error("[TokenKeepalive] 异常:", err.message);
      }
    };

    // 启动后立即检查一次
    refreshToken();
    this.tokenKeepaliveTimer = setInterval(refreshToken, INTERVAL);
    console.log("[TokenKeepalive] 已启动，每 30 分钟检查一次");
  }

  stop() {
    if (this.tokenKeepaliveTimer) clearInterval(this.tokenKeepaliveTimer);
    this.channelManager.stopAll();
    this.server.close();
  }
}
