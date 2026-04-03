/**
 * conversation.ts — 多轮对话上下文管理
 *
 * 内存中维护 Map<conversationId, Message[]>，自动截断旧消息。
 * 兼容 OpenAI 协议：客户端传 conversation_id 即可复用上下文。
 */

import type { OpenAIMessage } from "../adapters/openai-compat.js";

interface ConversationState {
  messages: OpenAIMessage[];
  lastAccess: number;
}

const MAX_MESSAGES = 20;
const MAX_CONVERSATIONS = 100;
const EXPIRE_MS = 30 * 60 * 1000; // 30 min

const store = new Map<string, ConversationState>();

function generateId(): string {
  return `conv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function cleanup(): void {
  if (store.size <= MAX_CONVERSATIONS) return;
  const now = Date.now();
  const expired: string[] = [];
  for (const [id, state] of store) {
    if (now - state.lastAccess > EXPIRE_MS) expired.push(id);
  }
  for (const id of expired) store.delete(id);
  // If still over limit, remove oldest
  if (store.size > MAX_CONVERSATIONS) {
    const sorted = [...store.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    for (let i = 0; i < sorted.length - MAX_CONVERSATIONS; i++) {
      store.delete(sorted[i][0]);
    }
  }
}

/**
 * Merge incoming messages with conversation history.
 * Returns { conversationId, mergedMessages }.
 *
 * If client sends full multi-turn messages, they are used as-is.
 * If client sends single user message + conversation_id, history is prepended.
 */
export function resolveConversation(
  conversationId: string | undefined,
  incoming: OpenAIMessage[],
): { conversationId: string; messages: OpenAIMessage[] } {
  cleanup();

  const id = conversationId ?? generateId();
  const state = store.get(id);

  // If client already sends multi-turn (>1 user message), trust their messages
  const userMsgCount = incoming.filter((m) => m.role === "user").length;
  if (userMsgCount > 1 || !state) {
    // Start fresh or client manages context themselves
    return { conversationId: id, messages: incoming };
  }

  // Single user message + existing conversation → prepend history
  const merged = [...state.messages, ...incoming];
  return { conversationId: id, messages: merged };
}

/**
 * Save assistant response back to conversation history.
 */
export function saveToConversation(
  conversationId: string,
  userMessage: OpenAIMessage,
  assistantContent: string,
): void {
  const state = store.get(conversationId) ?? { messages: [], lastAccess: Date.now() };
  state.messages.push(userMessage);
  state.messages.push({ role: "assistant", content: assistantContent });
  state.lastAccess = Date.now();

  // Truncate: keep system prompt (if any) + last N messages
  if (state.messages.length > MAX_MESSAGES) {
    const systemMsgs = state.messages.filter((m) => m.role === "system");
    const nonSystem = state.messages.filter((m) => m.role !== "system");
    state.messages = [...systemMsgs, ...nonSystem.slice(-MAX_MESSAGES)];
  }

  store.set(conversationId, state);
}

export function getConversationStats(): {
  active: number;
  totalMessages: number;
} {
  let totalMessages = 0;
  for (const state of store.values()) {
    totalMessages += state.messages.length;
  }
  return { active: store.size, totalMessages };
}

export function clearConversation(conversationId: string): boolean {
  return store.delete(conversationId);
}
