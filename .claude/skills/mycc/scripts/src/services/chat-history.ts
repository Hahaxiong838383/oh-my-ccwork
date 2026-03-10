/**
 * 飞书私聊记录归档 + 记忆提取
 *
 * 两层设计：
 * 1. 原文归档 → 0-System/chat-history/p2p/YYYY-MM-DD.md
 * 2. 记忆提取 → 复用 auto-capture（Codex 提取原子事实到 memory-items.md）
 *
 * 全部 fire-and-forget，不阻塞主流程。
 */

import { appendFileSync, mkdirSync, existsSync } from "fs";
import * as path from "path";
import { triggerAutoCapture } from "./auto-capture.js";

/** 获取当日日期字符串 YYYY-MM-DD */
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 获取当前时间 HH:MM */
function nowTime(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * 保存私聊对话记录并触发记忆提取。
 *
 * @param chatId  飞书 chat_id（用于标识来源）
 * @param userMsg 用户原始消息
 * @param reply   cc 的回复
 * @param cwd     mycc 根目录
 */
export function saveChatAndExtractMemory(
  chatId: string,
  userMsg: string,
  reply: string,
  cwd: string,
): void {
  // ---- Layer 1: 原文归档 ----
  try {
    const dir = path.join(cwd, "0-System/chat-history/p2p");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const filePath = path.join(dir, `${today()}.md`);
    const header = existsSync(filePath) ? "" : `# 飞书私聊记录 ${today()}\n\n`;

    // 截断过长回复（归档原文保留更多，最多 4000 字符）
    const truncatedReply = reply.length > 4000
      ? reply.substring(0, 4000) + "\n...(截断)"
      : reply;

    const entry = `${header}### ${nowTime()} [${chatId.substring(0, 12)}...]\n\n**用户**: ${userMsg}\n\n**cc**: ${truncatedReply}\n\n---\n\n`;

    appendFileSync(filePath, entry, "utf-8");
    console.log(`[ChatHistory] 已归档到 ${filePath}`);
  } catch (err) {
    console.warn("[ChatHistory] 归档失败:", err);
  }

  // ---- Layer 2: 记忆提取（复用 auto-capture） ----
  // 用 chatId 作为 sessionId（auto-capture 只用它做冷却控制）
  triggerAutoCapture(chatId, userMsg, reply, cwd);
}
