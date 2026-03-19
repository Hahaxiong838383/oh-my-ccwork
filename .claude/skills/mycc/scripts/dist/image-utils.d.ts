/**
 * 图片处理工具函数
 *
 * 提供图片校验和消息构造功能
 */
/** 图片数据 */
export interface ImageData {
    data: string;
    mediaType: string;
}
/** 校验结果 */
export interface ValidationResult {
    valid: boolean;
    error?: string;
    code?: number;
}
/** Anthropic API 图片块 */
interface ImageBlock {
    type: "image";
    source: {
        type: "base64";
        media_type: string;
        data: string;
    };
}
/** Anthropic API 文本块 */
interface TextBlock {
    type: "text";
    text: string;
}
/** 消息内容类型 */
export type MessageContent = string | (ImageBlock | TextBlock)[];
/**
 * 校验单张图片
 */
export declare function validateImage(image: ImageData): ValidationResult;
/**
 * 校验图片数组
 */
export declare function validateImages(images: ImageData[] | undefined | null): ValidationResult;
/**
 * 构造消息内容
 *
 * - 纯文本：返回 string
 * - 图文混合：返回 [ImageBlock, TextBlock]
 * - 仅图片：返回 [ImageBlock, TextBlock]（使用默认提示语）
 */
export declare function buildMessageContent(message: string, images: ImageData[] | undefined | null): MessageContent;
export {};
//# sourceMappingURL=image-utils.d.ts.map