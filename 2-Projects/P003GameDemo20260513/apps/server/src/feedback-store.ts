import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const FEEDBACK_STATUSES = ['已收到', '评估中', '已采纳', '金点子库'] as const;

export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

export type FeedbackItem = {
  id: string;
  session_id: string;
  turn_id: number;
  source: string;
  ts: number;
  nickname: string;
  scene_id: string | null;
  text: string;
  status: FeedbackStatus;
  note: string;
  updated_at: number;
  updated_by: string;
  ip_hash: string;
};

export type FeedbackAddInput = {
  session_id: string;
  turn_id: number;
  source: string;
  nickname: string;
  scene_id: string | null;
  text: string;
  ip_hash: string;
};

type FeedbackRow = {
  id: string;
  session_id: string;
  turn_id: number;
  source: string;
  ts: number;
  nickname: string;
  scene_id: string | null;
  text: string;
  status: string;
  note: string;
  updated_at: number;
  updated_by: string;
  ip_hash: string;
};

type FeedbackUpdateInput = {
  status?: FeedbackStatus;
  note?: string;
  updatedBy?: string;
};

const DEFAULT_DB_PATH = './data/feedback.db';
const DEDUPE_WINDOW_MS = 30_000;

function resolveDbPath(): string {
  const rawPath = process.env.FEEDBACK_DB_PATH?.trim() || DEFAULT_DB_PATH;
  return resolve(process.cwd(), rawPath);
}

function toFeedbackItem(row: FeedbackRow | null | undefined): FeedbackItem | null {
  if (!row) return null;
  if (!isFeedbackStatus(row.status)) return null;
  return {
    id: row.id,
    session_id: row.session_id,
    turn_id: row.turn_id,
    source: row.source,
    ts: row.ts,
    nickname: row.nickname,
    scene_id: row.scene_id,
    text: row.text,
    status: row.status,
    note: row.note,
    updated_at: row.updated_at,
    updated_by: row.updated_by,
    ip_hash: row.ip_hash,
  };
}

function isFeedbackStatus(value: string): value is FeedbackStatus {
  return FEEDBACK_STATUSES.includes(value as FeedbackStatus);
}

class FeedbackStore {
  private readonly db: DatabaseSync;

  constructor() {
    const dbPath = resolveDbPath();
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS feedback_items (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn_id INTEGER NOT NULL,
        source TEXT NOT NULL,
        ts INTEGER NOT NULL,
        nickname TEXT NOT NULL,
        scene_id TEXT,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        note TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        updated_by TEXT NOT NULL,
        ip_hash TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_feedback_items_ts
      ON feedback_items (ts DESC);
      CREATE INDEX IF NOT EXISTS idx_feedback_items_session_text_ts
      ON feedback_items (session_id, text, ts DESC);
    `);
  }

  add(input: FeedbackAddInput): FeedbackItem {
    const sessionId = input.session_id.trim();
    const text = input.text.trim();
    const source = input.source.trim();
    const nickname = input.nickname.trim();
    const sceneId = typeof input.scene_id === 'string' && input.scene_id.trim() ? input.scene_id.trim() : null;
    const ipHash = input.ip_hash.trim();
    const now = Date.now();

    const existing = this.findDuplicate(sessionId, text, now - DEDUPE_WINDOW_MS);
    if (existing) {
      return existing;
    }

    const item: FeedbackItem = {
      id: randomUUID(),
      session_id: sessionId,
      turn_id: input.turn_id,
      source,
      ts: now,
      nickname,
      scene_id: sceneId,
      text,
      status: '已收到',
      note: '',
      updated_at: now,
      updated_by: 'system',
      ip_hash: ipHash,
    };

    this.db
      .prepare(`
        INSERT INTO feedback_items (
          id, session_id, turn_id, source, ts, nickname, scene_id,
          text, status, note, updated_at, updated_by, ip_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        item.id,
        item.session_id,
        item.turn_id,
        item.source,
        item.ts,
        item.nickname,
        item.scene_id,
        item.text,
        item.status,
        item.note,
        item.updated_at,
        item.updated_by,
        item.ip_hash,
      );

    return item;
  }

  list(): FeedbackItem[] {
    const rows = this.db
      .prepare(`
        SELECT
          id, session_id, turn_id, source, ts, nickname, scene_id,
          text, status, note, updated_at, updated_by, ip_hash
        FROM feedback_items
        ORDER BY ts DESC
      `)
      .all() as FeedbackRow[];

    return rows
      .map((row) => toFeedbackItem(row))
      .filter((item): item is FeedbackItem => item !== null);
  }

  updateStatus(id: string, input: FeedbackUpdateInput): FeedbackItem | null {
    const current = this.getById(id);
    if (!current) return null;

    const nextStatus = input.status ?? current.status;
    const nextNote = typeof input.note === 'string' ? input.note : current.note;
    const nextUpdatedBy = input.updatedBy?.trim() || current.updated_by;
    const nextUpdatedAt = Date.now();

    this.db
      .prepare(`
        UPDATE feedback_items
        SET status = ?, note = ?, updated_at = ?, updated_by = ?
        WHERE id = ?
      `)
      .run(nextStatus, nextNote, nextUpdatedAt, nextUpdatedBy, id);

    return this.getById(id);
  }

  private getById(id: string): FeedbackItem | null {
    const row = this.db
      .prepare(`
        SELECT
          id, session_id, turn_id, source, ts, nickname, scene_id,
          text, status, note, updated_at, updated_by, ip_hash
        FROM feedback_items
        WHERE id = ?
      `)
      .get(id) as FeedbackRow | undefined;

    return toFeedbackItem(row);
  }

  private findDuplicate(sessionId: string, text: string, minTs: number): FeedbackItem | null {
    const row = this.db
      .prepare(`
        SELECT
          id, session_id, turn_id, source, ts, nickname, scene_id,
          text, status, note, updated_at, updated_by, ip_hash
        FROM feedback_items
        WHERE session_id = ? AND text = ? AND ts >= ?
        ORDER BY ts DESC
        LIMIT 1
      `)
      .get(sessionId, text, minTs) as FeedbackRow | undefined;

    return toFeedbackItem(row);
  }
}

export const feedbackStore = new FeedbackStore();
