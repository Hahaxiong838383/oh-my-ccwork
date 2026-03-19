/**
 * 飞书文件下载服务
 *
 * 从飞书文档中下载媒体文件（视频/图片/音频），用于多模态分析。
 * 使用飞书 MCP 的 OAuth token（用户级权限，可访问文档内容）。
 *
 * 2026-03-12: 初始实现，支持文档块解析 + 媒体下载
 */
/**
 * 获取飞书文档的所有块，提取媒体文件 token
 */
export declare function listDocMediaTokens(docId: string): Promise<Array<{
    fileToken: string;
    name: string;
    blockType: number;
}>>;
/**
 * 下载飞书文件到内存（返回 Buffer + mimeType）
 *
 * 使用 drive/v1/medias/{file_token}/download API
 */
export declare function downloadFeishuMedia(fileToken: string): Promise<{
    data: Buffer;
    mimeType: string;
}>;
/**
 * 从飞书文档中提取并下载所有媒体文件
 * 返回 Gemini API 可直接使用的 inline data 格式
 */
export declare function extractDocMedia(docId: string): Promise<Array<{
    data: Buffer;
    mimeType: string;
    name: string;
}>>;
//# sourceMappingURL=feishu-file-downloader.d.ts.map