/**
 * 共享记忆上下文加载器 v4
 *
 * 为 Codex / Gemini CLI 调用动态注入记忆上下文。
 * 两层：
 * 1. RECENT_EVENTS.md 尾部（最近事件）
 * 2. memory-items.md 混合检索（向量语义 + 关键词 TF-IDF + 时间衰减 + MMR 去重 + 残差版本链）
 *
 * v4 升级（借鉴 TurboQuant 失真率理论）：
 * - 向量语义检索：Qwen3-Embedding-0.6B (512维) + 余弦相似度，语义泛化能力质的飞跃
 * - 混合评分：final = 0.4×keyword + 0.6×vector，取两者长处
 * - 残差版本链：#base + →Δ: 替代旧 →updates:，信息不再丢失
 * - 降级机制：Ollama 不可用时自动 fallback 到纯关键词（v3 逻辑）
 *
 * v3 保留：
 * - 双时间戳：[YYYY-MM-DD] 写入日期 + [event:YYYY-MM-DD] 事件日期
 * - TF-IDF cosine：关键词级别的模糊匹配
 * - 智能遗忘：eventDate 过期条目自动降权
 *
 * v2 保留：
 * - 时间衰减：[YYYY-MM-DD] 标注越新分越高
 * - MMR 去重：注入时剔除高度相似内容
 *
 * 设计原则：
 * - 总注入量控制在 ~3000 字符以内（避免 prompt 膨胀）
 * - 每个类别最多 Top 10 条（综合评分排序）
 * - fire-and-forget 读取，文件缺失不报错
 * - Ollama 离线时无感降级，零阻塞
 */

import { readFileSync, existsSync } from "fs";
import * as path from "path";
import {
  embed,
  loadVectorIndex,
  vectorSearch,
  cosineSim,
  type VectorIndex,
} from "./embedding.js";

// ============================================================
// 时间衰减 v3（双时间戳 + 事件感知，借鉴 Supermemory temporal grounding）
// ============================================================

/** 从 item 行末提取写入日期 [YYYY-MM-DD]，返回距今天数 */
function parseDaysAgo(line: string): number | null {
  // 排除 [event:...] 格式，只匹配裸日期
  const match = line.match(/\[(\d{4}-\d{2}-\d{2})\](?!.*\[event:)/);
  if (!match) {
    // fallback: 匹配任意非 event 的日期
    const fallback = line.match(/(?<!\bevent:)\[(\d{4}-\d{2}-\d{2})\]/);
    if (!fallback) return null;
    const d = new Date(fallback[1]);
    if (isNaN(d.getTime())) return null;
    return Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
  }
  const itemDate = new Date(match[1]);
  if (isNaN(itemDate.getTime())) return null;
  return Math.floor((Date.now() - itemDate.getTime()) / (1000 * 60 * 60 * 24));
}

/** v3: 从 item 行提取事件日期 [event:YYYY-MM-DD]，返回距今天数（负数=未来） */
function parseEventDaysAgo(line: string): number | null {
  const match = line.match(/\[event:(\d{4}-\d{2}-\d{2})\]/);
  if (!match) return null;
  const eventDate = new Date(match[1]);
  if (isNaN(eventDate.getTime())) return null;
  return Math.floor((Date.now() - eventDate.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * 写入日期衰减分数：0~1（v2 逻辑保持不变）
 */
function writeDecay(daysAgo: number | null): number {
  if (daysAgo === null) return 0.5;
  if (daysAgo <= 7) return 1.0;
  if (daysAgo <= 30) return 1.0 - (daysAgo - 7) * (0.5 / 23);
  if (daysAgo <= 60) return 0.5 - (daysAgo - 30) * (0.4 / 30);
  return 0.1;
}

/**
 * v3: 综合时间衰减（双时间戳感知）
 *
 * 优先使用 eventDate 判断相关性：
 * - eventDate 已过期 >7天 → 极低分（事件已结束，如"明天考试"）
 * - eventDate 未来 3 天内 → 满分（即将发生）
 * - eventDate 未来 14 天内 → 高分
 * - 无 eventDate → 回退到 writeDate 衰减
 */
function temporalDecay(writeDaysAgo: number | null, eventDaysAgo: number | null): number {
  if (eventDaysAgo !== null) {
    if (eventDaysAgo > 7) return 0.05;       // 事件已过 7 天 → 过期
    if (eventDaysAgo > 0) return 0.3;         // 事件刚过 1-7 天 → 仍有参考价值
    if (eventDaysAgo >= -3) return 1.0;       // 未来 3 天内 → 最相关
    if (eventDaysAgo >= -14) return 0.8;      // 未来 2 周内 → 高相关
    return 0.6;                                // 更远的未来 → 中等
  }
  return writeDecay(writeDaysAgo);
}

// ============================================================
// 残差版本链 v4（借鉴 TurboQuant 基线+残差修正理论）
// ============================================================

/**
 * v4: 解析残差版本链关系。
 *
 * 三种标记：
 * - #base — 基线事实（保留）
 * - →Δ:关键词 — 增量修正（保留，检索时自动关联基线）
 * - →supersedes:关键词 — 完全重写（旧基线+Δ 归零）
 * - →updates:关键词 — v3 旧标记，视为 →supersedes: 向后兼容
 */
function resolveRelations(
  items: Array<{ line: string; score: number; tokens: string[] }>,
): Array<{ line: string; score: number; tokens: string[] }> {
  // 收集所有 →supersedes: 和 →updates:（向后兼容）标记
  const supersededKeywords: string[] = [];
  for (const item of items) {
    const supersedesMatch = item.line.match(/→supersedes:(.+?)(?:\s*\[|\s*#|\s*$)/);
    if (supersedesMatch) {
      supersededKeywords.push(supersedesMatch[1].trim().toLowerCase());
    }
    const updatesMatch = item.line.match(/→updates:(.+?)(?:\s*\[|\s*#|\s*$)/);
    if (updatesMatch) {
      supersededKeywords.push(updatesMatch[1].trim().toLowerCase());
    }
  }

  // →Δ: 标记的条目正常保留（不被抑制，也不抑制别人）
  // #base 条目正常保留（除非被 →supersedes 命中）

  if (supersededKeywords.length === 0) return items;

  return items.map((item) => {
    // 含 →supersedes: 或 →updates: 的条目自身不被抑制
    if (item.line.includes("→supersedes:") || item.line.includes("→updates:")) return item;
    // →Δ: 条目不被 supersedes 抑制（增量修正指向的是新基线）
    if (item.line.includes("→Δ:")) return item;
    // 检查是否被某个 supersedes 关键词命中
    const lineLower = item.line.toLowerCase();
    for (const kw of supersededKeywords) {
      if (lineLower.includes(kw)) {
        return { ...item, score: 0 };
      }
    }
    return item;
  });
}

// ============================================================
// TF-IDF cosine 相似度（v3: 从 Jaccard 升级，借鉴 Supermemory hybrid search）
// ============================================================

/** 中英文分词：按空格 + 标点切分，过滤短 token */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[，。！？、；：""''（）【】《》\-\[\]\(\)\/\\|@#\$%\^&\*=\+`~]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

/** v3: 构建 TF 向量（词频归一化） */
function buildTfVector(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  tokens.forEach((t) => {
    tf.set(t, (tf.get(t) || 0) + 1);
  });
  // 归一化
  const len = tokens.length || 1;
  const keys = Array.from(tf.keys());
  keys.forEach((k) => {
    tf.set(k, (tf.get(k) || 0) / len);
  });
  return tf;
}

/** v3: cosine 相似度（替代 Jaccard，对长短文本差异更鲁棒） */
function cosineSimilarity(vecA: Map<string, number>, vecB: Map<string, number>): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  Array.from(vecA.keys()).forEach((term) => {
    const wA = vecA.get(term) || 0;
    normA += wA * wA;
    const wB = vecB.get(term) || 0;
    dotProduct += wA * wB;
  });
  Array.from(vecB.keys()).forEach((term) => {
    const wB = vecB.get(term) || 0;
    normB += wB * wB;
  });
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** 向后兼容：MMR 去重仍用 Jaccard（轻量，只对已选条目间比较） */
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
 * 从 memory-items.md 提取指定类别的内容。
 * v3：双时间戳 + 关系链解析 + 时间衰减 + MMR 去重。
 * 每个类别最多返回 Top 10 条。
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

    // v3: 综合评分 = ★权重 0.5 + 双时间戳衰减 0.5
    let scored = lines.map((line) => {
      const stars = starScore(line);
      const decay = temporalDecay(parseDaysAgo(line), parseEventDaysAgo(line));
      const score = stars * 0.5 + decay * 0.5;
      const tokens = tokenize(line);
      return { line, score, tokens };
    });

    // v3: 关系链解析 — 被 →updates: 取代的旧条目 score 归零
    scored = resolveRelations(scored);

    // MMR 选择 Top 10（兼顾相关性 + 多样性）
    const selected = mmrSelect(scored, 10);
    blocks.push(`## [${cat}]\n${selected.map((s) => s.line).join("\n")}`);
  }

  return blocks.join("\n\n");
}

/**
 * v3: TF-IDF cosine 模糊匹配（从 Jaccard 升级）。
 * 根据 prompt 内容自动发现相关的 project 类别。
 * cosine 相似度对长短文本差异更鲁棒，召回率优于 Jaccard。
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
  const promptTf = buildTfVector(promptTokens);

  const sections = content.split(/^## /m).filter(Boolean);
  const candidates: Array<{ cat: string; similarity: number }> = [];

  for (const section of sections) {
    const headerMatch = section.match(/^\[([^\]]+)\]/);
    if (!headerMatch) continue;
    const cat = headerMatch[1];
    // 跳过 user 类别（已始终注入）和已匹配的
    if (cat.startsWith("user/") || alreadyMatched.has(cat)) continue;

    const sectionTokens = tokenize(section);
    const sectionTf = buildTfVector(sectionTokens);
    const sim = cosineSimilarity(promptTf, sectionTf);
    if (sim > 0.05) {
      candidates.push({ cat, similarity: sim });
    }
  }

  // 按相似度排序，最多补充 2 个类别
  candidates.sort((a, b) => b.similarity - a.similarity);
  return candidates.slice(0, 2).map((c) => c.cat);
}

// ============================================================
// 向量语义检索 v4（借鉴 TurboQuant 向量量化思路）
// ============================================================

/** 缓存：避免同一 session 内重复读取索引文件 */
let _vectorIndexCache: VectorIndex | null = null;
let _vectorIndexMtime: number = 0;

/** 加载向量索引（带文件修改时间缓存） */
function getVectorIndex(cwd: string): VectorIndex | null {
  const indexPath = path.join(cwd, "0-System/memory-vectors.json");
  if (!existsSync(indexPath)) return null;

  try {
    const { mtimeMs } = require("fs").statSync(indexPath);
    if (_vectorIndexCache && mtimeMs === _vectorIndexMtime) {
      return _vectorIndexCache;
    }
    _vectorIndexCache = loadVectorIndex(cwd);
    _vectorIndexMtime = mtimeMs;
    return _vectorIndexCache;
  } catch {
    return null;
  }
}

/**
 * v4: 向量语义匹配类别。
 *
 * 将 prompt embed 后，与索引中所有 item 做余弦相似度，
 * 按类别聚合分数，返回得分最高的类别。
 *
 * @returns 语义匹配到的 project 类别列表（最多 3 个）
 */
async function vectorMatchCategories(
  prompt: string,
  cwd: string,
  alreadyMatched: Set<string>,
): Promise<Array<{ cat: string; score: number }>> {
  const index = getVectorIndex(cwd);
  if (!index || index.items.length === 0) return [];

  const queryVec = await embed(prompt);
  if (!queryVec) return [];

  // 对所有 item 计算相似度
  const hits = vectorSearch(queryVec, index, 30);

  // 按类别聚合：每个类别取 top-3 item 的平均分
  const catScores = new Map<string, number[]>();
  for (const { item, similarity } of hits) {
    if (item.category.startsWith("user/")) continue;
    if (alreadyMatched.has(item.category)) continue;
    const scores = catScores.get(item.category) || [];
    scores.push(similarity);
    catScores.set(item.category, scores);
  }

  const results: Array<{ cat: string; score: number }> = [];
  for (const [cat, scores] of catScores) {
    const top3 = scores.sort((a, b) => b - a).slice(0, 3);
    const avg = top3.reduce((s, v) => s + v, 0) / top3.length;
    if (avg > 0.3) {
      results.push({ cat, score: avg });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 3);
}

/**
 * v4: 混合类别匹配 — 合并关键词和向量结果。
 *
 * 策略：keyword 命中的类别直接保留 + 向量补充（去重后最多 2 个）
 */
async function hybridMatchCategories(
  prompt: string,
  memContent: string,
  cwd: string,
): Promise<string[]> {
  // 第一步：关键词正则匹配（确定性，精确）
  const keywordCats: string[] = [];
  for (const { keywords, categories } of KEYWORD_CATEGORY_MAP) {
    if (keywords.test(prompt)) {
      keywordCats.push(...categories);
    }
  }
  const regexMatched = new Set(keywordCats);

  // 第二步：TF-IDF 模糊匹配（补充正则盲区，最多 2 个）
  const tfIdfCats = fuzzyMatchCategories(prompt, memContent, regexMatched);
  const afterTfIdf = new Set([...regexMatched, ...tfIdfCats]);

  // 第三步：向量语义匹配（最深层补充，最多 2 个）
  const vectorCats = await vectorMatchCategories(prompt, cwd, afterTfIdf);
  const vectorCatNames = vectorCats.slice(0, 2).map((c) => c.cat);

  // 合并去重
  return Array.from(new Set([...keywordCats, ...tfIdfCats, ...vectorCatNames]));
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
 * 只注入 user 偏好 + 按混合匹配的 project 事实，
 * **不注入 RECENT_EVENTS**（避免 CLI 引擎把历史事件当成当前任务执行）。
 *
 * v4: async，支持向量语义检索（Ollama 离线时自动降级到纯关键词）。
 */
export async function loadSharedContextLight(prompt: string, cwd: string): Promise<string> {
  const parts: string[] = [];

  const memPath = path.join(cwd, "0-System/memory-items.md");
  if (existsSync(memPath)) {
    try {
      const memContent = readFileSync(memPath, "utf-8");
      const userBlock = extractCategories(memContent, ALWAYS_INJECT_CATEGORIES);

      // v4: 混合类别匹配（关键词 + TF-IDF + 向量语义）
      const allProjectCats = await hybridMatchCategories(prompt, memContent, cwd);

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
 * v4: async，支持向量语义检索。
 *
 * @param prompt 用户原始消息
 * @param cwd   mycc 根目录
 * @returns 格式化的 context 前缀（可能为空）
 */
export async function loadSharedContext(prompt: string, cwd: string): Promise<string> {
  const parts: string[] = [];

  // 1. RECENT_EVENTS
  const recentEvents = loadRecentEvents(cwd);
  if (recentEvents) {
    parts.push(`### 最近事件\n${recentEvents}`);
  }

  // 2. memory-items（v4：关键词 + TF-IDF + 向量语义 + 时间衰减 + MMR）
  const memPath = path.join(cwd, "0-System/memory-items.md");
  if (existsSync(memPath)) {
    try {
      const memContent = readFileSync(memPath, "utf-8");

      // 始终注入 user 类别
      const userBlock = extractCategories(memContent, ALWAYS_INJECT_CATEGORIES);

      // v4: 混合类别匹配（关键词 + TF-IDF + 向量语义）
      const allProjectCats = await hybridMatchCategories(prompt, memContent, cwd);

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
