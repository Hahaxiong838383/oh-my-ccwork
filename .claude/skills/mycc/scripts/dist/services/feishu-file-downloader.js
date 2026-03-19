/**
 * 飞书文件下载服务
 *
 * 从飞书文档中下载媒体文件（视频/图片/音频），用于多模态分析。
 * 使用飞书 MCP 的 OAuth token（用户级权限，可访问文档内容）。
 *
 * 2026-03-12: 初始实现，支持文档块解析 + 媒体下载
 */
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
const FEISHU_BASE = "https://open.feishu.cn/open-apis";
/** 从 ~/.feishu-mcp/tokens.json 读取 MCP OAuth access token */
function getMcpAccessToken() {
    const tokenPath = join(homedir(), ".feishu-mcp", "tokens.json");
    try {
        const data = JSON.parse(readFileSync(tokenPath, "utf-8"));
        // tokens.json 格式: { "cli_xxx": { accessToken, refreshToken, expiresAt } }
        const appId = Object.keys(data)[0];
        if (!appId)
            throw new Error("tokens.json 为空");
        const token = data[appId].accessToken;
        if (!token)
            throw new Error("accessToken 缺失");
        return token;
    }
    catch (err) {
        throw new Error(`读取飞书 MCP token 失败: ${err.message}`);
    }
}
/**
 * 获取飞书文档的所有块，提取媒体文件 token
 */
export async function listDocMediaTokens(docId) {
    const token = getMcpAccessToken();
    const url = `${FEISHU_BASE}/docx/v1/documents/${docId}/blocks?document_revision_id=-1&page_size=500`;
    console.log(`[FeishuFileDownloader] 读取文档块: ${docId}`);
    const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`列取文档块失败 (${resp.status}): ${text.substring(0, 200)}`);
    }
    const json = await resp.json();
    if (json.code !== 0) {
        throw new Error(`飞书 API 错误: ${json.msg}`);
    }
    const blocks = json.data?.items || [];
    const mediaTokens = [];
    for (const block of blocks) {
        // 通用提取：任何块类型只要包含 file/image/video 字段都提取
        // block_type 23=媒体, 27=文件, 18=图片, 30=视频 等
        const bType = block.block_type;
        const blockData = block;
        const seen = new Set();
        if (blockData.file?.token && !seen.has(blockData.file.token)) {
            seen.add(blockData.file.token);
            mediaTokens.push({
                fileToken: blockData.file.token,
                name: blockData.file.name || "file",
                blockType: bType,
            });
        }
        if (blockData.image?.token && !seen.has(blockData.image.token)) {
            seen.add(blockData.image.token);
            mediaTokens.push({
                fileToken: blockData.image.token,
                name: "image",
                blockType: bType,
            });
        }
        if (blockData.video?.token && !seen.has(blockData.video.token)) {
            seen.add(blockData.video.token);
            mediaTokens.push({
                fileToken: blockData.video.token,
                name: blockData.video.name || "video",
                blockType: bType,
            });
        }
    }
    console.log(`[FeishuFileDownloader] 文档 ${docId} 找到 ${mediaTokens.length} 个媒体文件`);
    return mediaTokens;
}
/**
 * 下载飞书文件到内存（返回 Buffer + mimeType）
 *
 * 使用 drive/v1/medias/{file_token}/download API
 */
export async function downloadFeishuMedia(fileToken) {
    const token = getMcpAccessToken();
    const url = `${FEISHU_BASE}/drive/v1/medias/${fileToken}/download`;
    console.log(`[FeishuFileDownloader] 下载文件: ${fileToken}`);
    const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`下载文件失败 (${resp.status}): ${text.substring(0, 200)}`);
    }
    const contentType = resp.headers.get("content-type") || "application/octet-stream";
    const buffer = Buffer.from(await resp.arrayBuffer());
    console.log(`[FeishuFileDownloader] 下载完成: ${fileToken}, ${(buffer.length / 1024 / 1024).toFixed(1)}MB, type=${contentType}`);
    return { data: buffer, mimeType: contentType };
}
/**
 * 从飞书文档中提取并下载所有媒体文件
 * 返回 Gemini API 可直接使用的 inline data 格式
 */
export async function extractDocMedia(docId) {
    const mediaTokens = await listDocMediaTokens(docId);
    if (mediaTokens.length === 0)
        return [];
    const results = [];
    for (const media of mediaTokens) {
        try {
            const downloaded = await downloadFeishuMedia(media.fileToken);
            results.push({ ...downloaded, name: media.name });
        }
        catch (err) {
            console.error(`[FeishuFileDownloader] 下载 ${media.fileToken} 失败:`, err.message);
            // 继续下载其他文件
        }
    }
    return results;
}
//# sourceMappingURL=feishu-file-downloader.js.map