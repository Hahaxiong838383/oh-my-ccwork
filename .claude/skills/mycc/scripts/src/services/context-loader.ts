/**
 * 共享记忆上下文加载器 v5.5
 *
 * 为 Codex / Gemini CLI 调用动态注入记忆上下文。
 * 两层：
 * 1. RECENT_EVENTS.md 尾部（最近事件）
 * 2. memory-items.md 混合检索（向量语义 + 关键词 TF-IDF + 时间衰减 + MMR 去重 + 残差版本链）
 *
 * v5.5 升级（借鉴 QMD reranker pipeline）：
 * - LLM 重排：MMR 后用 Qwen3-Reranker-0.6B 对 Top 20 候选二次打分
 * - 最终分数 = 0.6 * rerankScore + 0.4 * originalScore
 * - 降级：Ollama 不可用或 reranker 模型未加载时跳过，直接用 MMR 结果
 *
 * v4.5 保留：
 * - RRF 融合：三路检索结果用 Reciprocal Rank Fusion 统一排序
 * - 检索轨迹：每次注入记录命中类别/条目/分数，写入 trajectories/recall-*.jsonl
 *
 * v4 保留：
 * - 向量语义检索：Qwen3-Embedding-0.6B (512维) + 余弦相似度
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

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "fs";
import * as path from "path";
import {
  embed,
  loadVectorIndex,
  vectorSearch,
  cosineSim,
  type VectorIndex,
} from "./embedding.js";
import {
  getDB,
  syncAll as syncDB,
  getItemsByCategory,
  getCategorySummary,
  searchItems as searchItemsDB,
  vectorSearchDB,
  saveTrace as saveTraceDB,
  type ItemRow,
} from "./memory-db.js";

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

/** v5: 始终注入的类别（user + agent scope） */
const ALWAYS_INJECT_CATEGORIES = [
  "user/topOfMind",
  "user/偏好",
  "user/方法论",
  "user/全局规则",
  "agent/技能",
  "agent/踩坑",
];

// ============================================================
// L0/L1/L2 渐进加载 v5（借鉴 OpenViking 三层加载，token 降 91%）
// ============================================================

/**
 * 对 memory-items 中的一个 section 进行评分排序。
 * 公共逻辑，供 L1/L2 提取共用。
 */
function scoreSectionItems(
  section: string,
): Array<{ line: string; score: number; tokens: string[] }> {
  const lines = section.split("\n").filter((l) => l.startsWith("- "));
  if (lines.length === 0) return [];

  let scored = lines.map((line) => {
    const stars = starScore(line);
    const decay = temporalDecay(parseDaysAgo(line), parseEventDaysAgo(line));
    const score = stars * 0.5 + decay * 0.5;
    const tokens = tokenize(line);
    return { line, score, tokens };
  });

  return resolveRelations(scored);
}

/**
 * v5.5 L0: 从 SQLite 生成类别概览（比文件解析快）。
 * 降级：SQLite 不可用时返回空字符串，回退到 generateL0Overview。
 */
function generateL0OverviewFromDB(cwd: string): string {
  const db = getDB(cwd);
  if (!db) return "";

  try {
    const cats = getCategorySummary(cwd);
    if (cats.length === 0) return "";

    const lines: string[] = [];
    for (const { category, count } of cats) {
      if (category.startsWith("user/")) continue;

      // 从 SQLite 取该类别的 top 关键词
      const items = getItemsByCategory(cwd, category);
      const allTokens = items.flatMap((i) => tokenize(i.content));
      const freq = new Map<string, number>();
      for (const t of allTokens) {
        freq.set(t, (freq.get(t) || 0) + 1);
      }
      const stopWords = new Set(["★★★", "★★", "已", "的", "在", "和", "cc", "了", "是", "为", "不", "有", "这", "到", "也"]);
      const topKeywords = Array.from(freq.entries())
        .filter(([w]) => !stopWords.has(w) && w.length >= 2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([w]) => w);

      lines.push(`[${category}] ${count}条：${topKeywords.join("、")}`);
    }

    return lines.join("\n");
  } catch {
    return "";
  }
}

/**
 * v5 L0: 为所有 project/agent 类别生成一行概览。
 *
 * 格式：[类别名] N 条：关键词1、关键词2、关键词3
 * 不用 LLM，纯 TF-IDF 提取 Top 关键词 + 模板。
 * 总开销 ~400 token，让 cc 知道"存在哪些记忆类别"。
 */
function generateL0Overview(content: string): string {
  const sections = content.split(/^## /m).filter(Boolean);
  const overviewLines: string[] = [];

  for (const section of sections) {
    const headerMatch = section.match(/^\[([^\]]+)\]/);
    if (!headerMatch) continue;
    const cat = headerMatch[1];
    // L0 只覆盖 project/* 和 agent/*（user/* 已始终注入完整内容）
    if (cat.startsWith("user/")) continue;

    const lines = section.split("\n").filter((l) => l.startsWith("- "));
    if (lines.length === 0) continue;

    // 提取 Top 5 高频关键词（TF-IDF 简化版：直接统计词频）
    const allTokens = lines.flatMap((l) => tokenize(l));
    const freq = new Map<string, number>();
    for (const t of allTokens) {
      freq.set(t, (freq.get(t) || 0) + 1);
    }
    // 排除过于通用的词
    const stopWords = new Set(["★★★", "★★", "已", "的", "在", "和", "cc", "了", "是", "为", "不", "有", "这", "到", "也"]);
    const topKeywords = Array.from(freq.entries())
      .filter(([w]) => !stopWords.has(w) && w.length >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([w]) => w);

    overviewLines.push(`[${cat}] ${lines.length}条：${topKeywords.join("、")}`);
  }

  return overviewLines.join("\n");
}

/**
 * v5.5 L2: 从 memory-items.md 提取指定类别的完整内容（Top 10）。
 *
 * v5.5 升级：MMR 选择后增加 LLM rerank 阶段。
 * - MMR 先选 Top 20 候选 → reranker 二次打分 → 取 Top 10
 * - reranker 不可用时降级为直接 MMR Top 10（v4 逻辑）
 *
 * @param query  用户原始查询（供 reranker 评估相关性）
 */
async function extractCategories(
  content: string,
  categories: string[],
  query?: string,
): Promise<string> {
  const blocks: string[] = [];
  const categorySet = new Set(categories);

  const sections = content.split(/^## /m).filter(Boolean);

  for (const section of sections) {
    const headerMatch = section.match(/^\[([^\]]+)\]/);
    if (!headerMatch) continue;
    const cat = headerMatch[1];
    if (!categorySet.has(cat)) continue;

    const scored = scoreSectionItems(section);
    if (scored.length === 0) continue;

    let selected: Array<{ line: string; score: number }>;

    if (query && scored.length > 10) {
      // v5.5: MMR 先选 Top 20 → LLM rerank → 取 Top 10
      const mmrCandidates = mmrSelect(scored, 20) as Array<{ line: string; score: number; tokens: string[] }>;
      const reranked = await llmRerank(query, mmrCandidates);
      selected = reranked.slice(0, 10);
    } else {
      // 候选不多或无 query → 直接 MMR Top 10
      selected = mmrSelect(scored, 10);
    }

    blocks.push(`## [${cat}]\n${selected.map((s) => s.line).join("\n")}`);
  }

  return blocks.join("\n\n");
}

// fuzzyMatchCategories 已被 fuzzyMatchCategoriesWithScores 替代（v4.5 RRF 需要分数）

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

// ============================================================
// RRF 融合 v4.5（借鉴 QMD Reciprocal Rank Fusion）
// ============================================================

/** RRF k 值：Cormack et al. (2009) 标准推荐值 */
const RRF_K = 60;

/**
 * v4.5: Reciprocal Rank Fusion — 将多路排名列表融合为统一评分。
 *
 * RRF_score(cat) = Σ 1/(k + rank_i)
 * 比简单 union 去重有理论支撑：位置信息不丢失，多路命中加权。
 */
function rrfFuse(
  rankedLists: Array<Array<{ category: string; rank: number }>>,
): Array<{ category: string; score: number }> {
  const scores = new Map<string, number>();
  for (const list of rankedLists) {
    for (const { category, rank } of list) {
      const prev = scores.get(category) || 0;
      scores.set(category, prev + 1 / (RRF_K + rank));
    }
  }
  return Array.from(scores.entries())
    .map(([category, score]) => ({ category, score }))
    .sort((a, b) => b.score - a.score);
}

// ============================================================
// LLM 重排 v5.5（借鉴 QMD reranker pipeline）
// ============================================================

const RERANKER_MODEL = "qwen3-reranker:0.6b";
const RERANKER_TIMEOUT_MS = 15_000;

/** 缓存 reranker 可用性（避免每次请求都检查） */
let _rerankerAvailable: boolean | null = null;
let _rerankerCheckTime = 0;
const RERANKER_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 分钟重新检查

/** 检查 reranker 模型是否可用 */
async function isRerankerReady(): Promise<boolean> {
  const now = Date.now();
  if (_rerankerAvailable !== null && now - _rerankerCheckTime < RERANKER_CHECK_INTERVAL_MS) {
    return _rerankerAvailable;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) {
      _rerankerAvailable = false;
      _rerankerCheckTime = now;
      return false;
    }

    const data = (await res.json()) as { models?: Array<{ name: string }> };
    _rerankerAvailable = (data.models || []).some((m) => m.name.includes("qwen3-reranker"));
    _rerankerCheckTime = now;
    return _rerankerAvailable;
  } catch {
    _rerankerAvailable = false;
    _rerankerCheckTime = now;
    return false;
  }
}

/**
 * v5.5: 用 Qwen3-Reranker 对候选 items 二次打分。
 *
 * 输入 query + items，输出 rerankScore 0~1。
 * 最终分数 = 0.6 * rerankScore + 0.4 * originalScore（归一化后）。
 *
 * 降级：模型不可用 → 直接返回原列表，不阻塞。
 */
async function llmRerank(
  query: string,
  items: Array<{ line: string; score: number; tokens: string[] }>,
): Promise<Array<{ line: string; score: number; tokens: string[] }>> {
  if (items.length === 0) return items;

  const ready = await isRerankerReady();
  if (!ready) return items;

  try {
    // 构建 reranker 输入：逐条评估相关性
    const documents = items.map((item) => item.line.substring(0, 200));
    const prompt = `Query: ${query.substring(0, 100)}\n\nRate each document's relevance (0.0-1.0):\n${documents.map((d, i) => `[${i}] ${d}`).join("\n")}\n\nOutput JSON array of scores:`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RERANKER_TIMEOUT_MS);

    const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: RERANKER_MODEL,
        prompt,
        stream: false,
        options: { temperature: 0, num_predict: 200 },
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) return items;

    const data = (await res.json()) as { response?: string };
    const responseText = data.response || "";

    // 解析分数：尝试提取 JSON 数组 或 逐行浮点数
    const scores = parseRerankScores(responseText, items.length);
    if (!scores) return items;

    // 归一化原始分数到 0~1
    const maxOriginal = Math.max(...items.map((i) => i.score), 0.001);
    const RERANK_WEIGHT = 0.6;
    const ORIGINAL_WEIGHT = 0.4;

    const reranked = items.map((item, idx) => ({
      ...item,
      score: RERANK_WEIGHT * scores[idx] + ORIGINAL_WEIGHT * (item.score / maxOriginal),
    }));

    reranked.sort((a, b) => b.score - a.score);
    return reranked;
  } catch {
    return items; // 降级：静默回退
  }
}

/** 从 reranker 输出解析分数数组 */
function parseRerankScores(text: string, expectedLength: number): number[] | null {
  // 尝试 1：JSON 数组
  const jsonMatch = text.match(/\[[\d.,\s]+\]/);
  if (jsonMatch) {
    try {
      const arr = JSON.parse(jsonMatch[0]) as number[];
      if (arr.length === expectedLength && arr.every((n) => typeof n === "number")) {
        return arr.map((n) => Math.max(0, Math.min(1, n)));
      }
    } catch { /* fallthrough */ }
  }

  // 尝试 2：逐行浮点数
  const floats = text.match(/\d+\.\d+/g);
  if (floats && floats.length >= expectedLength) {
    return floats.slice(0, expectedLength).map((f) => Math.max(0, Math.min(1, parseFloat(f))));
  }

  return null;
}

// ============================================================
// Ollama 配置（与 embedding.ts 共享端点）
// ============================================================

const OLLAMA_BASE = process.env.OLLAMA_HOST || "http://localhost:11434";

// ============================================================
// 检索轨迹 v4.5（借鉴 OpenViking 透明检索 + QMD --explain）
// ============================================================

/** 检索轨迹数据结构 */
interface RetrievalTrace {
  timestamp: string;
  query: string;
  pipeline: {
    keyword: { matched: string[] };
    tfidf: { matched: string[]; topScore: number };
    vector: { matched: string[]; topCosine: number; available: boolean };
  };
  rrf: Array<{ category: string; score: number }>;
  injected: Array<{
    category: string;
    itemCount: number;
    topItem: string;
    topScore: number;
  }>;
  budget: { used: number; limit: number };
}

/** 将检索轨迹写入 JSONL（fire-and-forget） */
function writeTrace(trace: RetrievalTrace, cwd: string): void {
  try {
    const dir = path.join(cwd, "0-System/trajectories");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const date = new Date().toISOString().slice(0, 10);
    const filePath = path.join(dir, `recall-${date}.jsonl`);
    writeFileSync(filePath, JSON.stringify(trace) + "\n", { flag: "a" });
  } catch {
    // 静默失败，不影响注入
  }
}

/**
 * TF-IDF 模糊匹配（带分数版本，供 RRF 排名用）
 */
function fuzzyMatchCategoriesWithScores(
  prompt: string,
  content: string,
  alreadyMatched: Set<string>,
): Array<{ cat: string; similarity: number }> {
  const promptTokens = tokenize(prompt);
  if (promptTokens.length === 0) return [];
  const promptTf = buildTfVector(promptTokens);

  const sections = content.split(/^## /m).filter(Boolean);
  const candidates: Array<{ cat: string; similarity: number }> = [];

  for (const section of sections) {
    const headerMatch = section.match(/^\[([^\]]+)\]/);
    if (!headerMatch) continue;
    const cat = headerMatch[1];
    if (cat.startsWith("user/") || alreadyMatched.has(cat)) continue;

    const sectionTokens = tokenize(section);
    const sectionTf = buildTfVector(sectionTokens);
    const sim = cosineSimilarity(promptTf, sectionTf);
    if (sim > 0.05) {
      candidates.push({ cat, similarity: sim });
    }
  }

  candidates.sort((a, b) => b.similarity - a.similarity);
  return candidates.slice(0, 2);
}

/**
 * v4.5: 混合类别匹配 — RRF 融合三路检索结果 + 检索轨迹。
 *
 * v4 → v4.5 变化：
 * - 三路检索各自产出排名列表 → RRF 统一评分（替代简单 union）
 * - 返回检索轨迹数据用于可观测性
 */
async function hybridMatchCategories(
  prompt: string,
  memContent: string,
  cwd: string,
): Promise<{ categories: string[]; trace: RetrievalTrace }> {
  const trace: RetrievalTrace = {
    timestamp: new Date().toISOString(),
    query: prompt.substring(0, 100),
    pipeline: {
      keyword: { matched: [] },
      tfidf: { matched: [], topScore: 0 },
      vector: { matched: [], topCosine: 0, available: false },
    },
    rrf: [],
    injected: [],
    budget: { used: 0, limit: 3000 },
  };

  // 第一步：关键词正则匹配 → 排名列表
  const keywordRanked: Array<{ category: string; rank: number }> = [];
  let keywordRank = 0;
  for (const { keywords, categories } of KEYWORD_CATEGORY_MAP) {
    if (keywords.test(prompt)) {
      for (const cat of categories) {
        if (!keywordRanked.some((r) => r.category === cat)) {
          keywordRanked.push({ category: cat, rank: keywordRank++ });
        }
      }
    }
  }
  trace.pipeline.keyword.matched = keywordRanked.map((r) => r.category);

  // 第二步：TF-IDF 模糊匹配 → 排名列表
  const regexMatched = new Set(keywordRanked.map((r) => r.category));
  const tfidfResults = fuzzyMatchCategoriesWithScores(prompt, memContent, regexMatched);
  const tfidfRanked = tfidfResults.map((r, i) => ({ category: r.cat, rank: i }));
  trace.pipeline.tfidf.matched = tfidfRanked.map((r) => r.category);
  trace.pipeline.tfidf.topScore = tfidfResults.length > 0 ? tfidfResults[0].similarity : 0;

  // 第三步：向量语义匹配 → 排名列表
  const afterKeywordAndTfidf = new Set([...regexMatched, ...tfidfRanked.map((r) => r.category)]);
  const vectorResults = await vectorMatchCategories(prompt, cwd, afterKeywordAndTfidf);
  const vectorRanked = vectorResults.map((r, i) => ({ category: r.cat, rank: i }));
  trace.pipeline.vector.available = vectorResults.length > 0 || (getVectorIndex(cwd) !== null);
  trace.pipeline.vector.matched = vectorRanked.map((r) => r.category);
  trace.pipeline.vector.topCosine = vectorResults.length > 0 ? vectorResults[0].score : 0;

  // RRF 融合
  const rankedLists = [keywordRanked, tfidfRanked, vectorRanked].filter((l) => l.length > 0);
  if (rankedLists.length === 0) {
    return { categories: [], trace };
  }
  const fused = rrfFuse(rankedLists);
  trace.rrf = fused.slice(0, 10);

  // 取 RRF 最高的类别（上限 8 个，避免过度注入）
  const categories = fused.slice(0, 8).map((r) => r.category);
  return { categories, trace };
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

  // v5.5: 优先同步 SQLite（mtime 变更检测，无变更时零开销）
  syncDB(cwd);

  const memPath = path.join(cwd, "0-System/memory-items.md");
  if (existsSync(memPath)) {
    try {
      const memContent = readFileSync(memPath, "utf-8");

      // v5.5 L0: 优先从 SQLite 生成概览（更快），降级到文件解析
      const l0Overview = generateL0OverviewFromDB(cwd) || generateL0Overview(memContent);
      if (l0Overview) {
        parts.push(`### 记忆索引（L0 概览）\n${l0Overview}`);
      }

      // 始终注入 user + agent 类别（L2 完整内容，无需 rerank）
      const userBlock = await extractCategories(memContent, ALWAYS_INJECT_CATEGORIES);

      // v4.5: 混合类别匹配（RRF 融合 + 检索轨迹）
      const { categories: allProjectCats, trace } = await hybridMatchCategories(prompt, memContent, cwd);

      // v5.5: project 类别注入时启用 LLM rerank
      const projectBlock = allProjectCats.length > 0
        ? await extractCategories(memContent, allProjectCats, prompt)
        : "";
      if (userBlock) parts.push(userBlock);
      if (projectBlock) parts.push(projectBlock);

      // v5.5: 写检索轨迹到 SQLite（降级到 JSONL）
      trace.budget.used = parts.join("\n\n").length;
      trace.budget.limit = 2000;
      saveTraceDB(cwd, {
        timestamp: trace.timestamp,
        query: trace.query,
        pipeline: trace.pipeline,
        rrf: trace.rrf,
        injected: trace.injected,
        budget_used: trace.budget.used,
        budget_limit: trace.budget.limit,
      });
      writeTrace(trace, cwd); // 同时保留 JSONL（过渡期双写）
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

  // v5.5: 同步 SQLite
  syncDB(cwd);

  // 1. RECENT_EVENTS
  const recentEvents = loadRecentEvents(cwd);
  if (recentEvents) {
    parts.push(`### 最近事件\n${recentEvents}`);
  }

  // 2. memory-items（v5.5：SQLite + L0 概览 + RRF 融合 + rerank + 检索轨迹）
  const memPath = path.join(cwd, "0-System/memory-items.md");
  if (existsSync(memPath)) {
    try {
      const memContent = readFileSync(memPath, "utf-8");

      // v5.5 L0: 优先从 SQLite 生成概览
      const l0Overview = generateL0OverviewFromDB(cwd) || generateL0Overview(memContent);
      if (l0Overview) {
        parts.push(`### 记忆索引（L0 概览）\n${l0Overview}`);
      }

      // 始终注入 user + agent 类别（L2 完整内容，无需 rerank）
      const userBlock = await extractCategories(memContent, ALWAYS_INJECT_CATEGORIES);

      // v4.5: 混合类别匹配（RRF 融合 + 检索轨迹）
      const { categories: allProjectCats, trace } = await hybridMatchCategories(prompt, memContent, cwd);

      // v5.5: project 类别注入时启用 LLM rerank
      const projectBlock = allProjectCats.length > 0
        ? await extractCategories(memContent, allProjectCats, prompt)
        : "";

      if (userBlock) parts.push(userBlock);
      if (projectBlock) parts.push(projectBlock);

      // v5.5: 检索轨迹双写（SQLite + JSONL 过渡期）
      trace.budget.used = parts.join("\n\n").length;
      trace.budget.limit = 3000;
      saveTraceDB(cwd, {
        timestamp: trace.timestamp,
        query: trace.query,
        pipeline: trace.pipeline,
        rrf: trace.rrf,
        injected: trace.injected,
        budget_used: trace.budget.used,
        budget_limit: trace.budget.limit,
      });
      writeTrace(trace, cwd);
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
