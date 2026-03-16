/**
 * 飞书通道跨 Session 记忆管理
 *
 * 三层设计：
 * 1. Session Summary — session 超时/清除时提取对话摘要，新 session 注入
 * 2. Shared Context — 复用 context-loader 注入 memory-items + RECENT_EVENTS
 * 3. Per-Chat Facts — 按 chatId 存储原子事实，新 session 注入 Top N
 *
 * 决策点（2026-03-11）：
 * - 摘要提取用 Claude SDK 内联（不额外调 Codex），保持轻量
 * - per-chat facts 存文件持久化，内存缓存加速读取
 * - 注入总量控制 ≤ 2000 chars（摘要 800 + 共享记忆 800 + per-chat 400）
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import * as path from "path";
import { loadSharedContextLight } from "./context-loader.js";

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
 * Session 结束时调用：从对话缓冲生成摘要并存储
 *
 * 采用轻量级本地摘要（不调 LLM），直接提取关键信息。
 * 决策原因：调 LLM 会增加延迟和成本，本地提取够用。
 */
export function onSessionEnd(chatId: string, cwd: string): void {
  const buffer = conversationBuffer.get(chatId);
  if (!buffer || buffer.length < 2) {
    conversationBuffer.delete(chatId);
    return;
  }

  // 本地摘要：提取用户问题列表 + 关键结论
  const userQuestions = buffer
    .filter(m => m.role === "user")
    .map(m => m.content.substring(0, 80))
    .slice(-5); // 最多 5 个问题

  const lastAssistantReply = buffer
    .filter(m => m.role === "assistant")
    .pop()?.content.substring(0, 200) || "";

  const summary = `[${new Date().toLocaleString("zh-CN", { hour12: false })}] ` +
    `话题: ${userQuestions.join(" / ")}` +
    (lastAssistantReply ? ` | 结论: ${lastAssistantReply.substring(0, 100)}` : "");

  const truncatedSummary = summary.substring(0, MAX_SUMMARY_CHARS);

  // 存入内存
  if (!sessionSummaries.has(chatId)) {
    sessionSummaries.set(chatId, []);
  }
  const summaries = sessionSummaries.get(chatId)!;
  summaries.push(truncatedSummary);
  if (summaries.length > MAX_SUMMARIES) {
    summaries.splice(0, summaries.length - MAX_SUMMARIES);
  }

  // 持久化到文件
  persistSummaries(chatId, cwd);

  // 清空缓冲
  conversationBuffer.delete(chatId);

  console.log(`[ChatMemory] session 结束，已生成摘要 (chatId=${chatId.substring(0, 12)})`);
}

/** 摘要持久化目录 */
function getSummaryDir(cwd: string): string {
  return path.join(cwd, "0-System/chat-memory");
}

/** 持久化摘要到文件 */
function persistSummaries(chatId: string, cwd: string): void {
  try {
    const dir = getSummaryDir(cwd);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    // chatId 做文件名（取前 20 字符避免过长）
    const safeId = chatId.replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 20);
    const filePath = path.join(dir, `${safeId}.json`);

    const data = {
      chatId,
      summaries: sessionSummaries.get(chatId) || [],
      facts: perChatFacts.get(chatId) || [],
      updatedAt: new Date().toISOString(),
    };

    writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    console.warn("[ChatMemory] 持久化失败:", err);
  }
}

/** 从文件加载摘要（启动时或首次访问时） */
function loadFromFile(chatId: string, cwd: string): void {
  if (sessionSummaries.has(chatId) || perChatFacts.has(chatId)) return; // 已加载

  try {
    const safeId = chatId.replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 20);
    const filePath = path.join(getSummaryDir(cwd), `${safeId}.json`);
    if (!existsSync(filePath)) return;

    const data = JSON.parse(readFileSync(filePath, "utf-8"));
    if (data.summaries) sessionSummaries.set(chatId, data.summaries);
    if (data.facts) perChatFacts.set(chatId, data.facts);

    console.log(`[ChatMemory] 从文件加载记忆 (chatId=${chatId.substring(0, 12)}, summaries=${data.summaries?.length || 0}, facts=${data.facts?.length || 0})`);
  } catch {
    // 静默失败
  }
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
export function buildCrossSessionContext(
  chatId: string,
  message: string,
  cwd: string,
  isNewSession: boolean,
): string {
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
  const sharedCtx = loadSharedContextLight(message, cwd);
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
