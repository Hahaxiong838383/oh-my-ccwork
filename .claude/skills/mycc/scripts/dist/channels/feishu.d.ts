/**
 * 飞书通道
 *
 * 支持双向通信：
 * - 发送：将 Claude Code 回复发送到飞书
 * - 接收：通过 WebSocket 接收飞书消息并转发给 Claude Code
 */
import type { MessageChannel } from "./interface.js";
import type { SSEEvent } from "../adapters/interface.js";
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
export declare class FeishuChannel implements MessageChannel {
    readonly id: string;
    private config;
    private client;
    private accessToken;
    private tokenExpireTime;
    private pendingImages;
    private wsClient;
    private eventDispatcher;
    private messageCallback;
    private currentMessageId;
    private currentReactionId;
    private lastIncomingChatId;
    private botOpenId;
    private botName;
    private chatMessageBuffer;
    private readonly CHAT_BUFFER_MAX;
    private senderNameCache;
    private processedMessageIds;
    private readonly DEDUP_MAX;
    /**
     * 从飞书 interactive 卡片 JSON 中递归提取文本内容
     */
    private static extractCardText;
    constructor(config?: FeishuChannelConfig);
    /**
     * 消息过滤器 - 支持 v1 和 v2 SDK 的事件类型
     * v1: text, content_block_delta, system, tool_use
     * v2: assistant (包含消息内容), system
     */
    filter(event: SSEEvent): boolean;
    /**
     * 发送消息到飞书
     * @param event - SSE 事件
     */
    send(event: SSEEvent, targetChatId?: string): Promise<void>;
    isConfiguredP2PReceiver(): boolean;
    isConfiguredSender(): boolean;
    sendConfiguredP2PText(text: string): Promise<boolean>;
    sendToChatId(text: string, chatId: string): Promise<boolean>;
    /**
     * 设置消息接收回调
     * @param callback - 收到飞书消息时的回调函数
     */
    onMessage(callback: (message: string, images?: Array<{
        data: string;
        mediaType: string;
    }>, messageId?: string, chatId?: string, chatType?: string, parentId?: string) => void): void;
    /**
     * 启动飞书通道（验证凭证 + 启动 WebSocket）
     */
    start(): Promise<void>;
    /**
     * 启动 WebSocket 连接
     */
    private startWebSocket;
    /**
     * 解析飞书消息（异步，支持图片下载）
     */
    private parseFeishuMessage;
    /**
     * 停止飞书通道
     */
    stop(): void;
    /**
     * 从 SSE 事件中提取文本内容
     */
    private extractText;
    /**
     * 从 SSE 事件中提取 session_id
     */
    private extractSessionId;
    /**
     * 格式化 tool_use 事件为可读文本
     */
    private formatToolUse;
    /**
     * 格式化 assistant 事件中的 tool_use block
     */
    private formatToolUseBlock;
    /**
     * 处理图片（上传到飞书并保存 image_key）
     */
    private handleImages;
    /**
     * 上传图片到飞书
     */
    private uploadImageToFeishu;
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
    private downloadImageFromFeishu;
    /**
     * 发送消息到飞书
     */
    private sendMessageToFeishu;
    private sendTextToFeishuTarget;
    /**
     * 通过 SDK 发送消息（统一入口，SDK 自动管理 token）
     */
    private sendViaSDK;
    /**
     * 发送进度卡片（可更新）
     * 返回 messageId，后续用 updateProgressCard 原地更新
     */
    sendProgressCard(card: ProgressCard, overrideChatId?: string): Promise<string | null>;
    /**
     * 原地更新进度卡片
     */
    updateProgressCard(messageId: string, card: ProgressCard): Promise<boolean>;
    /**
     * 创建 CardKit 流式卡片实体并发送到飞书
     * 返回 cardId（用于后续流式更新）和 messageId
     */
    createStreamingCard(overrideChatId?: string): Promise<{
        cardId: string;
        messageId: string;
    } | null>;
    /**
     * 流式更新卡片内容（打字机效果）
     * 通过 CardKit cardElement.content API 只更新指定元素
     */
    streamCardContent(cardId: string, content: string, sequence: number): Promise<boolean>;
    /**
     * 完成流式卡片（更新整张卡片为绿色完成状态）
     */
    completeStreamingCard(cardId: string, content: string, metadata: {
        elapsed: string;
        toolCount?: number;
    }, sequence: number): Promise<boolean>;
    /**
     * 构建进度卡片 JSON
     */
    private buildProgressCardJson;
    /**
     * 获取飞书访问令牌
     */
    private getAccessToken;
    /**
     * 添加"正在输入"表态（SDK 自动管理 token）
     */
    private addTypingIndicator;
    /**
     * 移除表态（SDK 自动管理 token）
     */
    private removeTypingIndicator;
    /**
     * 获取群聊最近消息历史（用于给机器人注入上下文）
     * @param chatId - 群聊 ID
     * @param count - 获取条数，默认 20
     * @returns 格式化的聊天历史文本
     */
    /**
     * 缓存群聊消息到内存 buffer（从 WebSocket 事件实时采集）
     */
    private bufferChatMessage;
    /**
     * 获取群聊历史：优先从内存 buffer 读取（可靠），API 作为补充
     */
    fetchChatHistory(chatId: string, count?: number, threadId?: string): Promise<string>;
    /**
     * 根据 message_id 获取单条消息内容（用于回复场景，获取被回复的消息）
     */
    fetchMessageById(messageId: string): Promise<string>;
    /**
     * 移除当前的"正在输入"表态（公共方法）
     */
    clearTypingIndicator(): Promise<void>;
    /**
     * 解析 Markdown 表格为飞书交互卡片表格格式
     * @returns 包含 beforeTable、afterTable 和表格数据的对象，如果没有表格则返回 null
     */
    private parseMarkdownTable;
    /**
     * 构建飞书交互卡片（带表格）
     */
    private buildTableCard;
    /**
     * 解析表格行
     */
    private parseTableRow;
}
//# sourceMappingURL=feishu.d.ts.map