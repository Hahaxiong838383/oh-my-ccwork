/**
 * 通道管理器
 *
 * 管理多个消息通道，支持广播消息到所有通道
 */
import type { MessageChannel } from "./interface.js";
import type { SSEEvent } from "../adapters/interface.js";
/**
 * 可启动的通道接口
 */
export interface StartableChannel {
    start?(): Promise<void> | void;
    stop?(): void;
}
/**
 * 通道管理器
 *
 * 负责注册通道和广播消息
 */
export declare class ChannelManager {
    /** 已注册的通道 */
    private channels;
    /**
     * 注册通道
     * @param channel - 要注册的通道
     */
    register(channel: MessageChannel): void;
    /**
     * 注销通道
     * @param channelId - 通道 ID
     */
    unregister(channelId: string): void;
    /**
     * 启动所有已注册的通道
     * 任意通道启动失败不影响其他通道
     */
    startAll(): Promise<void>;
    /**
     * 停止所有已注册的通道
     */
    stopAll(): void;
    /**
     * 广播消息到所有通道
     * 每个通道的 filter 方法会被调用，只有返回 true 的通道才会收到消息
     * @param event - 要广播的 SSE 事件
     */
    broadcast(event: SSEEvent): Promise<void>;
    /**
     * 获取已注册的通道数量
     */
    get size(): number;
    /**
     * 检查通道是否已注册
     * @param channelId - 通道 ID
     */
    has(channelId: string): boolean;
    /**
     * 获取所有已注册的通道 ID
     */
    getChannelIds(): string[];
}
//# sourceMappingURL=manager.d.ts.map