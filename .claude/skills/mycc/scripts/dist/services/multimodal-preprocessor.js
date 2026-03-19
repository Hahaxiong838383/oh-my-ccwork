/**
 * 多模态预处理器
 *
 * 在消息发送给 Gemini API 之前，自动检测飞书文档引用，
 * 提取其中的媒体文件（视频/图片），转为 Gemini 可用的 inline data。
 *
 * 2026-03-12: 初始实现
 */
import { extractDocMedia } from "./feishu-file-downloader.js";
/**
 * 从消息中检测飞书文档 ID
 *
 * 支持格式：
 * - 纯 doc_id：`XGTadQS1HoeUfLx7OUEcxopDnVg`（27位字母数字）
 * - 显式标记：`doc:XGTadQS1HoeUfLx7OUEcxopDnVg`
 * - 飞书文档 URL：`feishu.cn/docx/XGTadQS1HoeUfLx7OUEcxopDnVg`
 * - Wiki URL: `feishu.cn/wiki/XGTadQS1HoeUfLx7OUEcxopDnVg`
 */
function extractDocIds(message) {
    const docIds = [];
    // 显式标记: doc:xxx
    const explicitMatch = message.match(/doc[：:]\s*([A-Za-z0-9]{27})/g);
    if (explicitMatch) {
        for (const m of explicitMatch) {
            const id = m.replace(/doc[：:]\s*/, "");
            if (!docIds.includes(id))
                docIds.push(id);
        }
    }
    // 飞书 URL: *.feishu.cn/docx/xxx 或 *.feishu.cn/wiki/xxx（含子域名如 futurus.feishu.cn）
    const urlMatch = message.match(/feishu\.cn\/(?:docx|wiki)\/([A-Za-z0-9]{27})/g);
    if (urlMatch) {
        for (const m of urlMatch) {
            const id = m.match(/([A-Za-z0-9]{27})/)?.[1];
            if (id && !docIds.includes(id))
                docIds.push(id);
        }
    }
    // 如果消息包含"文档"相关关键词 + 27位 ID 模式
    if (/文档|视频|图片|分析|识别/.test(message)) {
        const idMatch = message.match(/\b([A-Za-z0-9]{27})\b/g);
        if (idMatch) {
            for (const id of idMatch) {
                // 排除明显非 doc_id 的（如纯数字、纯字母等常见词）
                if (/[A-Z]/.test(id) && /[a-z]/.test(id) && !docIds.includes(id)) {
                    docIds.push(id);
                }
            }
        }
    }
    return docIds;
}
/**
 * 预处理消息：提取飞书文档中的媒体文件
 *
 * 仅当 engine === "gemini" 且消息包含文档引用时触发
 */
export async function preprocessMultimodal(message) {
    const docIds = extractDocIds(message);
    if (docIds.length === 0) {
        return { cleanedPrompt: message, mediaBuffers: [], hasDocRef: false };
    }
    console.log(`[MultimodalPreprocessor] 检测到文档引用: ${docIds.join(", ")}`);
    const allMedia = [];
    for (const docId of docIds) {
        try {
            const media = await extractDocMedia(docId);
            allMedia.push(...media);
        }
        catch (err) {
            console.error(`[MultimodalPreprocessor] 提取文档 ${docId} 媒体失败:`, err.message);
        }
    }
    // 清理 prompt 中的 doc: 标记（保留其他内容）
    let cleaned = message.replace(/doc[：:]\s*[A-Za-z0-9]{27}/g, "").trim();
    if (!cleaned)
        cleaned = message; // 防止清理过度
    if (allMedia.length > 0) {
        console.log(`[MultimodalPreprocessor] 提取到 ${allMedia.length} 个媒体文件，总大小: ${(allMedia.reduce((s, m) => s + m.data.length, 0) / 1024 / 1024).toFixed(1)}MB`);
    }
    else {
        console.log(`[MultimodalPreprocessor] 文档中未找到媒体文件`);
    }
    return { cleanedPrompt: cleaned, mediaBuffers: allMedia, hasDocRef: true };
}
//# sourceMappingURL=multimodal-preprocessor.js.map