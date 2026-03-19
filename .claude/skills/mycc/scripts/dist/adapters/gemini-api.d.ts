/**
 * Gemini API Adapter — 直接调 Google Gemini API（替代 Gemini CLI）
 *
 * 优势：
 * - 支持多模态（视频/图片/音频 + 文本）
 * - 不依赖 Gemini CLI 安装
 * - 支持长 prompt（无命令行参数长度限制）
 *
 * 决策记录：2026-03-12，从 CLI 切换到 API
 * 原因：1. Gemini 多模态能力强 2. 分散 cc 负载
 * 更新：大文件（>20MB）自动走 File API 上传
 */
interface GeminiApiResult {
    output: string;
    error?: string;
    timedOut?: boolean;
}
/** 内存中的媒体数据（不落盘） */
export interface MediaBuffer {
    data: Buffer;
    mimeType: string;
}
interface GeminiApiOptions {
    timeout?: number;
    signal?: AbortSignal;
    filePaths?: string[];
    mediaBuffers?: MediaBuffer[];
}
/**
 * 调用 Gemini API（支持纯文本 + 多模态）
 */
export declare function runGeminiApi(prompt: string, opts?: GeminiApiOptions): Promise<GeminiApiResult>;
export {};
//# sourceMappingURL=gemini-api.d.ts.map