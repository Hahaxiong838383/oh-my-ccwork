/**
 * BM25 关键词索引模块
 *
 * 实现经典的 BM25 检索算法，用于历史对话的关键词搜索
 * 参考 SimpleMem 的词法层索引设计
 *
 * BM25 公式:
 * Score(Q, D) = Σ IDF(qi) * (f(qi, D) * (k1 + 1)) / (f(qi, D) + k1 * (1 - b + b * |D| / avgdl))
 */
import { readdirSync, existsSync, statSync, openSync, readSync, closeSync } from "fs";
import { homedir, EOL } from "os";
import { join } from "path";
// ============ BM25 参数 ============
const K1 = 1.5; // 词频饱和参数
const B = 0.75; // 文档长度归一化参数
// ============ 工具函数 ============
/**
 * 简单中文分词（按字符 + 空格分词）
 * 实际生产中可替换为更专业的分词库
 */
function tokenize(text) {
    if (!text)
        return [];
    // 转为小写
    let processed = text.toLowerCase();
    // 移除特殊字符，保留字母数字和中文
    processed = processed.replace(/[^\w\u4e00-\u9fa5\s]/g, ' ');
    // 按空格分割，去除空字符串
    const tokens = processed.split(/\s+/).filter(t => t.length > 1);
    // 去重但保留顺序（用于 IDF 计算）
    return [...new Set(tokens)];
}
/**
 * 计算 IDF（逆文档频率）
 * IDF(qi) = log((N - n(qi) + 0.5) / (n(qi) + 0.5))
 */
function calculateIDF(term, index) {
    // 缓存命中
    if (index.idfCache.has(term)) {
        return index.idfCache.get(term);
    }
    const n = index.invertedIndex.get(term)?.size || 0;
    // 防止除零
    if (n === 0) {
        return 0;
    }
    const idf = Math.log((index.N - n + 0.5) / (n + 0.5));
    index.idfCache.set(term, idf);
    return idf;
}
/**
 * 计算单个文档的 BM25 分数
 */
function scoreDocument(query, docId, index) {
    const docContent = index.documents.get(docId);
    if (!docContent)
        return 0;
    const queryTerms = tokenize(query);
    const docTerms = tokenize(docContent);
    const docLength = index.docLengths.get(docId) || 0;
    let score = 0;
    for (const term of queryTerms) {
        const idf = calculateIDF(term, index);
        if (idf <= 0)
            continue;
        // 计算词频
        const tf = docTerms.filter(t => t === term).length;
        // BM25 公式
        const numerator = tf * (K1 + 1);
        const denominator = tf + K1 * (1 - B + B * docLength / index.avgdl);
        score += idf * numerator / denominator;
    }
    return score;
}
// ============ 核心 API ============
/**
 * 构建 BM25 索引
 * 扫描指定目录下的所有 .jsonl 文件建立索引
 */
export function buildBM25Index(projectDir) {
    const index = {
        documents: new Map(),
        invertedIndex: new Map(),
        docLengths: new Map(),
        avgdl: 0,
        N: 0,
        idfCache: new Map(),
    };
    const historyDir = getHistoryDir(projectDir);
    if (!existsSync(historyDir)) {
        console.log(`[BM25] 历史目录不存在: ${historyDir}`);
        return index;
    }
    const files = readdirSync(historyDir).filter(f => f.endsWith('.jsonl'));
    console.log(`[BM25] 扫描 ${files.length} 个会话文件...`);
    for (const file of files) {
        const sessionId = file.replace('.jsonl', '');
        const filePath = join(historyDir, file);
        try {
            // 读取文件摘要（前16KB）
            const stats = statSync(filePath);
            if (stats.size === 0)
                continue;
            const content = readFileSummary(filePath, stats.size);
            const text = content.firstPrompt || content.customTitle || '';
            if (!text.trim())
                continue;
            // 存储文档
            index.documents.set(sessionId, text);
            index.docLengths.set(sessionId, text.length);
            // 建立倒排索引
            const terms = tokenize(text);
            const termCount = new Map();
            for (const term of terms) {
                termCount.set(term, (termCount.get(term) || 0) + 1);
            }
            for (const [term, tf] of termCount) {
                if (!index.invertedIndex.has(term)) {
                    index.invertedIndex.set(term, new Map());
                }
                index.invertedIndex.get(term).set(sessionId, tf);
            }
        }
        catch (err) {
            // 跳过无法读取的文件
            console.log(`[BM25] 跳过文件: ${file}`, err);
        }
    }
    index.N = index.documents.size;
    // 计算平均文档长度
    if (index.N > 0) {
        let totalLength = 0;
        for (const len of index.docLengths.values()) {
            totalLength += len;
        }
        index.avgdl = totalLength / index.N;
    }
    console.log(`[BM25] 索引构建完成: ${index.N} 文档, ${index.invertedIndex.size} 词项`);
    return index;
}
/**
 * 搜索历史对话
 * @param query 查询关键词
 * @param index BM25 索引
 * @param limit 返回结果数量
 */
export function searchBM25(query, index, limit = 10) {
    if (!query.trim() || index.N === 0) {
        return [];
    }
    const scores = [];
    // 对每个文档计算 BM25 分数
    for (const [sessionId] of index.documents) {
        const score = scoreDocument(query, sessionId, index);
        if (score > 0) {
            scores.push({ sessionId, score });
        }
    }
    // 按分数降序排序
    scores.sort((a, b) => b.score - a.score);
    // 返回 top N
    return scores.slice(0, limit).map(({ sessionId, score }) => ({
        sessionId,
        score,
        preview: index.documents.get(sessionId)?.substring(0, 100) || '',
    }));
}
// ============ 辅助函数 ============
/**
 * 获取历史记录目录
 */
function getHistoryDir(cwd) {
    const encodedName = encodeProjectPath(cwd);
    return join(homedir(), '.claude', 'projects', encodedName);
}
/**
 * 编码项目路径
 */
function encodeProjectPath(projectPath) {
    return projectPath.replace(/\/$/, '').replace(/[^a-zA-Z0-9]/g, '-');
}
const BUFFER_SIZE = 16384;
/**
 * 读取文件摘要（head + tail）
 */
function readFileSummary(filePath, fileSize) {
    if (fileSize === 0) {
        return { firstPrompt: '', customTitle: '' };
    }
    const fd = openSync(filePath, 'r');
    try {
        const buffer = Buffer.alloc(BUFFER_SIZE);
        // 读 head
        const headBytes = readSync(fd, buffer, 0, Math.min(BUFFER_SIZE, fileSize), 0);
        const headContent = buffer.toString('utf-8', 0, headBytes);
        const firstPrompt = extractFirstPrompt(headContent);
        // 读 tail
        let tailContent = '';
        const tailOffset = Math.max(0, fileSize - BUFFER_SIZE);
        if (tailOffset > 0) {
            const tailBytes = readSync(fd, buffer, 0, BUFFER_SIZE, tailOffset);
            tailContent = buffer.toString('utf-8', 0, tailBytes);
        }
        else {
            tailContent = headContent;
        }
        const customTitle = extractLastField(tailContent, 'customTitle') || '';
        return { firstPrompt, customTitle };
    }
    finally {
        closeSync(fd);
    }
}
/**
 * 提取第一条 user 消息
 */
function extractFirstPrompt(headContent) {
    if (!headContent)
        return '';
    const lines = headContent.split(EOL);
    for (const line of lines) {
        if (!line.trim())
            continue;
        try {
            const parsed = JSON.parse(line);
            if (parsed.type !== 'user')
                continue;
            if (parsed.isMeta)
                continue;
            const content = parsed.message?.content;
            if (!content)
                continue;
            if (Array.isArray(content)) {
                const hasToolResult = content.some((b) => b.type === 'tool_result');
                if (hasToolResult)
                    continue;
                const textBlock = content.find((b) => b.type === 'text' && b.text);
                if (textBlock) {
                    const text = stripSystemTags(textBlock.text);
                    if (text) {
                        return text.length > 200 ? text.substring(0, 200) + '...' : text;
                    }
                }
            }
        }
        catch {
            // 跳过解析错误
        }
    }
    return '';
}
/**
 * 提取最后一个字段值
 */
function extractLastField(content, fieldName) {
    const pattern = new RegExp(`"${fieldName}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'g');
    let lastMatch;
    let match;
    while ((match = pattern.exec(content)) !== null) {
        lastMatch = match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    return lastMatch;
}
/**
 * 移除系统标签
 */
function stripSystemTags(text) {
    if (!text)
        return '';
    return text
        .replace(/<user-prompt-submit-hook[^>]*>[\s\S]*?<\/user-prompt-submit-hook>/g, '')
        .replace(/<short-term-memory[^>]*>[\s\S]*?<\/short-term-memory>/g, '')
        .replace(/<current-time[^>]*>[\s\S]*?<\/current-time>/g, '')
        .replace(/<system-reminder[^>]*>[\s\S]*?<\/system-reminder>/g, '')
        .replace(/<command-name[^>]*>[\s\S]*?<\/command-name>/g, '')
        .replace(/<command-message[^>]*>[\s\S]*?<\/command-message>/g, '')
        .trim();
}
// ============ 缓存管理 ============
let cachedIndex = null;
let cachedProjectDir = '';
/**
 * 获取或重建索引（带缓存）
 */
export function getOrBuildIndex(projectDir, forceRebuild = false) {
    if (!forceRebuild && cachedIndex && cachedProjectDir === projectDir) {
        return cachedIndex;
    }
    cachedIndex = buildBM25Index(projectDir);
    cachedProjectDir = projectDir;
    return cachedIndex;
}
/**
 * 清除索引缓存
 */
export function clearIndexCache() {
    cachedIndex = null;
    cachedProjectDir = '';
}
//# sourceMappingURL=bm25.js.map