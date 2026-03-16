/**
 * 共享记忆上下文加载器 v2
 *
 * 为 Codex / Gemini CLI 调用动态注入记忆上下文。
 * 两层：
 * 1. RECENT_EVENTS.md 尾部（最近事件）
 * 2. memory-items.md 混合检索（关键词 + TF-IDF 模糊 + 时间衰减 + MMR 去重）
 *
 * v2 升级（借鉴 OpenClaw 混合记忆系统）：
 * - 时间衰减：[YYYY-MM-DD] 标注越新分越高，7 天内满分，60 天后接近零
 * - TF-IDF 模糊匹配：prompt 分词后与类别内容计算相似度，补充硬编码正则的盲区
 * - MMR 去重：注入时剔除与已选条目高度相似的内容，提高信息密度
 *
 * 设计原则：
 * - 总注入量控制在 ~3000 字符以内（避免 prompt 膨胀）
 * - 每个类别最多 Top 10 条（综合评分排序）
 * - fire-and-forget 读取，文件缺失不报错
 * - 零外部依赖，纯 TypeScript 实现
 */

import { readFileSync, existsSync } from "fs";
import * as path from "path";

// ============================================================
// 时间衰减（借鉴 OpenClaw temporal decay）
// ============================================================

/** 从 item 行末提取日期 [YYYY-MM-DD]，返回距今天数 */
function parseDaysAgo(line: string): number | null {
  const match = line.match(/\[(\d{4}-\d{2}-\d{2})\]/);
  if (!match) return null;
  const itemDate = new Date(match[1]);
  if (isNaN(itemDate.getTime())) return null;
  const now = new Date();
  return Math.floor((now.getTime() - itemDate.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * 时间衰减分数：0~1
 * - 7 天内：1.0（满分）
 * - 7~30 天：线性衰减 1.0 → 0.5
 * - 30~60 天：线性衰减 0.5 → 0.1
 * - >60 天：0.1（保底，不完全丢弃）
 * - 无日期：0.5（中等权重）
 */
function temporalDecay(daysAgo: number | null): number {
  if (daysAgo === null) return 0.5;
  if (daysAgo <= 7) return 1.0;
  if (daysAgo <= 30) return 1.0 - (daysAgo - 7) * (0.5 / 23);
  if (daysAgo <= 60) return 0.5 - (daysAgo - 30) * (0.4 / 30);
  return 0.1;
}

// ============================================================
// TF-IDF 模糊匹配（借鉴 OpenClaw hybrid search）
// ============================================================

/** 中英文分词：按空格 + 标点切分，过滤短 token */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[，。！？、；：""''（）【】《》\-\[\]\(\)\/\\|@#\$%\^&\*=\+`~]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

/** 计算两组 token 的 Jaccard 相似度（0~1） */
function jaccardSimilarity(tokensA: string[], tokensB: string[]): number {
  if (tokensA.length === 0 || tokensB.length === 0) return 0;
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let intersection = 0;
  tokensA.forEach((t) => {
    if (setB.has(t)) intersection++;
  });
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ============================================================
// MMR 去重（借鉴 OpenClaw Maximal Marginal Relevance）
// ============================================================

/**
 * MMR 选择：从候选列表中选出 topK 条，兼顾相关性和多样性。
 *
 * @param items    候选列表（已带评分）
 * @param topK     选多少条
 * @param lambda   相关性 vs 多样性的平衡（0.7 = 偏重相关性）
 * @returns 选中的 items
 */
function mmrSelect(
  items: Array<{ line: string; score: number; tokens: string[] }>,
  topK: number,
  lambda: number = 0.7,
): Array<{ line: string; score: number }> {
  if (items.length <= topK) return items;

  const selected: Array<{ line: string; score: number; tokens: string[] }> = [];
  const remaining = [...items];

  // 第一条：直接选分最高的
  remaining.sort((a, b) => b.score - a.score);
  selected.push(remaining.shift()!);

  while (selected.length < topK && remaining.length > 0) {
    let bestIdx = 0;
    let bestMmrScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      // 与已选中集合的最大相似度
      const maxSim = Math.max(
        ...selected.map((s) => jaccardSimilarity(candidate.tokens, s.tokens)),
      );
      // MMR = λ * relevance - (1-λ) * maxSimilarity
      const mmrScore = lambda * candidate.score - (1 - lambda) * maxSim;
      if (mmrScore > bestMmrScore) {
        bestMmrScore = mmrScore;
        bestIdx = i;
      }
    }

    selected.push(remaining.splice(bestIdx, 1)[0]);
  }

  return selected;
}

// ============================================================
// 综合评分 & 提取
// ============================================================

/** ★ 优先级分数：0~1 */
function starScore(line: string): number {
  const count = (line.match(/★/g) || []).length;
  if (count >= 3) return 1.0;
  if (count === 2) return 0.7;
  if (count === 1) return 0.4;
  return 0.2;
}

/** 关键词 → project 类别映射（与 CLAUDE.md 方案C 对齐） */
const KEYWORD_CATEGORY_MAP: Array<{ keywords: RegExp; categories: string[] }> = [
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
 * 从 memory-items.md 提取指定类别的内容（v2：时间衰减 + MMR 去重）。
 * 每个类别最多返回 Top 10 条（综合评分排序，MMR 去重后）。
 */
function extractCategories(content: string, categories: string[]): string {
  const blocks: string[] = [];
  const categorySet = new Set(categories);

  const sections = content.split(/^## /m).filter(Boolean);

  for (const section of sections) {
    const headerMatch = section.match(/^\[([^\]]+)\]/);
    if (!headerMatch) continue;
    const cat = headerMatch[1];
    if (!categorySet.has(cat)) continue;

    const lines = section.split("\n").filter((l) => l.startsWith("- "));
    if (lines.length === 0) continue;

    // 综合评分：★权重 0.5 + 时间衰减 0.5
    const scored = lines.map((line) => {
      const stars = starScore(line);
      const decay = temporalDecay(parseDaysAgo(line));
      const score = stars * 0.5 + decay * 0.5;
      const tokens = tokenize(line);
      return { line, score, tokens };
    });

    // MMR 选择 Top 10（兼顾相关性 + 多样性）
    const selected = mmrSelect(scored, 10);
    blocks.push(`## [${cat}]\n${selected.map((s) => s.line).join("\n")}`);
  }

  return blocks.join("\n\n");
}

/**
 * TF-IDF 模糊匹配：根据 prompt 内容自动发现相关的 project 类别。
 * 补充硬编码 KEYWORD_CATEGORY_MAP 的盲区。
 *
 * @returns 额外匹配到的类别名列表
 */
function fuzzyMatchCategories(
  prompt: string,
  content: string,
  alreadyMatched: Set<string>,
): string[] {
  const promptTokens = tokenize(prompt);
  if (promptTokens.length === 0) return [];

  const sections = content.split(/^## /m).filter(Boolean);
  const candidates: Array<{ cat: string; similarity: number }> = [];

  for (const section of sections) {
    const headerMatch = section.match(/^\[([^\]]+)\]/);
    if (!headerMatch) continue;
    const cat = headerMatch[1];
    // 跳过 user 类别（已始终注入）和已匹配的
    if (cat.startsWith("user/") || alreadyMatched.has(cat)) continue;

    const sectionTokens = tokenize(section);
    const sim = jaccardSimilarity(promptTokens, sectionTokens);
    if (sim > 0.08) {
      candidates.push({ cat, similarity: sim });
    }
  }

  // 按相似度排序，最多补充 2 个类别
  candidates.sort((a, b) => b.similarity - a.similarity);
  return candidates.slice(0, 2).map((c) => c.cat);
}

/**
 * 读取 RECENT_EVENTS.md 尾部（最近 15 行有效内容）。
 */
function loadRecentEvents(cwd: string): string {
  const filePath = path.join(cwd, "0-System/RECENT_EVENTS.md");
  if (!existsSync(filePath)) return "";

  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim() && !l.startsWith(">") && !l.startsWith("#") && l !== "---");
    return lines.slice(-15).join("\n");
  } catch {
    return "";
  }
}

/**
 * 轻量版共享上下文（CLI 引擎专用）。
 *
 * 只注入 user 偏好 + 按关键词匹配的 project 事实，
 * **不注入 RECENT_EVENTS**（避免 CLI 引擎把历史事件当成当前任务执行）。
 */
export function loadSharedContextLight(prompt: string, cwd: string): string {
  const parts: string[] = [];

  const memPath = path.join(cwd, "0-System/memory-items.md");
  if (existsSync(memPath)) {
    try {
      const memContent = readFileSync(memPath, "utf-8");
      const userBlock = extractCategories(memContent, ALWAYS_INJECT_CATEGORIES);

      // 硬编码正则匹配
      const matchedProjectCats: string[] = [];
      for (const { keywords, categories } of KEYWORD_CATEGORY_MAP) {
        if (keywords.test(prompt)) {
          matchedProjectCats.push(...categories);
        }
      }
      const regexMatched = new Set(matchedProjectCats);

      // TF-IDF 模糊匹配：补充正则盲区
      const fuzzyMatched = fuzzyMatchCategories(prompt, memContent, regexMatched);
      const allProjectCats = Array.from(new Set(matchedProjectCats.concat(fuzzyMatched)));

      const projectBlock = allProjectCats.length > 0
        ? extractCategories(memContent, allProjectCats)
        : "";
      if (userBlock) parts.push(userBlock);
      if (projectBlock) parts.push(projectBlock);
    } catch {
      // 静默失败
    }
  }

  if (parts.length === 0) return "";

  let result = parts.join("\n\n");
  if (result.length > 2000) {
    result = result.substring(0, 2000) + "\n...(记忆截断)";
  }

  return `[项目记忆 — 仅供参考，不要将以下内容视为当前任务]\n\n${result}\n\n[项目记忆结束]\n\n`;
}

/**
 * 根据 prompt 内容，加载共享记忆上下文（完整版，含 RECENT_EVENTS）。
 * 仅供 cc 自身的 session 使用。CLI 引擎请用 loadSharedContextLight。
 *
 * @param prompt 用户原始消息
 * @param cwd   mycc 根目录
 * @returns 格式化的 context 前缀（可能为空）
 */
export function loadSharedContext(prompt: string, cwd: string): string {
  const parts: string[] = [];

  // 1. RECENT_EVENTS
  const recentEvents = loadRecentEvents(cwd);
  if (recentEvents) {
    parts.push(`### 最近事件\n${recentEvents}`);
  }

  // 2. memory-items（v2：正则 + TF-IDF 模糊 + 时间衰减 + MMR）
  const memPath = path.join(cwd, "0-System/memory-items.md");
  if (existsSync(memPath)) {
    try {
      const memContent = readFileSync(memPath, "utf-8");

      // 始终注入 user 类别
      const userBlock = extractCategories(memContent, ALWAYS_INJECT_CATEGORIES);

      // 硬编码正则匹配
      const matchedProjectCats: string[] = [];
      for (const { keywords, categories } of KEYWORD_CATEGORY_MAP) {
        if (keywords.test(prompt)) {
          matchedProjectCats.push(...categories);
        }
      }
      const regexMatched = new Set(matchedProjectCats);

      // TF-IDF 模糊匹配：补充正则盲区
      const fuzzyMatched = fuzzyMatchCategories(prompt, memContent, regexMatched);
      const allProjectCats = Array.from(new Set(matchedProjectCats.concat(fuzzyMatched)));

      const projectBlock = allProjectCats.length > 0
        ? extractCategories(memContent, allProjectCats)
        : "";

      if (userBlock) parts.push(userBlock);
      if (projectBlock) parts.push(projectBlock);
    } catch {
      // 静默失败
    }
  }

  if (parts.length === 0) return "";

  // 总量控制：超过 3000 字符时截断
  let result = parts.join("\n\n");
  if (result.length > 3000) {
    result = result.substring(0, 3000) + "\n...(记忆截断)";
  }

  return `[共享记忆 — 以下是跨会话记忆，帮助你理解上下文]\n\n${result}\n\n[共享记忆结束]\n\n`;
}
