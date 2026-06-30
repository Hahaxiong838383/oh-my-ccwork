/**
 * 产品开发看板 · store（SQLite）
 *
 * 表结构：
 *   - dev_items：开发条目主表
 *   - dev_item_feedbacks：dev_item 与 feedback 的多对多关联表
 *
 * 设计要点：
 *   - 复用 feedback-store 的 SQLite db（同 path，同进程内可多连接 / WAL 安全）
 *   - 不 import feedback-store（避免循环依赖；JOIN feedback_items 同一 db）
 *   - 列清单单一真相：建表 + SELECT + INSERT 共用，加字段只改一处
 *   - ALTER 幂等（PRAGMA table_info 查列）
 *   - 自动聚合（updateAggregation）：未 lock 的 quote / themes 跟着关联 feedback 重算
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  DEV_ITEM_LEVELS,
  DEV_ITEM_STATUSES,
  type DevItem,
  type DevItemCreateInput,
  type DevItemLevel,
  type DevItemPatchInput,
  type DevItemStatus,
  type FeedbackDevItemLink,
} from './dev-items-types.js';

const DEFAULT_DB_PATH = './data/feedback.db';

const DEV_ITEM_COLUMNS = [
  'id',
  'title',
  'description',
  'level',
  'status',
  'representative_quote',
  'quote_locked',
  'source_themes_json',
  'themes_locked',
  'created_at',
  'updated_at',
  'launched_at',
  'thanks_sent_at',
  'updated_by',
] as const;

const SELECT_COLS = DEV_ITEM_COLUMNS.join(', ');

type DevItemRow = {
  id: string;
  title: string;
  description: string;
  level: string;
  status: string;
  representative_quote: string;
  quote_locked: number;
  source_themes_json: string;
  themes_locked: number;
  created_at: number;
  updated_at: number;
  launched_at: number | null;
  thanks_sent_at: number | null;
  updated_by: string;
};

function resolveDbPath(): string {
  const rawPath = process.env.FEEDBACK_DB_PATH?.trim() || DEFAULT_DB_PATH;
  return resolve(process.cwd(), rawPath);
}

function isDevItemLevel(value: string): value is DevItemLevel {
  return (DEV_ITEM_LEVELS as readonly string[]).includes(value);
}

function isDevItemStatus(value: string): value is DevItemStatus {
  return (DEV_ITEM_STATUSES as readonly string[]).includes(value);
}

function normalizeLevel(value: string | null | undefined): DevItemLevel {
  const v = (value ?? '').trim();
  return isDevItemLevel(v) ? v : '小改';
}

function normalizeStatus(value: string | null | undefined): DevItemStatus {
  const v = (value ?? '').trim();
  return isDevItemStatus(v) ? v : '规划中';
}

function parseThemesJson(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is string => typeof x === 'string');
  } catch {
    return [];
  }
}

class DevItemStore {
  private readonly db: DatabaseSync;

  constructor() {
    const dbPath = resolveDbPath();
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dev_items (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        level TEXT NOT NULL DEFAULT '小改',
        status TEXT NOT NULL DEFAULT '规划中',
        representative_quote TEXT NOT NULL DEFAULT '',
        quote_locked INTEGER NOT NULL DEFAULT 0,
        source_themes_json TEXT NOT NULL DEFAULT '[]',
        themes_locked INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        launched_at INTEGER,
        thanks_sent_at INTEGER,
        updated_by TEXT NOT NULL DEFAULT 'admin'
      );
      CREATE INDEX IF NOT EXISTS idx_dev_items_status
      ON dev_items (status);

      CREATE TABLE IF NOT EXISTS dev_item_feedbacks (
        dev_item_id TEXT NOT NULL,
        feedback_id TEXT NOT NULL,
        PRIMARY KEY (dev_item_id, feedback_id)
      );
      CREATE INDEX IF NOT EXISTS idx_dev_item_feedbacks_feedback
      ON dev_item_feedbacks (feedback_id);
    `);
    // 幂等加列（防生产已建无新列的旧表）
    this.migrateAddColumn('description', "TEXT NOT NULL DEFAULT ''");
    this.migrateAddColumn('level', "TEXT NOT NULL DEFAULT '小改'");
    this.migrateAddColumn('status', "TEXT NOT NULL DEFAULT '规划中'");
    this.migrateAddColumn('representative_quote', "TEXT NOT NULL DEFAULT ''");
    this.migrateAddColumn('quote_locked', 'INTEGER NOT NULL DEFAULT 0');
    this.migrateAddColumn('source_themes_json', "TEXT NOT NULL DEFAULT '[]'");
    this.migrateAddColumn('themes_locked', 'INTEGER NOT NULL DEFAULT 0');
    this.migrateAddColumn('launched_at', 'INTEGER');
    this.migrateAddColumn('thanks_sent_at', 'INTEGER');
    this.migrateAddColumn('updated_by', "TEXT NOT NULL DEFAULT 'admin'");
  }

  private migrateAddColumn(col: string, def: string): void {
    const cols = this.db.prepare('PRAGMA table_info(dev_items)').all() as { name: string }[];
    if (cols.some((c) => c.name === col)) return;
    this.db.exec(`ALTER TABLE dev_items ADD COLUMN ${col} ${def}`);
  }

  /**
   * 父子展开：对传入的 feedback_ids，若其中任何一个是「父项」（有子），
   * 把其所有子项 id 也一并加入待关联列表（去重 + 保序）。
   *
   * 避循环依赖：直接 SQL 查 feedback_items（同库），不 import feedbackStore。
   * 容错：feedback_items 表不存在（极少见）→ 直接返回原列表，不抛错。
   */
  private expandWithChildren(feedbackIds: string[]): string[] {
    const cleaned = feedbackIds
      .filter((x): x is string => typeof x === 'string')
      .map((x) => x.trim())
      .filter((x) => x.length > 0);
    if (cleaned.length === 0) return [];

    const result: string[] = [];
    const seen = new Set<string>();
    for (const id of cleaned) {
      if (!seen.has(id)) {
        seen.add(id);
        result.push(id);
      }
    }

    try {
      const placeholders = cleaned.map(() => '?').join(', ');
      const rows = this.db
        .prepare(
          `SELECT id FROM feedback_items WHERE parent_feedback_id IN (${placeholders})`,
        )
        .all(...cleaned) as { id: string }[];
      for (const r of rows) {
        if (!seen.has(r.id)) {
          seen.add(r.id);
          result.push(r.id);
        }
      }
    } catch {
      // feedback_items 表不存在 / parent_feedback_id 列不存在 → 不展开，返原列表
    }
    return result;
  }

  /** 读关联的 feedback_id 列表 */
  private getFeedbackIds(devItemId: string): string[] {
    const rows = this.db
      .prepare('SELECT feedback_id FROM dev_item_feedbacks WHERE dev_item_id = ? ORDER BY feedback_id')
      .all(devItemId) as { feedback_id: string }[];
    return rows.map((r) => r.feedback_id);
  }

  private rowToItem(row: DevItemRow | null | undefined): DevItem | null {
    if (!row) return null;
    const ids = this.getFeedbackIds(row.id);
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      level: normalizeLevel(row.level),
      status: normalizeStatus(row.status),
      representative_quote: row.representative_quote,
      quote_locked: row.quote_locked ? 1 : 0,
      source_themes: parseThemesJson(row.source_themes_json),
      themes_locked: row.themes_locked ? 1 : 0,
      created_at: row.created_at,
      updated_at: row.updated_at,
      launched_at: row.launched_at,
      thanks_sent_at: row.thanks_sent_at,
      updated_by: row.updated_by,
      feedback_ids: ids,
      feedback_count: ids.length,
    };
  }

  list(): DevItem[] {
    const rows = this.db
      .prepare(`SELECT ${SELECT_COLS} FROM dev_items ORDER BY status ASC, updated_at DESC`)
      .all() as DevItemRow[];
    return rows
      .map((r) => this.rowToItem(r))
      .filter((x): x is DevItem => x !== null);
  }

  getById(id: string): DevItem | null {
    const row = this.db
      .prepare(`SELECT ${SELECT_COLS} FROM dev_items WHERE id = ?`)
      .get(id) as DevItemRow | undefined;
    return this.rowToItem(row);
  }

  create(input: DevItemCreateInput, updatedBy: string): DevItem {
    const now = Date.now();
    const id = randomUUID();
    const title = input.title.trim();
    const description = (input.description ?? '').trim();
    const level = normalizeLevel(input.level);

    this.db
      .prepare(`
        INSERT INTO dev_items (
          id, title, description, level, status,
          representative_quote, quote_locked,
          source_themes_json, themes_locked,
          created_at, updated_at, launched_at, thanks_sent_at, updated_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        title,
        description,
        level,
        '规划中',
        '',
        0,
        '[]',
        0,
        now,
        now,
        null,
        null,
        updatedBy.trim() || 'admin',
      );

    // 初始关联 feedback（如果有）→ 自动聚合 quote + themes
    // 父子展开：父项被 promote 时其子项一并入库（admin 单击父 → 所有合并的孩子都看到 dev chip）
    if (input.feedback_ids && input.feedback_ids.length > 0) {
      const expanded = this.expandWithChildren(input.feedback_ids);
      const stmt = this.db.prepare(
        'INSERT OR IGNORE INTO dev_item_feedbacks (dev_item_id, feedback_id) VALUES (?, ?)',
      );
      for (const fid of expanded) {
        stmt.run(id, fid);
      }
      this.updateAggregation(id);
    }

    return this.getById(id)!;
  }

  update(id: string, input: DevItemPatchInput, updatedBy: string): DevItem | null {
    const current = this.getById(id);
    if (!current) return null;

    const now = Date.now();
    const nextTitle = input.title !== undefined ? input.title.trim() : current.title;
    const nextDescription =
      input.description !== undefined ? input.description.trim() : current.description;
    const nextLevel = input.level !== undefined ? normalizeLevel(input.level) : current.level;
    const nextStatus = input.status !== undefined ? normalizeStatus(input.status) : current.status;

    // representative_quote 三态：undefined=保持；null=解锁 + 触发聚合；string=写入 + 锁
    let nextQuote = current.representative_quote;
    let nextQuoteLocked = current.quote_locked;
    let needAggregateQuote = false;
    if (input.representative_quote !== undefined) {
      if (input.representative_quote === null) {
        nextQuoteLocked = 0;
        needAggregateQuote = true;
      } else {
        nextQuote = input.representative_quote;
        nextQuoteLocked = 1;
      }
    }

    // source_themes 三态：undefined=保持；null=解锁 + 触发聚合；array=写入 + 锁
    let nextThemes = current.source_themes;
    let nextThemesLocked = current.themes_locked;
    let needAggregateThemes = false;
    if (input.source_themes !== undefined) {
      if (input.source_themes === null) {
        nextThemesLocked = 0;
        needAggregateThemes = true;
      } else {
        nextThemes = input.source_themes.filter((x): x is string => typeof x === 'string');
        nextThemesLocked = 1;
      }
    }

    // status 流转 launched_at / thanks_sent_at
    let nextLaunchedAt = current.launched_at;
    let nextThanksSentAt = current.thanks_sent_at;
    if (nextStatus === '已上线') {
      if (nextLaunchedAt === null) {
        nextLaunchedAt = now;
      }
    } else {
      // 离开「已上线」清空两个时间戳
      nextLaunchedAt = null;
      nextThanksSentAt = null;
    }

    const nextUpdatedBy = updatedBy.trim() || current.updated_by;

    this.db
      .prepare(`
        UPDATE dev_items
        SET title = ?, description = ?, level = ?, status = ?,
            representative_quote = ?, quote_locked = ?,
            source_themes_json = ?, themes_locked = ?,
            updated_at = ?, launched_at = ?, thanks_sent_at = ?, updated_by = ?
        WHERE id = ?
      `)
      .run(
        nextTitle,
        nextDescription,
        nextLevel,
        nextStatus,
        nextQuote,
        nextQuoteLocked,
        JSON.stringify(nextThemes),
        nextThemesLocked,
        now,
        nextLaunchedAt,
        nextThanksSentAt,
        nextUpdatedBy,
        id,
      );

    if (needAggregateQuote || needAggregateThemes) {
      this.updateAggregation(id);
    }

    return this.getById(id);
  }

  delete(id: string): boolean {
    const exists = this.db.prepare('SELECT id FROM dev_items WHERE id = ?').get(id);
    if (!exists) return false;
    this.db.prepare('DELETE FROM dev_item_feedbacks WHERE dev_item_id = ?').run(id);
    this.db.prepare('DELETE FROM dev_items WHERE id = ?').run(id);
    return true;
  }

  attachFeedbacks(id: string, feedbackIds: string[]): DevItem | null {
    const current = this.getById(id);
    if (!current) return null;
    // 父子展开：传入父项 → 一并附加其子项
    const expanded = this.expandWithChildren(feedbackIds);
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO dev_item_feedbacks (dev_item_id, feedback_id) VALUES (?, ?)',
    );
    for (const fid of expanded) {
      stmt.run(id, fid);
    }
    this.updateAggregation(id);
    return this.getById(id);
  }

  detachFeedback(id: string, feedbackId: string): DevItem | null {
    const current = this.getById(id);
    if (!current) return null;
    this.db
      .prepare('DELETE FROM dev_item_feedbacks WHERE dev_item_id = ? AND feedback_id = ?')
      .run(id, feedbackId);
    this.updateAggregation(id);
    return this.getById(id);
  }

  markThanksSent(id: string): DevItem | null {
    const current = this.getById(id);
    if (!current) return null;
    const now = Date.now();
    this.db
      .prepare('UPDATE dev_items SET thanks_sent_at = ?, updated_at = ? WHERE id = ?')
      .run(now, now, id);
    return this.getById(id);
  }

  findLinksByFeedbackIds(feedbackIds: string[]): FeedbackDevItemLink[] {
    const cleaned = feedbackIds
      .filter((x): x is string => typeof x === 'string')
      .map((x) => x.trim())
      .filter((x) => x.length > 0);
    if (cleaned.length === 0) return [];

    const placeholders = cleaned.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`
        SELECT df.feedback_id AS feedback_id,
               di.id AS dev_item_id,
               di.title AS dev_item_title,
               di.status AS dev_item_status
        FROM dev_item_feedbacks df
        JOIN dev_items di ON di.id = df.dev_item_id
        WHERE df.feedback_id IN (${placeholders})
        ORDER BY di.updated_at DESC
      `)
      .all(...cleaned) as {
      feedback_id: string;
      dev_item_id: string;
      dev_item_title: string;
      dev_item_status: string;
    }[];

    return rows.map((r) => ({
      feedback_id: r.feedback_id,
      dev_item_id: r.dev_item_id,
      dev_item_title: r.dev_item_title,
      dev_item_status: normalizeStatus(r.dev_item_status),
    }));
  }

  /**
   * 自动聚合：根据当前关联的 feedback 重算未 lock 的 quote / themes
   * - JOIN feedback_items 同一 db；表不存在时（极少见）静默跳过
   * - themes_locked=0：source_themes = uniq(feedback.theme)
   * - quote_locked=0：representative_quote = 关联 feedback 中 text 最长者（空集→空串）
   */
  private updateAggregation(id: string): void {
    const row = this.db
      .prepare('SELECT quote_locked, themes_locked FROM dev_items WHERE id = ?')
      .get(id) as { quote_locked: number; themes_locked: number } | undefined;
    if (!row) return;

    if (row.quote_locked && row.themes_locked) {
      // 都锁了，只更新 updated_at（关联变化的事件感知）
      this.db.prepare('UPDATE dev_items SET updated_at = ? WHERE id = ?').run(Date.now(), id);
      return;
    }

    // 读关联 feedback 的 theme + text（容错：feedback_items 表不存在或字段缺失则跳过）
    let feedbacks: { theme: string; text: string }[] = [];
    try {
      feedbacks = this.db
        .prepare(`
          SELECT fi.theme AS theme, fi.text AS text
          FROM dev_item_feedbacks df
          JOIN feedback_items fi ON fi.id = df.feedback_id
          WHERE df.dev_item_id = ?
        `)
        .all(id) as { theme: string; text: string }[];
    } catch {
      // feedback_items 表不存在 → 不做聚合，仅 bump updated_at
      this.db.prepare('UPDATE dev_items SET updated_at = ? WHERE id = ?').run(Date.now(), id);
      return;
    }

    const updates: string[] = [];
    const params: (string | number | null)[] = [];

    if (!row.themes_locked) {
      const themeSet = new Set<string>();
      for (const f of feedbacks) {
        if (typeof f.theme === 'string' && f.theme.trim()) {
          themeSet.add(f.theme.trim());
        }
      }
      updates.push('source_themes_json = ?');
      params.push(JSON.stringify(Array.from(themeSet)));
    }

    if (!row.quote_locked) {
      let longest = '';
      for (const f of feedbacks) {
        const t = typeof f.text === 'string' ? f.text : '';
        if (t.length > longest.length) longest = t;
      }
      updates.push('representative_quote = ?');
      params.push(longest);
    }

    updates.push('updated_at = ?');
    params.push(Date.now());
    params.push(id);

    this.db.prepare(`UPDATE dev_items SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }
}

export const devItemStore = new DevItemStore();
