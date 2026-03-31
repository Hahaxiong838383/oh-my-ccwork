/**
 * URL 内容预取器
 *
 * CLI 引擎（codex/gemini）无法直接访问外部 URL，
 * 本模块在发送 prompt 前预取内容，注入到 prompt 中。
 *
 * 支持：
 * - GitHub 仓库：shallow clone → 提取 README + 目录树 + 关键源码
 * - GitHub 文件/PR/Issue：通过 GitHub API 获取内容
 * - 通用网页：fetch HTML → 提取正文
 *
 * 2026-03-15: 初始实现
 */
export interface UrlContent {
    url: string;
    type: "github-repo" | "webpage" | "pdf";
    content: string;
}
/** 预取到的 PDF 二进制（供 Gemini 原生处理） */
export interface FetchedMedia {
    data: Buffer;
    mimeType: string;
    url: string;
}
export interface FetchResult {
    /** 原始消息中 URL 替换为内容后的 prompt */
    enrichedPrompt: string;
    /** 是否有内容被注入 */
    hasContent: boolean;
    /** 预取到的内容条目 */
    items: UrlContent[];
    /** 预取到的二进制文件（PDF 等，供 Gemini 多模态处理） */
    mediaBuffers?: FetchedMedia[];
}
/**
 * 检测消息中的 URL 并预取内容，注入到 prompt 中。
 *
 * @param message 用户原始消息
 * @returns 增强后的 prompt
 */
export declare function fetchUrlContent(message: string): Promise<FetchResult>;
//# sourceMappingURL=url-content-fetcher.d.ts.map