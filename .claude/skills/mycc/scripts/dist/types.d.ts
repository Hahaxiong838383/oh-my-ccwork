/**
 * 公共类型定义
 */
/** 设备配置（持久化到 current.json） */
export interface DeviceConfig {
    deviceId: string;
    pairCode: string;
    routeToken?: string;
    authToken?: string;
    createdAt: string;
}
/** Worker 注册结果 */
export interface RegisterResult {
    token: string;
    isNewDevice: boolean;
}
/** 配对状态（运行时） */
export interface PairState {
    pairCode: string;
    paired: boolean;
    token: string | null;
}
/** 图片数据（简化版，完整定义在 image-utils.ts） */
export interface ImageData {
    data: string;
    mediaType: string;
}
/** Chat 请求参数 */
export interface ChatParams {
    message: string;
    sessionId?: string;
    cwd: string;
    images?: ImageData[];
    model?: string;
}
/** JSONL 行结构 */
export interface RawHistoryLine {
    type: "user" | "assistant" | "system" | "result" | "summary" | "custom-title";
    message?: {
        role?: string;
        content?: unknown;
        id?: string;
    };
    summary?: string;
    leafUuid?: string;
    customTitle?: string;
    sessionId?: string;
    timestamp?: string;
    uuid?: string;
    parentUuid?: string | null;
    isSidechain?: boolean;
    cwd?: string;
}
/** 对话摘要 */
export interface ConversationSummary {
    sessionId: string;
    startTime: string;
    lastTime: string;
    messageCount: number;
    lastMessagePreview: string;
    customTitle?: string | null;
    firstPrompt?: string;
    modified?: string;
}
/** 对话详情 */
export interface ConversationHistory {
    sessionId: string;
    messages: RawHistoryLine[];
}
//# sourceMappingURL=types.d.ts.map