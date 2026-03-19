/**
 * 共享记忆上下文加载器
 *
 * 为 Codex / Gemini CLI 调用动态注入记忆上下文。
 * 两层：
 * 1. RECENT_EVENTS.md 尾部（最近事件）
 * 2. memory-items.md 关键词匹配类别（[user/*] 始终注入，[project/*] 按需）
 *
 * 设计原则：
 * - 总注入量控制在 ~3000 字符以内（避免 prompt 膨胀）
 * - 每个类别最多 Top 10 条（按 ★ 优先级排序）
 * - fire-and-forget 读取，文件缺失不报错
 */
import { readFileSync, existsSync } from "fs";
import * as path from "path";
/** 关键词 → project 类别映射（与 CLAUDE.md 方案C 对齐） */
const KEYWORD_CATEGORY_MAP = [
    { keywords: /飞书|机器人|卡片|消息|通道|feishu|lark/i, categories: ["project/技术-飞书", "project/技术-飞书多通道"] },
    { keywords: /黄金|金价|数据|采集|gold/i, categories: ["project/技术-数据", "project/技术-RSS采集"] },
    { keywords: /bug|错误|修复|报错|fix|error/i, categories: ["project/Bug-Fix", "project/Bug-Fix-已知", "project/Bug-Fix-MCP"] },
    { keywords: /知识库|wiki|futurus|飞书文档/i, categories: ["project/FUTURUS知识库"] },
    { keywords: /配置|后端|端口|mycc|启动|服务/i, categories: ["project/配置-mycc后端"] },
    { keywords: /路径|文件|脚本/i, categories: ["project/路径-关键文件", "project/路径-记忆系统"] },
    { keywords: /论文|arxiv|理论|radar|前沿/i, categories: ["project/FUTURUS知识库"] },
    { keywords: /决策|架构|设计/i, categories: ["project/决策"] },
    { keywords: /tell.?me|通知|飞书通知/i, categories: ["project/配置-tell-me"] },
    { keywords: /定时|scheduler|cron|任务调度|每日任务/i, categories: ["project/配置-mycc后端", "project/状态"] },
    { keywords: /桌面|desktop|ghost|自动化|点击|截图|操控/i, categories: ["project/状态"] },
    { keywords: /状态|进度|运行|接入|更新/i, categories: ["project/状态"] },
];
/** 始终注入的 user 类别 */
const ALWAYS_INJECT_CATEGORIES = [
    "user/topOfMind",
    "user/偏好",
    "user/方法论",
    "user/全局规则",
];
/**
 * 从 memory-items.md 提取指定类别的内容。
 * 每个类别最多返回 Top 10 条（★ 多的优先）。
 */
function extractCategories(content, categories) {
    const blocks = [];
    const categorySet = new Set(categories);
    // 按 ## [xxx] 分割
    const sections = content.split(/^## /m).filter(Boolean);
    for (const section of sections) {
        const headerMatch = section.match(/^\[([^\]]+)\]/);
        if (!headerMatch)
            continue;
        const cat = headerMatch[1];
        if (!categorySet.has(cat))
            continue;
        // 提取列表项（- 开头的行）
        const lines = section.split("\n").filter((l) => l.startsWith("- "));
        if (lines.length === 0)
            continue;
        // 按 ★ 数量排序（多的在前）
        const sorted = lines.sort((a, b) => {
            const countStars = (s) => (s.match(/★/g) || []).length;
            return countStars(b) - countStars(a);
        });
        // 取 Top 10
        const top = sorted.slice(0, 10);
        blocks.push(`## [${cat}]\n${top.join("\n")}`);
    }
    return blocks.join("\n\n");
}
/**
 * 读取 RECENT_EVENTS.md 尾部（最近 15 行有效内容）。
 */
function loadRecentEvents(cwd) {
    const filePath = path.join(cwd, "0-System/RECENT_EVENTS.md");
    if (!existsSync(filePath))
        return "";
    try {
        const content = readFileSync(filePath, "utf-8");
        const lines = content.split("\n").filter((l) => l.trim() && !l.startsWith(">") && !l.startsWith("#") && l !== "---");
        return lines.slice(-15).join("\n");
    }
    catch {
        return "";
    }
}
/**
 * 根据 prompt 内容，加载共享记忆上下文。
 *
 * @param prompt 用户原始消息
 * @param cwd   mycc 根目录
 * @returns 格式化的 context 前缀（可能为空）
 */
export function loadSharedContext(prompt, cwd) {
    const parts = [];
    // 1. RECENT_EVENTS
    const recentEvents = loadRecentEvents(cwd);
    if (recentEvents) {
        parts.push(`### 最近事件\n${recentEvents}`);
    }
    // 2. memory-items
    const memPath = path.join(cwd, "0-System/memory-items.md");
    if (existsSync(memPath)) {
        try {
            const memContent = readFileSync(memPath, "utf-8");
            // 始终注入 user 类别
            const userBlock = extractCategories(memContent, ALWAYS_INJECT_CATEGORIES);
            // 按关键词匹配 project 类别
            const matchedProjectCats = [];
            for (const { keywords, categories } of KEYWORD_CATEGORY_MAP) {
                if (keywords.test(prompt)) {
                    matchedProjectCats.push(...categories);
                }
            }
            const projectBlock = matchedProjectCats.length > 0
                ? extractCategories(memContent, [...new Set(matchedProjectCats)])
                : "";
            if (userBlock)
                parts.push(userBlock);
            if (projectBlock)
                parts.push(projectBlock);
        }
        catch {
            // 静默失败
        }
    }
    if (parts.length === 0)
        return "";
    // 总量控制：超过 3000 字符时截断
    let result = parts.join("\n\n");
    if (result.length > 3000) {
        result = result.substring(0, 3000) + "\n...(记忆截断)";
    }
    return `[共享记忆 — 以下是跨会话记忆，帮助你理解上下文]\n\n${result}\n\n[共享记忆结束]\n\n`;
}
//# sourceMappingURL=context-loader.js.map