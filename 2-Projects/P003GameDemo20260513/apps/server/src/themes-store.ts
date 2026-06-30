import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  type FeedbackTheme,
  type ThemeCreateInput,
  type ThemePatchInput,
  SEED_THEMES,
} from './themes-types.js';

/**
 * 主题词表 store（架构 C：themes.id == display_name，事务联动 feedback.theme rename）
 *
 * - 复用同一 feedback.db 文件（同 process WAL 安全 + 跨表事务必需）
 * - 构造时建表 + 首次启动 seed 13 项预设（count==0 才写）
 * - rename（PATCH new_id）走事务：UPDATE feedback.theme + UPDATE feedback_themes.id 一致提交
 * - system=1（「未分类」「其他」）锁：拒改 id / 拒删 / 拒 active=0
 *
 * error 抛具体字符串（'conflict_id' / 'system_protected'），路由层映射 HTTP code。
 */

type ThemeRow = {
  id: string;
  display_name: string;
  color: string;
  sort_order: number;
  active: number;
  system: number;
  created_at: number;
  updated_at: number;
};

const DEFAULT_DB_PATH = './data/feedback.db';

function resolveDbPath(): string {
  const rawPath = process.env.FEEDBACK_DB_PATH?.trim() || DEFAULT_DB_PATH;
  return resolve(process.cwd(), rawPath);
}

function toTheme(row: ThemeRow | null | undefined): FeedbackTheme | null {
  if (!row) return null;
  return {
    id: row.id,
    display_name: row.display_name,
    color: row.color,
    sort_order: row.sort_order,
    active: row.active,
    system: row.system,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

class ThemeStore {
  private readonly db: DatabaseSync;

  constructor() {
    const dbPath = resolveDbPath();
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS feedback_themes (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        color TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        system INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_feedback_themes_sort
      ON feedback_themes (sort_order ASC);
    `);
    this.seedIfEmpty();
  }

  /** 首次启动 seed：仅当表为空时批量写入 SEED_THEMES。幂等。 */
  private seedIfEmpty(): void {
    const row = this.db
      .prepare('SELECT COUNT(*) AS c FROM feedback_themes')
      .get() as { c: number };
    if (row.c > 0) return;
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO feedback_themes
        (id, display_name, color, sort_order, active, system, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.db.exec('BEGIN');
    try {
      for (const seed of SEED_THEMES) {
        stmt.run(
          seed.id,
          seed.display_name,
          seed.color,
          seed.sort_order,
          seed.active,
          seed.system,
          now,
          now,
        );
      }
      this.db.exec('COMMIT');
      console.log(`[themes-store] seeded ${SEED_THEMES.length} themes`);
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** 全部主题（默认含 inactive），按 sort_order asc 排。 */
  list(opts?: { onlyActive?: boolean }): FeedbackTheme[] {
    const onlyActive = opts?.onlyActive ?? false;
    const where = onlyActive ? 'WHERE active = 1' : '';
    const rows = this.db
      .prepare(`SELECT * FROM feedback_themes ${where} ORDER BY sort_order ASC, id ASC`)
      .all() as ThemeRow[];
    return rows
      .map((r) => toTheme(r))
      .filter((t): t is FeedbackTheme => t !== null);
  }

  getById(id: string): FeedbackTheme | null {
    const row = this.db
      .prepare('SELECT * FROM feedback_themes WHERE id = ?')
      .get(id) as ThemeRow | undefined;
    return toTheme(row);
  }

  /**
   * 创建新 theme。
   * - id 已存在（含 inactive）→ throw 'conflict_id'
   * - sort_order 缺省 = max(sort_order)+10
   * - system 强制为 0
   * - display_name 同步等于 id（C 方案）
   */
  create(input: ThemeCreateInput, updatedBy: string): FeedbackTheme {
    const id = input.id.trim();
    if (!id) throw new Error('bad_request');
    const existing = this.getById(id);
    if (existing) throw new Error('conflict_id');

    let sortOrder = input.sort_order;
    if (sortOrder === undefined || sortOrder === null || !Number.isFinite(sortOrder)) {
      const maxRow = this.db
        .prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM feedback_themes')
        .get() as { m: number };
      sortOrder = maxRow.m + 10;
    }

    const now = Date.now();
    this.db
      .prepare(`
        INSERT INTO feedback_themes
          (id, display_name, color, sort_order, active, system, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, 0, ?, ?)
      `)
      .run(id, id, input.color, sortOrder, now, now);
    console.log(`[themes-store] create id=${id} sort=${sortOrder} by=${updatedBy || 'admin'}`);
    const created = this.getById(id);
    if (!created) throw new Error('create_failed');
    return created;
  }

  /**
   * 更新 theme。
   * - 行不存在 → null
   * - system=1：拒改 id（new_id 与 id 不同）；拒 active=0
   * - new_id 提供：
   *     · 与原 id 一致 → no-op rename
   *     · 与其他行冲突 → throw 'conflict_id'
   *     · 事务里 UPDATE feedback.theme(old→new) + UPDATE feedback_themes(id, display_name)
   * - color/sort_order/active：常规 UPDATE
   */
  update(id: string, input: ThemePatchInput, updatedBy: string): FeedbackTheme | null {
    const current = this.getById(id);
    if (!current) return null;

    const newId = typeof input.new_id === 'string' ? input.new_id.trim() : undefined;
    const renameRequested = newId !== undefined && newId !== '' && newId !== id;

    if (current.system === 1) {
      if (renameRequested) throw new Error('system_protected');
      if (input.active === 0) throw new Error('system_protected');
    }

    // 校验 rename 目标不冲突（必须先校验后写）
    if (renameRequested) {
      const clash = this.getById(newId!);
      if (clash) throw new Error('conflict_id');
    }

    const now = Date.now();
    const nextColor = input.color ?? current.color;
    const nextSort =
      typeof input.sort_order === 'number' && Number.isFinite(input.sort_order)
        ? input.sort_order
        : current.sort_order;
    const nextActive =
      typeof input.active === 'number' && (input.active === 0 || input.active === 1)
        ? input.active
        : current.active;

    this.db.exec('BEGIN');
    try {
      if (renameRequested) {
        // feedback.theme 联动 rename（架构 C 核心：字符串等值同步）
        this.db
          .prepare('UPDATE feedback_items SET theme = ? WHERE theme = ?')
          .run(newId!, id);
        // themes 表本行 id + display_name 同步迁移
        this.db
          .prepare(`
            UPDATE feedback_themes
            SET id = ?, display_name = ?, color = ?, sort_order = ?, active = ?, updated_at = ?
            WHERE id = ?
          `)
          .run(newId!, newId!, nextColor, nextSort, nextActive, now, id);
      } else {
        this.db
          .prepare(`
            UPDATE feedback_themes
            SET color = ?, sort_order = ?, active = ?, updated_at = ?
            WHERE id = ?
          `)
          .run(nextColor, nextSort, nextActive, now, id);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    const finalId = renameRequested ? newId! : id;
    console.log(
      `[themes-store] update id=${id}${renameRequested ? ` → ${finalId}` : ''} by=${updatedBy || 'admin'}`,
    );
    return this.getById(finalId);
  }

  /**
   * 物理删（软删走 PATCH active=0）。
   * - system=1 → throw 'system_protected'
   * - 不存在 → 返回 false
   * - 引用该 theme 的 feedback 不动（chip 前端兜底「(已禁用)」）
   */
  remove(id: string): boolean {
    const current = this.getById(id);
    if (!current) return false;
    if (current.system === 1) throw new Error('system_protected');
    const res = this.db.prepare('DELETE FROM feedback_themes WHERE id = ?').run(id);
    const changes = Number(res.changes ?? 0);
    console.log(`[themes-store] remove id=${id} changes=${changes}`);
    return changes > 0;
  }
}

export const themeStore = new ThemeStore();
