/**
 * 飞书通道
 *
 * 支持双向通信：
 * - 发送：将 Claude Code 回复发送到飞书
 * - 接收：通过 WebSocket 接收飞书消息并转发给 Claude Code
 */

import type { MessageChannel } from "./interface.js";
import type { SSEEvent } from "../adapters/interface.js";
import Lark from "@larksuiteoapi/node-sdk";

/**
 * 飞书通道配置
 */
export interface FeishuChannelConfig {
  /** 通道 ID，用于多实例区分，默认 "feishu" */
  id?: string;
  /** 飞书应用 ID */
  appId: string;
  /** 飞书应用密钥 */
  appSecret: string;
  /** 接收消息的用户/群组 Open ID */
  receiveUserId?: string;
  /** 接收 ID 类型：open_id（用户）或 chat_id（群聊） */
  receiveIdType?: "open_id" | "chat_id";
  /** 连接模式：websocket（长连接）或 poll（轮询） */
  connectionMode?: "websocket" | "poll";
  /** Encrypt Key（用于验证事件推送） */
  encryptKey?: string;
  /** Verification Token（用于验证事件推送） */
  verificationToken?: string;
  /** 是否显示工具调用：true（显示）或 false（不显示），默认 true */
  showToolUse?: boolean;
}

/**
 * 图片上传响应
 */
interface FeishuUploadResponse {
  code: number;
  msg: string;
  data: {
    image_key: string;
  };
}

/**
 * 进度卡片数据结构（用于可视化多引擎工作流）
 */
export interface ProgressCard {
  /** 卡片标题 */
  title?: string;
  /** 任务描述 */
  task?: string;
  /** 各引擎状态 */
  engines: ProgressEngine[];
  /** 底部备注 */
  footer?: string;
  /** 手动指定进度百分比（0-100），覆盖引擎计数默认值 */
  progress?: number;
}

export interface ProgressEngine {
  /** 引擎名称 */
  name: string;
  /** 状态 */
  status: "waiting" | "running" | "done" | "error";
  /** 耗时（如 "3.2s"） */
  elapsed?: string;
  /** 补充信息（如 "调用了 3 个工具"） */
  detail?: string;
}

/**
 * 飞书消息通道
 *
 * 实现消息过滤、发送和接收功能
 * 支持双向通信：发送 Claude 回复到飞书，接收飞书消息并转发给 Claude
 */
export class FeishuChannel implements MessageChannel {
  readonly id: string;

  private config: FeishuChannelConfig;
  private client: Lark.Client; // SDK Client，自动管理 token
  private accessToken: string | null = null; // 仅用于图片上传/下载等 SDK 未覆盖的操作
  private tokenExpireTime: number = 0;
  private pendingImages = new Map<string, string>(); // sessionId → image_key

  // WebSocket 相关
  private wsClient: Lark.WSClient | null = null;
  private eventDispatcher: Lark.EventDispatcher | null = null;
  private messageCallback: ((message: string, images?: Array<{ data: string; mediaType: string }>, messageId?: string, chatId?: string, chatType?: string, parentId?: string) => void) | null = null;

  // 表态相关（"正在输入" emoji）
  private currentMessageId: string | null = null;
  private currentReactionId: string | null = null;

  // 动态回复目标：优先回复到来源 chat_id，而不是固定的 open_id
  private lastIncomingChatId: string | null = null;

  // 机器人自身的 open_id 和名称，用于群聊 @mention 过滤
  private botOpenId: string | null = null;
  private botName: string | null = null;

  // 群聊消息内存缓存：chatId → 最近 N 条消息（从 WebSocket 事件实时采集，不依赖 API 权限）
  private chatMessageBuffer: Map<string, Array<{ sender: string; text: string; timestamp: number }>> = new Map();
  private readonly CHAT_BUFFER_MAX = 30; // 每个群最多缓存 30 条

  // 消息去重：防止飞书 WebSocket 重复投递同一条消息
  private processedMessageIds: Set<string> = new Set();
  private readonly DEDUP_MAX = 200; // 最多缓存 200 条 message_id

  /**
   * 从飞书 interactive 卡片 JSON 中递归提取文本内容
   */
  private static extractCardText(cardJson: string): string {
    try {
      const card = JSON.parse(cardJson);
      const textParts: string[] = [];
      if (card.header?.title?.content) textParts.push(card.header.title.content);
      const extract = (elements: any[]): void => {
        if (!Array.isArray(elements)) return;
        for (const el of elements) {
          if (el.tag === "markdown" && el.content) textParts.push(el.content);
          else if (el.tag === "div" && el.text?.content) textParts.push(el.text.content);
          else if (el.tag === "plain_text" && el.content) textParts.push(el.content);
          else if (el.tag === "lark_md" && el.content) textParts.push(el.content);
          if (el.columns) {
            for (const col of el.columns) {
              if (col.elements) extract(col.elements);
            }
          }
          if (el.elements) extract(el.elements);
        }
      };
      if (card.elements) extract(card.elements);
      if (card.body?.elements) extract(card.body.elements);
      return textParts.join("\n").trim();
    } catch {
      return "";
    }
  }

  constructor(config?: FeishuChannelConfig) {
    this.id = config?.id ?? 'feishu';
    // 从环境变量读取配置
    this.config = config || {
      appId: process.env.FEISHU_APP_ID || "",
      appSecret: process.env.FEISHU_APP_SECRET || "",
      receiveUserId: process.env.FEISHU_RECEIVE_USER_ID,
      receiveIdType: (process.env.FEISHU_RECEIVE_ID_TYPE as "open_id" | "chat_id") || "open_id",
      connectionMode: (process.env.FEISHU_CONNECTION_MODE as "websocket" | "poll") || "websocket",
      encryptKey: process.env.FEISHU_ENCRYPT_KEY,
      verificationToken: process.env.FEISHU_VERIFICATION_TOKEN,
      showToolUse: process.env.FEISHU_SHOW_TOOL_USE === "false" ? false : true, // 默认 true
    };

    // 初始化 SDK Client（自动管理 token，无需手动 getAccessToken）
    this.client = new Lark.Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      domain: Lark.Domain.Feishu,
    });
  }

  /**
   * 消息过滤器 - 支持 v1 和 v2 SDK 的事件类型
   * v1: text, content_block_delta, system, tool_use
   * v2: assistant (包含消息内容), system
   */
  filter(event: SSEEvent): boolean {
    const eventType = event.type as string;

    const textOnlyTypes = ["text", "content_block_delta", "system", "assistant"];
    const allTypes = ["text", "content_block_delta", "system", "assistant", "tool_use"];

    // 根据配置决定是否显示工具调用
    if (this.config.showToolUse) {
      return allTypes.includes(eventType);
    } else {
      return textOnlyTypes.includes(eventType);
    }
  }

  /**
   * 发送消息到飞书
   * @param event - SSE 事件
   */
  async send(event: SSEEvent, targetChatId?: string): Promise<void> {
    // 如果没有配置飞书凭证，静默跳过
    if (!this.config.appId || !this.config.appSecret) {
      return;
    }

    // 没有配置接收用户且没有动态回复目标，跳过
    if (!this.config.receiveUserId && !this.lastIncomingChatId && !targetChatId) {
      return;
    }

    // 请求级 targetChatId 优先于 channel 级 lastIncomingChatId
    const effectiveChatId = targetChatId || this.lastIncomingChatId || undefined;

    // 处理 system 事件（提取图片信息）
    if (event.type === "system") {
      const systemEvent = event as Record<string, unknown>;
      // 检查是否有图片数据
      if ("images" in systemEvent && Array.isArray(systemEvent.images)) {
        const sessionId = String(systemEvent.session_id || "default");
        await this.handleImages(sessionId, systemEvent.images as Array<{ data: string; mediaType: string }>);
      }
      return;
    }

    // 处理 tool_use 事件（工具调用）
    if (event.type === "tool_use") {
      if (!this.config.showToolUse) {
        return;
      }
      const toolEvent = event as Record<string, unknown>;
      const toolContent = this.formatToolUse(toolEvent);
      if (toolContent) {
        const sessionId = this.extractSessionId(event);
        await this.sendMessageToFeishu(toolContent, sessionId, effectiveChatId);
      }
      return;
    }

    // 处理 v2 SDK 的 assistant 事件（包含消息内容）
    // P1 优化：将所有 content blocks 合并为单条消息发送，而非逐条发送
    if (event.type === "assistant") {
      const assistantEvent = event as Record<string, unknown>;

      if ("message" in assistantEvent && typeof assistantEvent.message === "object") {
        const message = assistantEvent.message as Record<string, unknown>;
        if ("content" in message && Array.isArray(message.content)) {
          // 按原始顺序收集所有 blocks 到一个数组
          const parts: string[] = [];

          for (const block of message.content) {
            if (typeof block === "object" && block !== null) {
              if ("type" in block && block.type === "text" && "text" in block) {
                parts.push(String(block.text));
              } else if ("type" in block && block.type === "tool_use" && this.config.showToolUse) {
                const toolCall = this.formatToolUseBlock(block as Record<string, unknown>);
                if (toolCall) {
                  parts.push(toolCall);
                }
              }
            }
          }

          // 合并所有内容为单条消息发送（1 次 API 调用代替 N 次）
          if (parts.length > 0) {
            const combined = parts.join("\n\n");
            const sessionId = this.extractSessionId(event);
            console.log(`[FeishuChannel] 合并 ${parts.length} 个 block 为单条消息发送`);
            await this.sendMessageToFeishu(combined, sessionId, effectiveChatId);
          }
        }
      }

      return;
    }

    // 提取文本内容和 session_id
    const text = this.extractText(event);
    const sessionId = this.extractSessionId(event);

    if (!text) {
      return;
    }

    // 发送消息到飞书（先发送图片，再发送文字）
    await this.sendMessageToFeishu(text, sessionId, effectiveChatId);
  }

  /**
   * 设置消息接收回调
   * @param callback - 收到飞书消息时的回调函数
   */
  onMessage(callback: (message: string, images?: Array<{ data: string; mediaType: string }>, messageId?: string, chatId?: string, chatType?: string, parentId?: string) => void): void {
    this.messageCallback = callback;
  }

  /**
   * 启动飞书通道（验证凭证 + 启动 WebSocket）
   */
  async start(): Promise<void> {
    if (!this.config.appId || !this.config.appSecret) {
      console.log("[FeishuChannel] Not configured, skipping");
      return;
    }

    // 飞书是国内服务，不走代理（axios 通过 HTTP 代理发 HTTPS 会导致 400）
    // 必须在任何 API 调用之前设置，否则第一个通道的 getAccessToken 会走代理失败
    const noProxy = process.env.NO_PROXY || process.env.no_proxy || "";
    if (!noProxy.includes("feishu.cn")) {
      const updated = [noProxy, "*.feishu.cn"].filter(Boolean).join(",");
      process.env.NO_PROXY = updated;
      process.env.no_proxy = updated;
      console.log(`[FeishuChannel] 已设置 NO_PROXY=${updated}`);
    }

    // 验证凭证
    const token = await this.getAccessToken();
    if (!token) {
      console.error("[FeishuChannel] ✗ Invalid credentials");
      return;
    }

    console.log("[FeishuChannel] ✓ Credentials validated");
    console.log(`[FeishuChannel] Will send to: ${this.config.receiveUserId || "未配置接收用户"}`);

    // 获取机器人自身的 open_id（用于群聊 @mention 过滤）
    try {
      const botInfoRes = await this.client.request({
        method: "GET",
        url: "https://open.feishu.cn/open-apis/bot/v3/info",
      }) as any;
      if (botInfoRes?.bot?.open_id) {
        this.botOpenId = botInfoRes.bot.open_id;
        this.botName = botInfoRes.bot?.app_name || null;
        console.log(`[FeishuChannel:${this.id}] 机器人 open_id: ${this.botOpenId}, 名称: ${this.botName}`);
      }
    } catch (err) {
      console.warn(`[FeishuChannel:${this.id}] 获取机器人 open_id 失败（群聊 @mention 过滤将不可用）:`, err);
    }

    // 启动 WebSocket 连接（如果配置了）
    if (this.config.connectionMode === "websocket") {
      await this.startWebSocket();
    } else {
      console.log("[FeishuChannel] WebSocket disabled (polling mode)");
    }
  }

  /**
   * 启动 WebSocket 连接
   */
  private async startWebSocket(): Promise<void> {
    try {
      // 创建 Event Dispatcher（只在配置了加密密钥时传入）
      const dispatcherOptions: {
        encryptKey?: string;
        verificationToken?: string;
      } = {};
      if (this.config.encryptKey) {
        dispatcherOptions.encryptKey = this.config.encryptKey;
      }
      if (this.config.verificationToken) {
        dispatcherOptions.verificationToken = this.config.verificationToken;
      }

      this.eventDispatcher = new Lark.EventDispatcher(dispatcherOptions);

      // 注册多个事件类型（参考 monitor.ts）
      this.eventDispatcher.register({
        // 消息接收事件
        "im.message.receive_v1": async (data) => {
          try {
            console.log(`[FeishuChannel:${this.id}] [DEBUG] 收到 im.message.receive_v1 事件`);
            const event = data as any;
            const messageId = event?.message?.message_id;

            // 消息去重：飞书 WebSocket 可能重复投递同一条消息
            if (messageId && this.processedMessageIds.has(messageId)) {
              console.log(`[FeishuChannel:${this.id}] [DEDUP] 跳过重复消息: ${messageId}`);
              return;
            }
            if (messageId) {
              this.processedMessageIds.add(messageId);
              // 超过上限时清理最早的（Set 按插入顺序迭代）
              if (this.processedMessageIds.size > this.DEDUP_MAX) {
                const first = this.processedMessageIds.values().next().value;
                if (first) this.processedMessageIds.delete(first);
              }
            }

            const chatId = event?.message?.chat_id;
            const parentId = event?.message?.parent_id; // 回复消息的父消息 ID
            const rootId = event?.message?.root_id; // 回复线程的根消息 ID
            const upperMessageId = event?.message?.upper_message_id; // 合并转发/多选的上层消息 ID

            // 回复消息诊断日志（始终打印 p2p 的关键字段，方便排查回复上下文注入）
            const chatType = event?.message?.chat_type;
            if (chatType === "p2p") {
              console.log(`[FeishuChannel:${this.id}] [P2P-MSG] message keys: ${Object.keys(event?.message || {}).join(",")}`);
              console.log(`[FeishuChannel:${this.id}] [P2P-MSG] parent_id=${parentId}, root_id=${rootId}, upper_message_id=${upperMessageId}`);
            } else if (parentId || rootId || upperMessageId) {
              console.log(`[FeishuChannel:${this.id}] [REPLY] parent_id=${parentId}, root_id=${rootId}, upper_message_id=${upperMessageId}, chat_type=${chatType}`);
            }

            // 群聊消息缓存：所有群聊消息都缓存（@mention 过滤之前），用于上下文注入
            if (chatType === "group" && chatId) {
              this.bufferChatMessage(chatId, event);
            }

            // 过滤机器人消息：忽略其他机器人（app）发送的消息，避免群内机器人互相触发
            const senderType = event?.sender?.sender_type;
            if (senderType === "app") {
              console.log(`[FeishuChannel:${this.id}] 忽略来自机器人的消息（sender_type=app）`);
              return;
            }

            // 群聊 @mention 过滤：只处理 @自己 的消息
            if (chatType === "group" && (this.botOpenId || this.botName)) {
              const mentions: Array<{ id?: { open_id?: string }; key?: string; name?: string }> = event?.message?.mentions || [];
              console.log(`[FeishuChannel:${this.id}] 群聊 mentions: ${JSON.stringify(mentions.map(m => ({ key: m.key, open_id: m.id?.open_id, name: m.name })))}, 本机器人: ${this.botOpenId} (${this.botName})`);
              // 双重匹配：open_id 或 bot 名称（飞书 open_id 跨应用不稳定）
              const isMentioned = mentions.some(m =>
                (this.botOpenId && m.id?.open_id === this.botOpenId) ||
                (this.botName && m.name === this.botName)
              );
              if (!isMentioned) {
                console.log(`[FeishuChannel:${this.id}] 群聊消息未 @本机器人，跳过`);
                return;
              }
            }

            // 记录来源 chat_id（移到过滤器之后，防止 bot 消息/未 @mention 的群聊消息覆盖路由）
            if (chatId) {
              this.lastIncomingChatId = chatId;
              console.log(`[FeishuChannel:${this.id}] 来源 chat_id: ${chatId} (${chatType || "p2p"})`);
            }

            // 添加"正在输入"表态（敲键盘 emoji）
            if (messageId) {
              this.addTypingIndicator(messageId).catch(() => {
                // 静默失败，不影响主流程
              });
            }

            // await 解析结果（图片下载是异步的）
            const parsed = await this.parseFeishuMessage(event, messageId);
            if (parsed && this.messageCallback) {
              let { text, images } = parsed;
              // 群聊中去掉 @mention 占位符（如 @_user_1）
              if (chatType === "group" && text) {
                text = text.replace(/@_user_\d+/g, "").trim();
              }
              if (text || images) {
                console.log(`[FeishuChannel] ✓ 收到消息: ${text ? text.substring(0, 50) : "[图片]"}...`);
                // 传递消息 ID，以便后续可以删除表态
                this.messageCallback(text, images, messageId, chatId, chatType, parentId || rootId || upperMessageId);
              } else {
                console.log("[FeishuChannel] [DEBUG] 解析消息内容为空");
              }
            }
          } catch (err) {
            console.error("[FeishuChannel] 消息处理错误:", err);
          }
        },
        // 消息已读事件（忽略）
        "im.message.message_read_v1": async () => {
          console.log("[FeishuChannel] [DEBUG] 收到 im.message.message_read_v1 事件（忽略）");
        },
        // 机器人被添加到群聊事件
        "im.chat.member.bot.added_v1": async (data) => {
          try {
            const event = data as any;
            console.log(`[FeishuChannel] ✓ 机器人被添加到群聊: ${event?.chat_id || "unknown"}`);
          } catch (err) {
            console.error("[FeishuChannel] 处理机器人添加事件错误:", err);
          }
        },
        // 机器人被移出群聊事件
        "im.chat.member.bot.deleted_v1": async (data) => {
          try {
            const event = data as any;
            console.log(`[FeishuChannel] ✓ 机器人被移出群聊: ${event?.chat_id || "unknown"}`);
          } catch (err) {
            console.error("[FeishuChannel] 处理机器人移除事件错误:", err);
          }
        },
      });

      // 创建 WebSocket 客户端
      this.wsClient = new Lark.WSClient({
        appId: this.config.appId,
        appSecret: this.config.appSecret,
        domain: Lark.Domain.Feishu,
        loggerLevel: Lark.LoggerLevel.info,
      });

      // 启动连接（SDK 内部管理重连，无需手动监听 close/error）
      this.wsClient.start({ eventDispatcher: this.eventDispatcher });
      console.log("[FeishuChannel] ✓ WebSocket 已启动（SDK 自动管理重连）");
      console.log("[FeishuChannel] [INFO] 已注册事件: im.message.receive_v1, im.message.message_read_v1, im.chat.member.bot.added_v1, im.chat.member.bot.deleted_v1");
    } catch (err) {
      console.error("[FeishuChannel] ✗ WebSocket 启动失败:", err);
    }
  }

  /**
   * 解析飞书消息（异步，支持图片下载）
   */
  private parseFeishuMessage(event: any, messageId?: string): Promise<{ text: string; images?: Array<{ data: string; mediaType: string }> } | null> {
    try {
      // 事件结构: event.sender + event.message（不是 event.event.message）
      if (!event?.message) return Promise.resolve(null);

      const message = event.message;
      const messageType = message.message_type;
      const content = message.content;

      if (messageType === "text") {
        // 文本消息 - content 是 JSON 字符串
        if (typeof content === "string") {
          const parsed = JSON.parse(content);
          return Promise.resolve({ text: parsed.text || "" });
        }
        // 兜底：content 可能已经是对象
        return Promise.resolve({ text: content?.text || "" });
      }

      if (messageType === "image") {
        // 图片消息 - content 是 JSON 字符串
        console.log(`[FeishuChannel] 收到图片消息`);
        if (typeof content === "string") {
          const parsed = JSON.parse(content);
          const imageKey = parsed.image_key;
          if (imageKey) {
            // 需要通过飞书 API 获取图片数据
            return this.downloadImageFromFeishu(imageKey, messageId).then(data => ({
              text: "",
              images: data ? [{ data, mediaType: "image/png" }] : undefined
            }));
          }
        }
        console.log(`[FeishuChannel] 图片消息没有 image_key`);
        return Promise.resolve({ text: "" });
      }

      if (messageType === "post") {
        // 富文本消息 - 提取所有 text 节点
        if (typeof content === "string") {
          const parsed = JSON.parse(content);
          // post 结构: { zh_cn: { content: [[{tag:"text",text:"..."}, {tag:"at",...}]] } }
          // 也可能是 { content: [[...]] }
          const paragraphs = parsed?.zh_cn?.content || parsed?.content || [];
          const texts: string[] = [];
          for (const para of paragraphs) {
            if (Array.isArray(para)) {
              for (const node of para) {
                if (node.tag === "text" && node.text) {
                  texts.push(node.text);
                } else if (node.tag === "a" && node.text) {
                  // 超链接节点也提取文本
                  texts.push(node.text);
                }
              }
            }
          }
          const combined = texts.join("").replace(/@_user_\d+/g, "").trim();
          if (combined) {
            return Promise.resolve({ text: combined });
          }
        }
        console.log(`[FeishuChannel] post 消息解析为空`);
        return Promise.resolve(null);
      }

      // 其他类型消息暂不支持
      console.log(`[FeishuChannel] 暂不支持的消息类型: ${messageType}`);
      return Promise.resolve(null);
    } catch (err) {
      console.error("[FeishuChannel] 解析消息失败:", err);
      return Promise.resolve(null);
    }
  }

  /**
   * 停止飞书通道
   */
  stop() {
    this.accessToken = null;
    this.pendingImages.clear();

    // 停止 WebSocket
    if (this.wsClient) {
      try {
        this.wsClient.close();
        console.log("[FeishuChannel] WebSocket 已停止");
      } catch {
        // 静默处理
      }
      this.wsClient = null;
    }
    this.eventDispatcher = null;
    this.messageCallback = null;
  }

  /**
   * 从 SSE 事件中提取文本内容
   */
  private extractText(event: SSEEvent): string {
    if (event.type === "text") {
      return String(event.text ?? "");
    }

    if (event.type === "content_block_delta") {
      const delta = event.delta as { text?: string } | undefined;
      return delta?.text ?? "";
    }

    return "";
  }

  /**
   * 从 SSE 事件中提取 session_id
   */
  private extractSessionId(event: SSEEvent): string | undefined {
    if (event && typeof event === "object" && "session_id" in event) {
      return String(event.session_id);
    }
    return undefined;
  }

  /**
   * 格式化 tool_use 事件为可读文本
   */
  private formatToolUse(event: Record<string, unknown>): string {
    try {
      const name = event.name as string || "unknown";
      const input = event.input as Record<string, unknown> || {};

      let output = `🔧 使用工具: **${name}**\n`;

      // 格式化输入参数
      if (Object.keys(input).length > 0) {
        output += "```\n";
        output += JSON.stringify(input, null, 2);
        output += "\n```\n";
      }

      return output;
    } catch (err) {
      console.error("[FeishuChannel] 格式化工具调用失败:", err);
      return "🔧 使用工具（详情解析失败）";
    }
  }

  /**
   * 格式化 assistant 事件中的 tool_use block
   */
  private formatToolUseBlock(block: Record<string, unknown>): string | null {
    try {
      const name = block.name as string || "unknown";
      const input = block.input as Record<string, unknown> || {};

      let output = `🔧 **${name}**`;

      // 如果有输入参数，简要显示
      if (Object.keys(input).length > 0) {
        const inputStr = JSON.stringify(input);
        if (inputStr.length > 100) {
          output += ` ${inputStr.substring(0, 100)}...`;
        } else {
          output += ` ${inputStr}`;
        }
      }

      return output;
    } catch (err) {
      console.error("[FeishuChannel] 格式化工具调用失败:", err);
      return "🔧 工具调用（详情解析失败）";
    }
  }

  /**
   * 处理图片（上传到飞书并保存 image_key）
   */
  private async handleImages(sessionId: string, images: Array<{ data: string; mediaType: string }>): Promise<void> {
    if (!images || images.length === 0) {
      return;
    }

    // 只支持单张图片
    const image = images[0];

    try {
      // 上传图片到飞书
      const imageKey = await this.uploadImageToFeishu(image.data, image.mediaType);
      if (imageKey) {
        // 保存 image_key
        this.pendingImages.set(sessionId, imageKey);
        console.log(`[FeishuChannel] ✓ Image uploaded: ${imageKey}`);
      }
    } catch (error) {
      console.error("[FeishuChannel] ✗ Upload image error:", error);
    }
  }

  /**
   * 上传图片到飞书
   */
  private async uploadImageToFeishu(base64Data: string, mediaType: string): Promise<string | null> {
    try {
      // 获取访问令牌（如果需要）
      if (!this.accessToken || Date.now() > this.tokenExpireTime) {
        this.accessToken = await this.getAccessToken();
        if (!this.accessToken) {
          return null;
        }
      }

      // 将 base64 转换为 Buffer
      const buffer = Buffer.from(base64Data, "base64");

      // 上传图片
      const response = await fetch("https://open.feishu.cn/open-apis/im/v1/images", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.accessToken}`,
          "Content-Type": mediaType,
        },
        body: buffer,
      });

      const result = await response.json() as FeishuUploadResponse;
      if (result.code === 0 && result.data?.image_key) {
        return result.data.image_key;
      }

      console.error("[FeishuChannel] ✗ Upload failed:", result.msg);
      return null;
    } catch (error) {
      console.error("[FeishuChannel] ✗ Upload error:", error);
      return null;
    }
  }

  /**
   * 从飞书下载图片（通过 message_id 获取 base64 数据）
   *
   * 对于用户发送的图片：
   * 使用 messageResource API，直接将 image_key 作为 file_key 使用
   *
   * 参考 openclaw 实现：
   * "For message media, always use messageResource API
   *  The image.get API is only for images uploaded via im/v1/images, not for message attachments"
   */
  private async downloadImageFromFeishu(imageKey: string, messageId?: string): Promise<string | null> {
    try {
      // 获取访问令牌（如果需要）
      if (!this.accessToken || Date.now() > this.tokenExpireTime) {
        this.accessToken = await this.getAccessToken();
        if (!this.accessToken) {
          return null;
        }
      }

      // 如果有 messageId，使用 messageResource API 下载
      // 对于用户发送的图片，image_key 可以直接作为 file_key 使用
      if (messageId) {
        console.log(`[FeishuChannel] [DEBUG] Using messageResource API with image_key as file_key`);

        const resourceResponse = await fetch(
          `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${imageKey}?type=image`,
          {
            method: "GET",
            headers: {
              "Authorization": `Bearer ${this.accessToken}`,
            },
          }
        );

        if (resourceResponse.ok) {
          const buffer = await resourceResponse.arrayBuffer();
          const base64 = Buffer.from(buffer).toString("base64");
          console.log(`[FeishuChannel] ✓ Downloaded image: ${base64.length} bytes (base64)`);
          return base64;
        } else {
          const errorText = await resourceResponse.text();
          console.error(`[FeishuChannel] ✗ Resource download failed: ${resourceResponse.status}`, errorText.substring(0, 200));
          return null;
        }
      }

      // 没有 messageId 的情况：尝试直接下载
      // 注意：这只对机器人自己上传的图片有效（通过 im/v1/images 上传）
      console.log(`[FeishuChannel] [DEBUG] No messageId, trying direct image download (only works for bot-uploaded images)`);
      const directResponse = await fetch(`https://open.feishu.cn/open-apis/im/v1/images/${imageKey}`, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${this.accessToken}`,
        },
      });

      if (directResponse.ok) {
        const buffer = await directResponse.arrayBuffer();
        const base64 = Buffer.from(buffer).toString("base64");
        console.log(`[FeishuChannel] ✓ Downloaded image via direct API: ${base64.length} bytes (base64)`);
        return base64;
      } else {
        const errorText = await directResponse.text();
        console.error(`[FeishuChannel] ✗ Direct image download failed: ${directResponse.status}`, errorText.substring(0, 200));
        return null;
      }
    } catch (error) {
      console.error("[FeishuChannel] ✗ Download error:", error);
      return null;
    }
  }

  /**
   * 发送消息到飞书
   */
  private async sendMessageToFeishu(text: string, sessionId?: string, overrideChatId?: string): Promise<boolean> {
    try {
      // overrideChatId 已包含完整 fallback 链（由 send() 传入），此处不再二次 fallback lastIncomingChatId
      // 仅在 overrideChatId 为空时（如 broadcastToFeishu 等无来源的发送）才 fallback
      const effectiveTarget = overrideChatId || this.lastIncomingChatId;
      if (!overrideChatId && this.lastIncomingChatId) {
        console.log(`[FeishuChannel:${this.id}] ⚠️ sendMessageToFeishu: 无 overrideChatId，fallback 到 lastIncomingChatId=${this.lastIncomingChatId}`);
      }
      const receiveId = effectiveTarget || this.config.receiveUserId!;
      const receiveIdType = effectiveTarget ? "chat_id" : (this.config.receiveIdType || "open_id");
      const userId = receiveId;

      // 如果有待发送的图片，先发送图片
      if (sessionId && this.pendingImages.has(sessionId)) {
        const imageKey = this.pendingImages.get(sessionId)!;
        const imageSent = await this.sendViaSDK(userId, "image", JSON.stringify({ image_key: imageKey }), receiveIdType);
        if (imageSent.ok) {
          this.pendingImages.delete(sessionId);
        }
      }

      // 检查文本中是否包含表格
      const tableData = this.parseMarkdownTable(text);

      if (tableData) {
        // 降级链：交互卡片 → Markdown → 纯文本
        const cardContent = this.buildTableCard(tableData.beforeTable, tableData.headers, tableData.rows, tableData.afterTable);
        const cardSent = await this.sendViaSDK(userId, "interactive", JSON.stringify(cardContent), receiveIdType);
        if (cardSent.ok) return true;
        console.warn("[FeishuChannel] 交互卡片发送失败，降级到 Markdown");
      }

      // 降级链：Markdown → 纯文本
      const mdContent = JSON.stringify({ zh_cn: { content: [[{ tag: "md", text }]] } });
      const mdSent = await this.sendViaSDK(userId, "post", mdContent, receiveIdType);
      if (mdSent.ok) return true;

      console.warn("[FeishuChannel] Markdown 发送失败，降级到纯文本");
      const plainText = text
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/\*([^*]+)\*/g, "$1")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/```[\s\S]*?```/g, "[代码块]")
        .replace(/#{1,6}\s/g, "")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
      return (await this.sendViaSDK(userId, "text", JSON.stringify({ text: plainText }), receiveIdType)).ok;
    } catch (error) {
      console.error("[FeishuChannel] ✗ Send error:", error);
      return false;
    }
  }

  /**
   * 通过 SDK 发送消息（统一入口，SDK 自动管理 token）
   */
  private async sendViaSDK(receiveId: string, msgType: string, content: string, overrideIdType?: string): Promise<{ ok: boolean; messageId?: string }> {
    try {
      const idType = overrideIdType || this.config.receiveIdType || "open_id";
      const res = await this.client.im.message.create({
        params: { receive_id_type: idType as any },
        data: { receive_id: receiveId, msg_type: msgType, content },
      });

      if (res.code === 0) {
        const messageId = res.data?.message_id;
        console.log(`[FeishuChannel:${this.id}] ✓ Sent (${msgType}) to ${receiveId}: ${content.substring(0, 40)}...`);
        return { ok: true, messageId };
      }
      console.error(`[FeishuChannel:${this.id}] ✗ Send failed (${msgType}) to ${receiveId}:`, res.code, res.msg);
      return { ok: false };
    } catch (error) {
      console.error(`[FeishuChannel:${this.id}] ✗ SDK send error (${msgType}) to ${receiveId}:`, error);
      return { ok: false };
    }
  }

  /**
   * 发送进度卡片（可更新）
   * 返回 messageId，后续用 updateProgressCard 原地更新
   */
  async sendProgressCard(card: ProgressCard, overrideChatId?: string): Promise<string | null> {
    try {
      const effectiveTarget = overrideChatId || this.lastIncomingChatId;
      if (!overrideChatId && this.lastIncomingChatId) {
        console.log(`[FeishuChannel:${this.id}] ⚠️ sendProgressCard: 无 overrideChatId，fallback 到 lastIncomingChatId=${this.lastIncomingChatId}`);
      }
      const receiveId = effectiveTarget || this.config.receiveUserId!;
      const receiveIdType = effectiveTarget ? "chat_id" : (this.config.receiveIdType || "open_id");

      const cardJson = this.buildProgressCardJson(card);
      const result = await this.sendViaSDK(receiveId, "interactive", JSON.stringify(cardJson), receiveIdType);
      if (result.ok && result.messageId) {
        console.log(`[FeishuChannel:${this.id}] ✓ 进度卡片已发送 (${result.messageId})`);
        return result.messageId;
      }
      return null;
    } catch (error) {
      console.error(`[FeishuChannel:${this.id}] ✗ 进度卡片发送失败:`, error);
      return null;
    }
  }

  /**
   * 原地更新进度卡片
   */
  async updateProgressCard(messageId: string, card: ProgressCard): Promise<boolean> {
    try {
      const cardJson = this.buildProgressCardJson(card);
      const res = await this.client.im.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(cardJson) },
      });
      if (res.code === 0) {
        console.log(`[FeishuChannel:${this.id}] ✓ 进度卡片已更新 (${messageId})`);
        return true;
      }
      console.error(`[FeishuChannel:${this.id}] ✗ 卡片更新失败:`, res.code, res.msg);
      return false;
    } catch (error) {
      console.error(`[FeishuChannel:${this.id}] ✗ 卡片更新异常:`, error);
      return false;
    }
  }

  /**
   * 构建进度卡片 JSON
   */
  private buildProgressCardJson(card: ProgressCard): any {
    const elements: any[] = [];

    // 任务描述
    if (card.task) {
      elements.push({
        tag: "div",
        text: { tag: "lark_md", content: `**任务**: ${card.task}` }
      });
      elements.push({ tag: "hr" });
    }

    // 各引擎状态
    for (const engine of card.engines) {
      const icon = engine.status === "done" ? "✅"
        : engine.status === "running" ? "⏳"
        : engine.status === "error" ? "❌"
        : "⬜";
      const elapsed = engine.elapsed ? ` (${engine.elapsed})` : "";
      const detail = engine.detail ? `\n  ${engine.detail}` : "";
      elements.push({
        tag: "div",
        text: { tag: "lark_md", content: `${icon} **${engine.name}**${elapsed}${detail}` }
      });
    }

    // 进度条：优先用 card.progress（工具调用驱动），否则按引擎完成数算
    const doneCount = card.engines.filter(e => e.status === "done" || e.status === "error").length;
    const total = card.engines.length;
    const pct = card.progress != null ? card.progress : Math.round((doneCount / total) * 100);
    const filled = Math.round(pct / 10);
    const bar = "▰".repeat(filled) + "▱".repeat(10 - filled);
    elements.push({ tag: "hr" });
    elements.push({
      tag: "div",
      text: { tag: "lark_md", content: `${bar} **${pct}%** (${doneCount}/${total})` }
    });

    // 底部备注
    if (card.footer) {
      elements.push({
        tag: "note",
        elements: [{ tag: "plain_text", content: card.footer }]
      });
    }

    // 卡片颜色
    const headerColor = doneCount === total
      ? (card.engines.some(e => e.status === "error") ? "orange" : "green")
      : "blue";

    const headerTitle = doneCount === total ? "任务完成" : "任务处理中...";

    return {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: "plain_text", content: card.title || headerTitle },
        template: headerColor
      },
      elements
    };
  }

  /**
   * 获取飞书访问令牌
   */
  private async getAccessToken(): Promise<string | null> {
    try {
      const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          app_id: this.config.appId,
          app_secret: this.config.appSecret,
        }),
      });

      const data = await response.json();
      if (data.code === 0) {
        // 提前 5 分钟刷新令牌
        this.tokenExpireTime = Date.now() + (data.expire - 300) * 1000;
        return data.tenant_access_token;
      }

      console.error("[FeishuChannel] Get token failed:", data);
      return null;
    } catch (error) {
      console.error("[FeishuChannel] Get token error:", error);
      return null;
    }
  }

  /**
   * 添加"正在输入"表态（SDK 自动管理 token）
   */
  private async addTypingIndicator(messageId: string): Promise<string | null> {
    try {
      const res = await this.client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: "Typing" } },
      });

      if (res.code === 0 && res.data?.reaction_id) {
        this.currentMessageId = messageId;
        this.currentReactionId = res.data.reaction_id;
        console.log(`[FeishuChannel] ✓ 已添加正在输入表态 (${this.currentReactionId})`);
        return this.currentReactionId;
      }
      return null;
    } catch (error) {
      console.log(`[FeishuChannel] 添加表态失败（非关键）: ${error}`);
      return null;
    }
  }

  /**
   * 移除表态（SDK 自动管理 token）
   */
  private async removeTypingIndicator(messageId: string, reactionId: string): Promise<void> {
    try {
      await this.client.im.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      });
    } catch {
      // 静默失败 - 清理不是关键功能
    }
  }

  /**
   * 获取群聊最近消息历史（用于给机器人注入上下文）
   * @param chatId - 群聊 ID
   * @param count - 获取条数，默认 20
   * @returns 格式化的聊天历史文本
   */
  /**
   * 缓存群聊消息到内存 buffer（从 WebSocket 事件实时采集）
   */
  private bufferChatMessage(chatId: string, event: any): void {
    try {
      const message = event?.message;
      // 飞书 WebSocket 事件字段是 message_type，不是 msg_type
      const msgType = message?.message_type;
      const senderType = event?.sender?.sender_type;
      const sender = senderType === "app" ? "[机器人]" : "[用户]";
      let text = "";

      if (msgType === "text") {
        const content = typeof message?.content === "string"
          ? JSON.parse(message.content)
          : (message?.content || {});
        text = (content.text || "").replace(/@_user_\d+/g, "").trim();
      } else if (msgType === "post") {
        // 富文本消息（带 @mention 的消息会变成 post 类型）
        const content = typeof message?.content === "string"
          ? JSON.parse(message.content)
          : (message?.content || {});
        // post 结构: { title, content: [[{tag:"text",text:"..."},{tag:"at",...}]] }
        const paragraphs = content.content || content.zh_cn?.content || [];
        const parts: string[] = [];
        for (const para of paragraphs) {
          if (Array.isArray(para)) {
            for (const node of para) {
              if (node.tag === "text" && node.text) {
                parts.push(node.text);
              }
            }
          }
        }
        text = parts.join("").trim();
      } else if (msgType === "interactive") {
        const rawContent = typeof message?.content === "string" ? message.content : JSON.stringify(message?.content || "{}");
        const extracted = FeishuChannel.extractCardText(rawContent);
        text = extracted || "[卡片消息]";
      } else if (msgType === "image") {
        text = "[图片]";
      } else {
        text = `[${msgType || "unknown"}]`;
      }

      if (!text) return;

      const buffer = this.chatMessageBuffer.get(chatId) || [];
      buffer.push({ sender, text, timestamp: Date.now() });

      // 超过上限时移除最旧的
      while (buffer.length > this.CHAT_BUFFER_MAX) {
        buffer.shift();
      }

      this.chatMessageBuffer.set(chatId, buffer);
    } catch {
      // 缓存失败不影响主流程
    }
  }

  /**
   * 获取群聊历史：优先从内存 buffer 读取（可靠），API 作为补充
   */
  async fetchChatHistory(chatId: string, count: number = 20): Promise<string> {
    // 优先使用内存 buffer（不依赖 API 权限，实时性更好）
    const buffer = this.chatMessageBuffer.get(chatId);
    if (buffer && buffer.length > 0) {
      const recent = buffer.slice(-count);
      const lines = recent.map(m => `${m.sender}: ${m.text}`);
      console.log(`[FeishuChannel:${this.id}] 从内存 buffer 获取群聊上下文: ${lines.length} 条`);
      return lines.join("\n");
    }

    // buffer 为空时尝试 API（首次启动后、bot 刚加入群时可能需要）
    try {
      console.log(`[FeishuChannel:${this.id}] buffer 为空，尝试 API 获取群聊历史 (chatId: ${chatId})`);
      const res = await this.client.im.message.list({
        params: {
          container_id_type: "chat",
          container_id: chatId,
          page_size: count,
          sort_type: "ByCreateTimeDesc",
        },
      }) as any;

      console.log(`[FeishuChannel:${this.id}] API 返回: code=${res.code}, items=${res.data?.items?.length || 0}, msg=${res.msg || ''}`);

      if (res.code !== 0 || !res.data?.items?.length) {
        return "";
      }

      const messages = res.data.items.reverse();
      const lines: string[] = [];

      for (const msg of messages) {
        const sender = msg.sender?.sender_type === "app" ? `[机器人]` : `[用户]`;
        const msgType = msg.msg_type;

        if (msgType === "text") {
          try {
            const content = JSON.parse(msg.body?.content || "{}");
            const text = (content.text || "").replace(/@_user_\d+/g, "").trim();
            if (text) lines.push(`${sender}: ${text}`);
          } catch { }
        } else if (msgType === "post") {
          try {
            const content = JSON.parse(msg.body?.content || "{}");
            const paragraphs = content.content || content.zh_cn?.content || [];
            const parts: string[] = [];
            for (const para of paragraphs) {
              if (Array.isArray(para)) {
                for (const node of para) {
                  if (node.tag === "text" && node.text) parts.push(node.text);
                }
              }
            }
            const text = parts.join("").trim();
            if (text) lines.push(`${sender}: ${text}`);
          } catch { }
        } else if (msgType === "interactive") {
          const extracted = FeishuChannel.extractCardText(msg.body?.content || "{}");
          lines.push(`${sender}: ${extracted || "[卡片消息]"}`);
        } else if (msgType === "image") {
          lines.push(`${sender}: [图片]`);
        } else {
          lines.push(`${sender}: [${msgType}]`);
        }
      }

      return lines.join("\n");
    } catch (err) {
      console.warn(`[FeishuChannel:${this.id}] 获取群聊历史失败:`, err);
      return "";
    }
  }

  /**
   * 根据 message_id 获取单条消息内容（用于回复场景，获取被回复的消息）
   */
  async fetchMessageById(messageId: string): Promise<string> {
    try {
      console.log(`[FeishuChannel:${this.id}] [REPLY] 获取消息内容: ${messageId}`);
      const res = await this.client.im.message.get({
        path: { message_id: messageId },
      }) as any;

      console.log(`[FeishuChannel:${this.id}] [REPLY] API 响应: code=${res?.code}, hasData=${!!res?.data}, items=${res?.data?.items?.length || 0}`);

      if (res.code !== 0 || !res.data) {
        console.warn(`[FeishuChannel:${this.id}] [REPLY] 获取消息失败: code=${res.code}, msg=${res.msg}`);
        return "";
      }

      const msg = res.data.items?.[0] || res.data;
      const msgType = msg.msg_type || msg.message_type;
      const sender = msg.sender?.sender_type === "app" ? "[机器人]" : "[用户]";
      console.log(`[FeishuChannel:${this.id}] [REPLY] 消息类型: ${msgType}, sender: ${sender}`);

      if (msgType === "text") {
        const content = JSON.parse(msg.body?.content || "{}");
        return `${sender}: ${(content.text || "").replace(/@_user_\d+/g, "").trim()}`;
      } else if (msgType === "post") {
        const content = JSON.parse(msg.body?.content || "{}");
        const paragraphs = content.content || content.zh_cn?.content || [];
        const parts: string[] = [];
        for (const para of paragraphs) {
          if (Array.isArray(para)) {
            for (const node of para) {
              if (node.tag === "text" && node.text) parts.push(node.text);
            }
          }
        }
        return `${sender}: ${parts.join("").trim()}`;
      } else if (msgType === "interactive") {
        const extracted = FeishuChannel.extractCardText(msg.body?.content || "{}");
        return extracted ? `${sender}: ${extracted}` : `${sender}: [卡片消息]`;
      } else {
        return `${sender}: [${msgType}]`;
      }
    } catch (err) {
      console.warn(`[FeishuChannel:${this.id}] 获取消息 ${messageId} 失败:`, err);
      return "";
    }
  }

  /**
   * 移除当前的"正在输入"表态（公共方法）
   */
  async clearTypingIndicator(): Promise<void> {
    if (this.currentMessageId && this.currentReactionId) {
      await this.removeTypingIndicator(this.currentMessageId, this.currentReactionId);
      this.currentMessageId = null;
      this.currentReactionId = null;
      console.log("[FeishuChannel] ✓ 已移除正在输入表态");
    }
  }

  /**
   * 解析 Markdown 表格为飞书交互卡片表格格式
   * @returns 包含 beforeTable、afterTable 和表格数据的对象，如果没有表格则返回 null
   */
  private parseMarkdownTable(text: string): { beforeTable: string; afterTable: string; headers: string[]; rows: string[][] } | null {
    // 检测表格：查找包含 | 的连续行，至少 2 行（表头 + 分隔线）
    const lines = text.split("\n");
    let tableStart = -1;
    let tableEnd = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      // 表格行特征：以 | 开头或包含 |
      if (line.startsWith("|") || (line.includes("|") && line.includes("|"))) {
        if (tableStart === -1) {
          tableStart = i;
        }
        // 检查下一行是否是分隔线（包含 |---| 或类似的）
        if (i + 1 < lines.length && lines[i + 1].trim().match(/^\|?[\s\-:]+\|[\s\-:]+\|?/)) {
          tableEnd = i + 1;
          // 继续查找表格的后续行
          for (let j = i + 2; j < lines.length; j++) {
            const nextLine = lines[j].trim();
            if (nextLine.startsWith("|") || nextLine.includes("|")) {
              tableEnd = j;
            } else {
              break;
            }
          }
          break;
        }
      }
    }

    if (tableStart === -1 || tableEnd === -1) {
      return null;
    }

    // 提取表格前的内容
    const beforeTable = lines.slice(0, tableStart).join("\n").trim();

    // 提取表格后的内容
    const afterTable = lines.slice(tableEnd + 1).join("\n").trim();

    // 解析表格数据
    const tableLines = lines.slice(tableStart, tableEnd + 1);
    const headers = this.parseTableRow(tableLines[0]);
    const rows = tableLines.slice(2).map(line => this.parseTableRow(line));

    return { beforeTable, afterTable, headers, rows };
  }

  /**
   * 构建飞书交互卡片（带表格）
   */
  private buildTableCard(beforeTable: string, headers: string[], rows: string[][], afterTable: string): any {
    const elements: any[] = [];

    // 表格前的内容（如果有）
    if (beforeTable) {
      elements.push({
        tag: "div",
        text: {
          tag: "lark_md",
          content: beforeTable
        }
      });
    }

    // 飞书表格列定义（使用官方格式）
    // 为每列生成唯一的 name（英文字母键名）
    const columnKeys = headers.map((_, i) => `col_${i}`);
    const tableColumns = headers.map((h, i) => ({
      name: columnKeys[i],
      display_name: h,
      data_type: "text",
      width: "120px"
    }));

    // 构建行数据（每行是一个对象，键名必须匹配列的 name）
    const tableRows = rows.map(row => {
      const rowObj: any = {};
      row.forEach((cell, i) => {
        rowObj[columnKeys[i]] = cell;
      });
      return rowObj;
    });

    // 添加表格元素（使用飞书官方格式）
    elements.push({
      tag: "table",
      columns: tableColumns,
      rows: tableRows,
      page_size: 10,
      row_height: "low"
    });

    // 表格后的内容（如果有）
    if (afterTable) {
      elements.push({
        tag: "div",
        text: {
          tag: "lark_md",
          content: afterTable
        }
      });
    }

    // 返回完整的交互卡片（添加 header）
    return {
      config: {
        wide_screen_mode: true
      },
      header: {
        title: {
          tag: "plain_text",
          content: beforeTable.trim().split("\n").pop() || "数据表格"
        }
      },
      elements
    };
  }

  /**
   * 解析表格行
   */
  private parseTableRow(line: string): string[] {
    // 移除首尾的 |
    let trimmed = line.trim();
    if (trimmed.startsWith("|")) {
      trimmed = trimmed.slice(1);
    }
    if (trimmed.endsWith("|")) {
      trimmed = trimmed.slice(0, -1);
    }

    // 按 | 分割并清理空白
    return trimmed.split("|").map(cell => cell.trim());
  }

}
