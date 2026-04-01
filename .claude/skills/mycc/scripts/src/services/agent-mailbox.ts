/**
 * agent-mailbox.ts — Agent 间结构化通信
 *
 * 借鉴 Claude Code 的 mailbox.ts 设计：
 * - 每个引擎（cc/codex/gemini）有独立收件箱
 * - 支持点对点消息和广播
 * - 内存队列（不需要文件信箱，因为三引擎都通过 http-server 中心化调度）
 *
 * 消息类型：
 * - task_result: 任务完成结果
 * - task_request: 任务分发请求
 * - status_update: 状态更新
 * - permission_request: 权限请求（codex/gemini 需要 cc 决策时）
 */

// ── Types ──────────────────────────────────────────────────────

export type AgentId = "cc" | "codex" | "gemini";

export type MessageType =
  | "task_result"
  | "task_request"
  | "status_update"
  | "permission_request";

export interface AgentMessage {
  readonly id: string;
  readonly from: AgentId;
  readonly to: AgentId | "broadcast";
  readonly type: MessageType;
  readonly payload: string;
  readonly timestamp: string;
  readonly read: boolean;
}

export interface MailboxStats {
  readonly agentId: AgentId;
  readonly unread: number;
  readonly total: number;
  readonly oldest?: string;
}

// ── Constants ──────────────────────────────────────────────────

const MAX_MESSAGES_PER_INBOX = 50;

// ── State (in-memory, lives with mycc backend process) ─────────

// 不可变消息数组，每次操作返回新数组
let inboxes: ReadonlyMap<AgentId, readonly AgentMessage[]> = new Map([
  ["cc", []],
  ["codex", []],
  ["gemini", []],
]);

let messageCounter = 0;

// ── ID Generator ───────────────────────────────────────────────

function generateId(): string {
  messageCounter += 1;
  return `msg-${Date.now()}-${messageCounter}`;
}

// ── Send ───────────────────────────────────────────────────────

/**
 * 发送消息到指定引擎的收件箱。
 * broadcast = 发给所有引擎（不含发送者自己）。
 */
export function sendMessage(
  from: AgentId,
  to: AgentId | "broadcast",
  type: MessageType,
  payload: string,
): AgentMessage {
  const message: AgentMessage = {
    id: generateId(),
    from,
    to,
    type,
    payload: payload.slice(0, 2000), // 防止超大消息
    timestamp: new Date().toISOString(),
    read: false,
  };

  if (to === "broadcast") {
    const agents: readonly AgentId[] = ["cc", "codex", "gemini"];
    const updated = new Map(inboxes);
    for (const agent of agents) {
      if (agent !== from) {
        const inbox = updated.get(agent) ?? [];
        updated.set(agent, [...inbox, message].slice(-MAX_MESSAGES_PER_INBOX));
      }
    }
    inboxes = updated;
  } else {
    const updated = new Map(inboxes);
    const inbox = updated.get(to) ?? [];
    updated.set(to, [...inbox, message].slice(-MAX_MESSAGES_PER_INBOX));
    inboxes = updated;
  }

  console.log(`[Mailbox] ${from} → ${to}: ${type} (${message.id})`);
  return message;
}

// ── Read ───────────────────────────────────────────────────────

/**
 * 读取指定引擎的收件箱（未读消息优先）。
 * 不会自动标记已读——调用 markRead() 显式标记。
 */
export function getInbox(agentId: AgentId): readonly AgentMessage[] {
  return inboxes.get(agentId) ?? [];
}

/**
 * 获取未读消息。
 */
export function getUnread(agentId: AgentId): readonly AgentMessage[] {
  const inbox = inboxes.get(agentId) ?? [];
  return inbox.filter(m => !m.read);
}

/**
 * 按类型筛选消息。
 */
export function getByType(
  agentId: AgentId,
  type: MessageType,
): readonly AgentMessage[] {
  const inbox = inboxes.get(agentId) ?? [];
  return inbox.filter(m => m.type === type);
}

// ── Mark Read ──────────────────────────────────────────────────

/**
 * 标记消息为已读（返回新的不可变消息列表）。
 */
export function markRead(agentId: AgentId, messageId: string): boolean {
  const inbox = inboxes.get(agentId) ?? [];
  const idx = inbox.findIndex(m => m.id === messageId);
  if (idx === -1) return false;

  const updated = new Map(inboxes);
  const newInbox = inbox.map((m, i) =>
    i === idx ? { ...m, read: true } : m,
  );
  updated.set(agentId, newInbox);
  inboxes = updated;
  return true;
}

/**
 * 标记所有消息为已读。
 */
export function markAllRead(agentId: AgentId): number {
  const inbox = inboxes.get(agentId) ?? [];
  const unreadCount = inbox.filter(m => !m.read).length;

  if (unreadCount === 0) return 0;

  const updated = new Map(inboxes);
  updated.set(agentId, inbox.map(m => ({ ...m, read: true })));
  inboxes = updated;
  return unreadCount;
}

// ── Stats ──────────────────────────────────────────────────────

/**
 * 获取所有收件箱的统计信息。
 */
export function getStats(): readonly MailboxStats[] {
  const agents: readonly AgentId[] = ["cc", "codex", "gemini"];
  return agents.map(agentId => {
    const inbox = inboxes.get(agentId) ?? [];
    const unread = inbox.filter(m => !m.read).length;
    const oldest = inbox.length > 0 ? inbox[0].timestamp : undefined;
    return { agentId, unread, total: inbox.length, oldest };
  });
}

// ── Cleanup ────────────────────────────────────────────────────

/**
 * 清除指定引擎的已读消息（保留未读）。
 */
export function purgeRead(agentId: AgentId): number {
  const inbox = inboxes.get(agentId) ?? [];
  const readCount = inbox.filter(m => m.read).length;

  const updated = new Map(inboxes);
  updated.set(agentId, inbox.filter(m => !m.read));
  inboxes = updated;
  return readCount;
}

/**
 * 完全清空所有收件箱（测试/重置用）。
 */
export function clearAll(): void {
  inboxes = new Map([
    ["cc", []],
    ["codex", []],
    ["gemini", []],
  ]);
  messageCounter = 0;
}

// ── Context Injection Helper ───────────────────────────────────

/**
 * 为指定引擎生成消息上下文注入文本。
 * 在 prompt 前注入，让引擎知道有待处理的消息。
 */
export function buildMailboxContext(agentId: AgentId): string {
  const unread = getUnread(agentId);
  if (unread.length === 0) return "";

  const lines = unread.map(m =>
    `- [${m.type}] from ${m.from} (${m.timestamp.slice(11, 16)}): ${m.payload.slice(0, 100)}`,
  );

  return `[Pending Messages for ${agentId}]\n${lines.join("\n")}\n`;
}
