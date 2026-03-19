/**
 * Web 通道
 *
 * 包装现有的 SSE 逻辑，将消息发送到 Web 客户端
 */
import type { MessageChannel } from "./interface.js";
import type { SSEEvent } from "../adapters/interface.js";
import type { ServerResponse } from "http";
/**
 * Web 通道配置
 */
export interface WebChannelConfig {
    /** HTTP 响应对象 */
    res: ServerResponse;
}
/**
 * Web 消息通道
 *
 * 包装 SSE 响应，将消息发送到 Web 客户端
 */
export declare class WebChannel implements MessageChannel {
    readonly id = "web";
    private res;
    private sessionId?;
    constructor(config: WebChannelConfig);
    /**
     * 设置当前会话 ID
     * @param sessionId - 会话 ID
     */
    setSessionId(sessionId: string): void;
    /**
     * 获取当前会话 ID
     */
    getSessionId(): string | undefined;
    /**
     * 不需要过滤器 - Web 通道接收所有消息
     */
    /**
     * 发送消息到 Web 客户端（SSE）
     * @param event - SSE 事件
     */
    send(event: SSEEvent): Promise<void>;
    /**
     * 发送完成信号
     */
    sendDone(): Promise<void>;
    /**
     * 发送错误信号
     * @param error - 错误信息
     */
    sendError(error: string): Promise<void>;
}
//# sourceMappingURL=web.d.ts.map