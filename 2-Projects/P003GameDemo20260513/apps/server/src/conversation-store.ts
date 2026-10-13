import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type ConversationRole = 'user' | 'assistant';

export type ConversationItem = {
  id: string;
  account_id: string | null;
  session_id: string;
  role: ConversationRole;
  text: string;
  ts: number;
  tokens: number;
};

export type ConversationAddInput = {
  account_id: string | null;
  session_id: string;
  role: ConversationRole;
  text: string;
  tokens?: number;
};

export type ConversationListOptions = {
  accountId?: string | null;
  sessionId?: string | null;
  limit?: number | null;
};

type ConversationRow = {
  id: string;
  account_id: string | null;
  session_id: string;
  role: string;
  text: string;
  ts: number;
  tokens: number;
};

const DEFAULT_DB_PATH = './data/conversation.db';
const CONVERSATION_COLUMNS = ['id', 'account_id', 'session_id', 'role', 'text', 'ts', 'tokens'] as const;
const SELECT_COLS = CONVERSATION_COLUMNS.join(', ');
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1_000;

function resolveDbPath(): string {
  const raw = process.env.CONVERSATION_DB_PATH?.trim() || DEFAULT_DB_PATH;
  return resolve(process.cwd(), raw);
}

function toConversationItem(row: ConversationRow | null | undefined): ConversationItem | null {
  if (!row) return null;
  if (row.role !== 'user' && row.role !== 'assistant') return null;
  return {
    id: row.id,
    account_id: row.account_id,
    session_id: row.session_id,
    role: row.role,
    text: row.text,
    ts: row.ts,
    tokens: Number(row.tokens) || 0,
  };
}

function normalizeLimit(limit: number | null | undefined): number {
  if (!Number.isFinite(limit) || !limit) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
}

class ConversationStore {
  private readonly db: DatabaseSync;

  constructor() {
    const dbPath = resolveDbPath();
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation (
        id TEXT PRIMARY KEY,
        account_id TEXT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        text TEXT NOT NULL,
        ts INTEGER NOT NULL,
        tokens INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_conversation_account_ts
      ON conversation (account_id, ts DESC);
      CREATE INDEX IF NOT EXISTS idx_conversation_session_ts
      ON conversation (session_id, ts);
    `);
    const cols = this.db.prepare('PRAGMA table_info(conversation)').all() as Array<{ name: string }>;
    if (!cols.some((col) => col.name === 'tokens')) {
      this.db.exec('ALTER TABLE conversation ADD COLUMN tokens INTEGER NOT NULL DEFAULT 0');
    }
  }

  add(input: ConversationAddInput): ConversationItem {
    const sessionId = input.session_id.trim();
    const text = input.text.trim();
    const accountId = typeof input.account_id === 'string' && input.account_id.trim() ? input.account_id.trim() : null;
    const item: ConversationItem = {
      id: randomUUID(),
      account_id: accountId,
      session_id: sessionId,
      role: input.role,
      text,
      ts: Date.now(),
      tokens: input.tokens ?? 0,
    };

    this.db
      .prepare(`INSERT INTO conversation (${SELECT_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?) `)
      .run(item.id, item.account_id, item.session_id, item.role, item.text, item.ts, item.tokens);

    return item;
  }

  list(opts: ConversationListOptions = {}): ConversationItem[] {
    const accountId = typeof opts.accountId === 'string' && opts.accountId.trim() ? opts.accountId.trim() : null;
    const sessionId = typeof opts.sessionId === 'string' && opts.sessionId.trim() ? opts.sessionId.trim() : null;
    const limit = normalizeLimit(opts.limit);
    const where: string[] = [];
    const params: (string | number)[] = [];

    if (accountId) {
      where.push('account_id = ?');
      params.push(accountId);
    }
    if (sessionId) {
      where.push('session_id = ?');
      params.push(sessionId);
    }

    const whereSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT ${SELECT_COLS} FROM conversation${whereSql} ORDER BY ts DESC LIMIT ?`)
      .all(...params, limit) as ConversationRow[];

    return rows
      .map((row) => toConversationItem(row))
      .filter((item): item is ConversationItem => item !== null);
  }

  /**
   * R2 证据链：按原话反查最近一条同账号同角色消息的 id（worker 传来的历史无 id，抽取窗口里的旧消息靠它定位）。
   * 只看最近 limit 条；找不到返回 null（条目 source_msg_id 留空，不阻断）。
   */
  findRecentIdByText(accountId: string, role: ConversationRole, text: string, limit = 60): string | null {
    const t = text.trim();
    if (!accountId || !t) return null;
    const row = this.db
      .prepare(`SELECT id FROM conversation WHERE account_id = ? AND role = ? AND text = ? ORDER BY ts DESC LIMIT 1`)
      .get(accountId, role, t) as { id: string } | undefined;
    if (row) return row.id;
    void limit;
    return null;
  }

  statsByAccount(): Record<string, { count: number; tokens: number }> {
    const rows = this.db
      .prepare(
        `SELECT account_id, COUNT(*) AS count, COALESCE(SUM(tokens), 0) AS tokens FROM conversation WHERE account_id IS NOT NULL GROUP BY account_id`,
      )
      .all() as Array<{ account_id: string; count: number; tokens: number }>;
    const out: Record<string, { count: number; tokens: number }> = {};
    for (const r of rows) out[r.account_id] = { count: Number(r.count), tokens: Number(r.tokens) };
    return out;
  }
}

export const conversationStore = new ConversationStore();
