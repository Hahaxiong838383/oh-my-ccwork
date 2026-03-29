/**
 * 飞书通道跨 Session 记忆管理
 *
 * 三层设计：
 * 1. Session Summary — session 超时/清除时提取对话摘要，新 session 注入
 * 2. Shared Context — 复用 context-loader 注入 memory-items + RECENT_EVENTS
 * 3. Per-Chat Facts — 按 chatId 存储原子事实，新 session 注入 Top N
 *
 * v5.5 升级（借鉴 lossless-claw DAG 层次摘要）：
 * - DAG 对话摘要：层次化压缩，支持 expand 回溯到原始消息范围
 * - 存储格式从 { summary: string } 升级为 ConversationDAG
 * - 向后兼容：旧格式自动迁移为单节点 DAG
 *
 * 决策点（2026-03-11）：
 * - 摘要提取用 Claude SDK 内联（不额外调 Codex），保持轻量
 * - per-chat facts 存文件持久化，内存缓存加速读取
 * - 注入总量控制 ≤ 2000 chars（摘要 800 + 共享记忆 800 + per-chat 400）
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import * as path from "path";
import { loadSharedContextLight } from "./context-loader.js";
import {
  getDB,
  saveSummary as saveSummaryDB,
  getSummaries as getSummariesDB,
  saveDAGNodes,
  addFact as addFactDB,
  getFacts as getFactsDB,
} from "./memory-db.js";

// ============================================================
// DAG 对话摘要 v5.5（借鉴 lossless-claw 层次化压缩 + expand 回溯）
// ============================================================

/** DAG 节点：对话片段的层次化摘要 */
export interface DAGNode {
  id: string;
  level: number;              // 0=叶子（原始消息分组）, 1=中间, 2+=根
  sourceRange: [number, number];  // 消息序号范围 [start, end)
  summary: string;            // 摘要文本
  children: string[];         // 子节点 ID（叶子节点为空）
  tokenCount: number;         // 原始内容的估算 token 数
}

/** 一个 chatId 的完整对话 DAG */
export interface ConversationDAG {
  chatId: string;
  nodes: DAGNode[];
  rootId: string;             // 根节点 ID
  version: "dag-v1";          // 格式版本标记
}

/** 旧格式兼容（v4.x 的扁平摘要） */
interface LegacyPersistedData {
  chatId: string;
  summaries?: string[];
  facts?: string[];
  updatedAt?: string;
}

/** 估算中文+英文混合文本的 token 数（粗略：1 中文字 ≈ 1.5 token，1 英文词 ≈ 1 token） */
function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length;
  const rest = text.length - cjk;
  return Math.ceil(cjk * 1.5 + rest * 0.25);
}

/** 生成短 ID（8 字符 hex） */
function shortId(): string {
  return Math.random().toString(16).slice(2, 10);
}

// ============================================================
// 会话过滤 v4.5（借鉴 lossless-claw ignoreSessionPatterns）
// ============================================================

/**
 * 不需要持久化对话记忆的 session 模式。
 * * 匹配非冒号字符，** 匹配任意字符（含冒号）。
 */
const IGNORE_SESSION_PATTERNS = [
  "scheduler:*",          // 定时任务产出
  "group:*:broadcast",    // 群广播
  "cron:**",              // 定时消息
];

/** glob 风格匹配（*=非冒号, **=任意） */
function sessionPatternMatch(sessionId: string, pattern: string): boolean {
  const regexStr = pattern
    .replace(/\*\*/g, "{{DOUBLESTAR}}")
    .replace(/\*/g, "[^:]*")
    .replace(/\{\{DOUBLESTAR\}\}/g, ".*");
  return new RegExp(`^${regexStr}$`).test(sessionId);
}

/** 检查 session 是否应该被持久化 */
function shouldPersistSession(sessionId: string): boolean {
  return !IGNORE_SESSION_PATTERNS.some((pattern) =>
    sessionPatternMatch(sessionId, pattern),
  );
}

// ============================================================
// 第1层：Session Summary（内存 + 文件持久化）
// ============================================================

/** 每个 chatId 最多保留的历史摘要数 */
const MAX_SUMMARIES = 3;

/** 单条摘要最大字符数 */
const MAX_SUMMARY_CHARS = 300;

/** chatId → 历史摘要列表（最新在后） */
const sessionSummaries = new Map<string, string[]>();

/** 对话轮次缓冲：session 存活期间累积的对话（用于 session 结束时生成摘要） */
const conversationBuffer = new Map<string, Array<{ role: "user" | "assistant"; content: string }>>();

/**
 * 记录一轮对话到缓冲区（每次 processFeishuMessage 完成后调用）
 */
export function recordConversationTurn(
  chatId: string,
  userMsg: string,
  assistantReply: string,
): void {
  // v4.5: 会话过滤 — 跳过低价值 session
  if (!shouldPersistSession(chatId)) return;

  if (!conversationBuffer.has(chatId)) {
    conversationBuffer.set(chatId, []);
  }
  const buffer = conversationBuffer.get(chatId)!;
  buffer.push(
    { role: "user", content: userMsg.substring(0, 500) },
    { role: "assistant", content: assistantReply.substring(0, 500) },
  );
  // 最多保留最近 20 轮（40 条）
  if (buffer.length > 40) {
    buffer.splice(0, buffer.length - 40);
  }
}

/**
 * v5.5: 从消息列表构建 DAG 层次摘要。
 *
 * 流程：
 * 1. 按 CHUNK_SIZE 分组消息 → 生成叶子节点（L0）
 * 2. 叶子数 ≥ 2 → 合并生成中间节点（L1）
 * 3. 递归直到只有一个根节点
 *
 * 摘要提取不调 LLM，纯本地规则（保持轻量）。
 */
function buildDAG(
  chatId: string,
  messages: Array<{ role: "user" | "assistant"; content: string }>,
): ConversationDAG {
  const CHUNK_SIZE = 8; // 每 8 条消息（4 轮）为一个叶子
  const nodes: DAGNode[] = [];

  // Step 1: 叶子节点 — 每 CHUNK_SIZE 条消息生成一个摘要
  const leafIds: string[] = [];
  for (let i = 0; i < messages.length; i += CHUNK_SIZE) {
    const chunk = messages.slice(i, i + CHUNK_SIZE);
    const nodeId = `leaf-${shortId()}`;

    const userMsgs = chunk
      .filter((m) => m.role === "user")
      .map((m) => m.content.substring(0, 60));
    const lastReply = chunk
      .filter((m) => m.role === "assistant")
      .pop()?.content.substring(0, 100) || "";

    const summary = `话题: ${userMsgs.join(" / ")}` +
      (lastReply ? ` → ${lastReply.substring(0, 80)}` : "");

    const rawText = chunk.map((m) => m.content).join(" ");

    nodes.push({
      id: nodeId,
      level: 0,
      sourceRange: [i, Math.min(i + CHUNK_SIZE, messages.length)],
      summary: summary.substring(0, MAX_SUMMARY_CHARS),
      children: [],
      tokenCount: estimateTokens(rawText),
    });
    leafIds.push(nodeId);
  }

  // Step 2+: 递归合并，直到只剩一个根
  let currentLevel = 0;
  let currentIds = leafIds;

  while (currentIds.length > 1) {
    currentLevel++;
    const MERGE_SIZE = 3; // 每 3 个子节点合并为一个父节点
    const parentIds: string[] = [];

    for (let i = 0; i < currentIds.length; i += MERGE_SIZE) {
      const childIds = currentIds.slice(i, i + MERGE_SIZE);
      const childNodes = childIds.map((id) => nodes.find((n) => n.id === id)!);

      const parentId = `mid-${shortId()}`;
      const parentSummary = childNodes.map((c) => c.summary.substring(0, 60)).join(" | ");
      const sourceStart = Math.min(...childNodes.map((c) => c.sourceRange[0]));
      const sourceEnd = Math.max(...childNodes.map((c) => c.sourceRange[1]));
      const totalTokens = childNodes.reduce((s, c) => s + c.tokenCount, 0);

      nodes.push({
        id: parentId,
        level: currentLevel,
        sourceRange: [sourceStart, sourceEnd],
        summary: parentSummary.substring(0, MAX_SUMMARY_CHARS * 2),
        children: childIds,
        tokenCount: totalTokens,
      });
      parentIds.push(parentId);
    }

    currentIds = parentIds;
  }

  const rootId = currentIds[0] || leafIds[0];

  return { chatId, nodes, rootId, version: "dag-v1" };
}

/**
 * v5.5: expand — 从 DAG 回溯到子节点摘要。
 *
 * Agent 可调用此接口从根 → 中间 → 叶子逐层展开，
 * 定位到原始消息范围。
 */
export function expandDAGNode(
  dag: ConversationDAG,
  nodeId: string,
): { node: DAGNode; children: DAGNode[] } | null {
  const node = dag.nodes.find((n) => n.id === nodeId);
  if (!node) return null;

  const children = node.children
    .map((cid) => dag.nodes.find((n) => n.id === cid))
    .filter((n): n is DAGNode => n !== undefined);

  return { node, children };
}

/**
 * Session 结束时调用：从对话缓冲生成 DAG 摘要并存储。
 *
 * v5.5 升级：扁平摘要 → DAG 层次化压缩。
 * 仍保留兼容的 summaries 字段（供注入层使用）。
 * 不调 LLM，纯本地提取，保持轻量。
 */
export function onSessionEnd(chatId: string, cwd: string): void {
  // v4.5: 会话过滤 — 跳过低价值 session
  if (!shouldPersistSession(chatId)) {
    conversationBuffer.delete(chatId);
    return;
  }

  const buffer = conversationBuffer.get(chatId);
  if (!buffer || buffer.length < 2) {
    conversationBuffer.delete(chatId);
    return;
  }

  // v5.5: 构建 DAG
  const dag = buildDAG(chatId, buffer);

  // 兼容旧注入逻辑：从 DAG 根节点提取扁平摘要
  const rootNode = dag.nodes.find((n) => n.id === dag.rootId);
  const flatSummary = rootNode
    ? `[${new Date().toLocaleString("zh-CN", { hour12: false })}] ${rootNode.summary}`
    : "";

  // 存入内存（扁平摘要用于注入，DAG 用于 expand 回溯）
  if (!sessionSummaries.has(chatId)) {
    sessionSummaries.set(chatId, []);
  }
  const summaries = sessionSummaries.get(chatId)!;
  summaries.push(flatSummary.substring(0, MAX_SUMMARY_CHARS));
  if (summaries.length > MAX_SUMMARIES) {
    summaries.splice(0, summaries.length - MAX_SUMMARIES);
  }

  // 持久化（含 DAG）
  persistWithDAG(chatId, dag, cwd);

  // 清空缓冲
  conversationBuffer.delete(chatId);

  const leafCount = dag.nodes.filter((n) => n.level === 0).length;
  const depth = dag.nodes.reduce((max, n) => Math.max(max, n.level), 0);
  console.log(`[ChatMemory] session 结束，DAG 生成完毕 (chatId=${chatId.substring(0, 12)}, 叶子=${leafCount}, 深度=${depth})`);
}

/** 摘要持久化目录 */
function getSummaryDir(cwd: string): string {
  return path.join(cwd, "0-System/chat-memory");
}

/** 持久化摘要到文件（不含 DAG，供 addChatFact 等轻量写入调用） */
function persistSummaries(chatId: string, cwd: string): void {
  try {
    const dir = getSummaryDir(cwd);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const safeId = chatId.replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 20);
    const filePath = path.join(dir, `${safeId}.json`);

    // 读取已有文件保留 DAG
    let existingDAG: ConversationDAG | undefined;
    if (existsSync(filePath)) {
      try {
        const existing = JSON.parse(readFileSync(filePath, "utf-8"));
        if (existing.dag?.version === "dag-v1") {
          existingDAG = existing.dag;
        }
      } catch { /* ignore */ }
    }

    const data: Record<string, unknown> = {
      chatId,
      summaries: sessionSummaries.get(chatId) || [],
      facts: perChatFacts.get(chatId) || [],
      updatedAt: new Date().toISOString(),
    };
    if (existingDAG) {
      data.dag = existingDAG;
    }

    writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    console.warn("[ChatMemory] 持久化失败:", err);
  }
}

/** v5.5: 持久化含 DAG 的完整数据（SQLite 优先 + JSON 备份） */
function persistWithDAG(chatId: string, dag: ConversationDAG, cwd: string): void {
  // v5.5: 写入 SQLite
  const db = getDB(cwd);
  if (db) {
    try {
      // 保存 DAG 节点
      saveDAGNodes(cwd, chatId, dag.nodes.map((n) => ({
        id: n.id,
        level: n.level,
        sourceStart: n.sourceRange[0],
        sourceEnd: n.sourceRange[1],
        summary: n.summary,
        tokenCount: n.tokenCount,
        isRoot: n.id === dag.rootId,
        children: n.children,
      })));

      // 保存摘要
      const summaries = sessionSummaries.get(chatId) || [];
      if (summaries.length > 0) {
        saveSummaryDB(cwd, chatId, summaries[summaries.length - 1]);
      }
    } catch (err) {
      console.warn("[ChatMemory] SQLite DAG 写入失败，降级到文件:", err);
    }
  }

  // JSON 文件备份（过渡期双写）
  try {
    const dir = getSummaryDir(cwd);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const safeId = chatId.replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 20);
    const filePath = path.join(dir, `${safeId}.json`);

    const data = {
      chatId,
      summaries: sessionSummaries.get(chatId) || [],
      facts: perChatFacts.get(chatId) || [],
      dag,
      updatedAt: new Date().toISOString(),
    };

    writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    console.warn("[ChatMemory] JSON 持久化失败:", err);
  }
}

/** DAG 内存缓存 */
const dagCache = new Map<string, ConversationDAG>();

/** 加载记忆：SQLite 优先，降级到 JSON 文件 */
function loadFromFile(chatId: string, cwd: string): void {
  if (sessionSummaries.has(chatId) || perChatFacts.has(chatId)) return; // 已加载

  // v5.5: 优先从 SQLite 加载
  const db = getDB(cwd);
  if (db) {
    try {
      const summaries = getSummariesDB(cwd, chatId);
      const facts = getFactsDB(cwd, chatId);

      if (summaries.length > 0 || facts.length > 0) {
        sessionSummaries.set(chatId, summaries);
        perChatFacts.set(chatId, facts);
        console.log(`[ChatMemory] 从 SQLite 加载记忆 (chatId=${chatId.substring(0, 12)}, summaries=${summaries.length}, facts=${facts.length})`);
        return;
      }
    } catch {
      // 降级到文件
    }
  }

  // 降级：从 JSON 文件加载
  try {
    const safeId = chatId.replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 20);
    const filePath = path.join(getSummaryDir(cwd), `${safeId}.json`);
    if (!existsSync(filePath)) return;

    const data = JSON.parse(readFileSync(filePath, "utf-8"));

    if (data.summaries) sessionSummaries.set(chatId, data.summaries);
    if (data.facts) perChatFacts.set(chatId, data.facts);

    if (data.dag?.version === "dag-v1") {
      dagCache.set(chatId, data.dag as ConversationDAG);
    }

    console.log(`[ChatMemory] 从文件加载记忆 (chatId=${chatId.substring(0, 12)}, summaries=${data.summaries?.length || 0}, facts=${data.facts?.length || 0})`);
  } catch {
    // 静默失败
  }
}

/**
 * v5.5: 获取指定 chatId 的 DAG（供外部 expand 调用）。
 * 如果没有 DAG 返回 null。
 */
export function getDAG(chatId: string, cwd: string): ConversationDAG | null {
  loadFromFile(chatId, cwd);
  return dagCache.get(chatId) || null;
}

// ============================================================
// 第3层：Per-Chat Facts（按 chatId 存储的原子事实）
// ============================================================

/** 每个 chatId 最多保留的事实数 */
const MAX_FACTS_PER_CHAT = 15;

/** chatId → 原子事实列表 */
const perChatFacts = new Map<string, string[]>();

/**
 * 简易分词（中英文混合，用于 Jaccard 去重）
 */
function tokenizeForDedup(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[，。！？、；：""''（）【】《》\-\[\]\(\)\/\\|@#\$%\^&\*=\+`~]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 2),
  );
}

/**
 * Jaccard 相似度（0~1）
 */
function jaccardSim(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  Array.from(a).forEach((t) => {
    if (b.has(t)) intersection++;
  });
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * 添加 per-chat 事实（由 auto-capture 回调或手动添加）
 * v2：Jaccard 去重（阈值 0.5），替代简单 string.includes
 */
export function addChatFact(chatId: string, fact: string, cwd: string): void {
  if (!perChatFacts.has(chatId)) {
    perChatFacts.set(chatId, []);
  }
  const facts = perChatFacts.get(chatId)!;

  // Jaccard 去重：与已有事实相似度 > 0.5 则视为重复
  const newTokens = tokenizeForDedup(fact);
  const isDuplicate = facts.some((f) => jaccardSim(newTokens, tokenizeForDedup(f)) > 0.5);
  if (isDuplicate) return;

  facts.push(fact.trim());
  if (facts.length > MAX_FACTS_PER_CHAT) {
    facts.splice(0, facts.length - MAX_FACTS_PER_CHAT);
  }

  // v5.5: SQLite + 文件双写
  addFactDB(cwd, chatId, fact.trim());
  persistSummaries(chatId, cwd);
}

/**
 * 提取对话中的事实并存储（轻量级本地提取，不调 LLM）
 *
 * 提取规则：
 * - 用户明确提到的偏好/要求
 * - 助手确认的关键结论/决定
 * - 项目/配置相关的具体信息
 */
export function extractAndStoreFacts(
  chatId: string,
  userMsg: string,
  assistantReply: string,
  cwd: string,
): void {
  // 太短的对话不提取
  if (userMsg.length + assistantReply.length < 100) return;

  // 提取用户偏好类（"我想要..."、"以后都..."、"记住..."）
  const preferencePatterns = [
    /(?:记住|以后都|我(?:想要|需要|喜欢|偏好|习惯)|请(?:始终|总是|一直))[：:，,]?\s*(.{10,80})/g,
    /(?:不要|别|禁止|不许)[：:，,]?\s*(.{10,60})/g,
  ];

  for (const pattern of preferencePatterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(userMsg)) !== null) {
      addChatFact(chatId, `用户偏好: ${match[0].substring(0, 100)}`, cwd);
    }
  }

  // 提取助手确认的关键决定（"已完成..."、"方案是..."、"结论："）
  const conclusionPatterns = [
    /(?:已完成|方案[是为]|结论[：:]|决定[：:]|最终选择)\s*(.{10,100})/g,
  ];

  for (const pattern of conclusionPatterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(assistantReply)) !== null) {
      addChatFact(chatId, `决定: ${match[0].substring(0, 120)}`, cwd);
    }
  }
}

// ============================================================
// 组合注入：构建跨 session 上下文前缀
// ============================================================

/** 各层注入预算 */
const BUDGET = {
  summaries: 800,
  sharedContext: 800,
  perChatFacts: 400,
};

/**
 * 构建飞书通道的跨 session 上下文。
 * 在每次新消息处理前调用，注入到 prompt 前缀。
 *
 * @param chatId   飞书 chat_id
 * @param message  用户当前消息（用于 context-loader 关键词匹配）
 * @param cwd      mycc 根目录
 * @param isNewSession  是否是新 session（超时/首次）
 * @returns 格式化的上下文前缀（可能为空）
 */
export async function buildCrossSessionContext(
  chatId: string,
  message: string,
  cwd: string,
  isNewSession: boolean,
): Promise<string> {
  // 确保从文件加载
  loadFromFile(chatId, cwd);

  const parts: string[] = [];

  // 第1层：Session Summary（仅新 session 时注入）
  if (isNewSession) {
    const summaries = sessionSummaries.get(chatId);
    if (summaries && summaries.length > 0) {
      let summaryBlock = summaries.join("\n");
      if (summaryBlock.length > BUDGET.summaries) {
        summaryBlock = summaryBlock.substring(summaryBlock.length - BUDGET.summaries);
      }
      parts.push(`### 之前的对话摘要\n${summaryBlock}`);
    }
  }

  // 第2层：共享记忆（轻量版，不含 RECENT_EVENTS，避免历史事件被当成当前任务）
  const sharedCtx = await loadSharedContextLight(message, cwd);
  if (sharedCtx) {
    const trimmed = sharedCtx.length > BUDGET.sharedContext
      ? sharedCtx.substring(0, BUDGET.sharedContext) + "\n...(截断)"
      : sharedCtx;
    parts.push(trimmed);
  }

  // 第3层：Per-Chat Facts（始终注入，帮助保持个性化）
  const facts = perChatFacts.get(chatId);
  if (facts && facts.length > 0) {
    let factsBlock = facts.map(f => `- ${f}`).join("\n");
    if (factsBlock.length > BUDGET.perChatFacts) {
      // 保留最新的
      const recent = facts.slice(-5);
      factsBlock = recent.map(f => `- ${f}`).join("\n");
    }
    parts.push(`### 关于此对话的记忆\n${factsBlock}`);
  }

  if (parts.length === 0) return "";

  return `[跨会话记忆 — 以下帮助你了解之前的对话上下文]\n\n${parts.join("\n\n")}\n\n[跨会话记忆结束]\n\n`;
}

/**
 * 清除指定 chatId 的所有记忆（/clear 时调用）
 */
export function clearChatMemory(chatId: string): void {
  sessionSummaries.delete(chatId);
  conversationBuffer.delete(chatId);
  perChatFacts.delete(chatId);
  console.log(`[ChatMemory] 已清除 chatId=${chatId.substring(0, 12)} 的所有记忆`);
}
