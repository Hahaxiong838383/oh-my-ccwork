/**
 * 飞书命令处理模块
 *
 * 从 HttpServer 提取的飞书消息处理和命令系统
 */
import type { CCAdapter } from "../adapters/interface.js";
import type { ChannelManager } from "./manager.js";
import type { DeviceConfig } from "../types.js";
export interface FeishuCommandsDeps {
    adapter: CCAdapter;
    channelManager: ChannelManager;
    cwd: string;
    feishuChannel: any;
    loadConfig: (cwd: string) => DeviceConfig | null;
}
export declare class FeishuCommands {
    private deps;
    private _currentSessionId;
    constructor(deps: FeishuCommandsDeps);
    get currentSessionId(): string | null;
    set currentSessionId(id: string | null);
    /**
     * 处理飞书收到的消息
     */
    processMessage(message: string, images?: Array<{
        data: string;
        mediaType: string;
    }>): Promise<void>;
    /**
     * 处理飞书命令
     */
    private handleFeishuCommand;
    private handleNewSession;
    private handleListSessions;
    private handleSwitchSession;
    private handleCurrentSession;
    private handleDevice;
    private handleHelp;
    private sendToFeishu;
    /**
     * 格式化时间显示
     */
    formatTimeAgo(timestamp: string | number): string;
}
//# sourceMappingURL=feishu-commands.d.ts.map