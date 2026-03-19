/**
 * 多模态预处理器
 *
 * 在消息发送给 Gemini API 之前，自动检测飞书文档引用，
 * 提取其中的媒体文件（视频/图片），转为 Gemini 可用的 inline data。
 *
 * 2026-03-12: 初始实现
 */
export interface MediaBuffer {
    data: Buffer;
    mimeType: string;
    name: string;
}
export interface PreprocessResult {
    /** 清理后的 prompt（移除 doc_id 标记） */
    cleanedPrompt: string;
    /** 提取到的媒体文件 */
    mediaBuffers: MediaBuffer[];
    /** 是否找到了文档引用 */
    hasDocRef: boolean;
}
/**
 * 预处理消息：提取飞书文档中的媒体文件
 *
 * 仅当 engine === "gemini" 且消息包含文档引用时触发
 */
export declare function preprocessMultimodal(message: string): Promise<PreprocessResult>;
//# sourceMappingURL=multimodal-preprocessor.d.ts.map