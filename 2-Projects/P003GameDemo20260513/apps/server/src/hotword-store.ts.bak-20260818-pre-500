/**
 * Worker 热词配置存储（运营台「热词管理」P0，2026-08-18 川哥拍板方案 A）。
 *
 * 三类 kind ↔ 64.90 env 键：
 *   interrupt → INTERRUPT_HOTWORDS   （worker 本地判定：ASR 文本命中即硬打断）
 *   asr       → VOLC_ASR_HOTWORDS    （火山服务端识别增强；同步写 poc-eou.env 防漂移）
 *   exit      → EXIT_SWALLOW_HOTWORDS（退出吞句；⚠️ 与 Android sessionExitPhrases 逐字合同）
 *
 * 版本模型：每 kind 一条 draft（编辑即覆盖）；发布时 draft→published（version+1），
 * 旧 published→archived。回滚=取历史版本 words 重新走发布链（产生新版本，不改历史）。
 * DB 是编辑真源；64.90 env 是运行时真源——发布链负责两者对齐（回执三方对撞）。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export type HotwordKind = 'interrupt' | 'asr' | 'exit' | 'device_asr';

export const KIND_TO_ENV: Record<HotwordKind, string> = {
  interrupt: 'INTERRUPT_HOTWORDS',
  asr: 'VOLC_ASR_HOTWORDS',
  exit: 'EXIT_SWALLOW_HOTWORDS',
  // S2-B2 设备 ASR boost 词(rust 侧与 asr 合并发火山;boost 与执行判定完全解耦)
  device_asr: 'P003_DEVICE_ASR_HOTWORDS',
};
export const HOTWORD_KINDS = Object.keys(KIND_TO_ENV) as HotwordKind[];

/** 与 64.90 apply_hotwords.py 的 VALUE_RE 同形（词内字符；逗号是分隔符不在词内） */
const WORD_RE = /^[一-鿿A-Za-z0-9 ]+$/;

/**
 * ASR 热词入表原则（voice-agent-ops skill「热词增减 SOP」2026-08-12 矩阵实验定案）：
 * 语气词绝不入表——环境音免疫靠它天然保留；入了 = 咳嗽/嗯啊全被吸成指令。
 */
const ASR_BLACKLIST = new Set([
  '嗯', '啊', '哦', '呀', '嘛', '呢', '吧', '哈', '唉', '诶', '哎', '嗯嗯', '啊啊', '哦哦',
]);

export interface HotwordVersion {
  id: number;
  kind: HotwordKind;
  words: string[];
  status: 'draft' | 'published' | 'archived';
  version: number;
  note: string;
  created_by: string;
  created_at: number;
  published_at: number | null;
}

export function validateWords(kind: HotwordKind, words: unknown): { ok: true; words: string[] } | { ok: false; error: string } {
  if (!Array.isArray(words)) return { ok: false, error: 'words 必须是数组' };
  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const raw of words) {
    if (typeof raw !== 'string') return { ok: false, error: '词条必须是字符串' };
    const w = raw.trim();
    if (!w) continue;
    if (w.length > 20) return { ok: false, error: `词条过长(>20字): ${w.slice(0, 20)}…` };
    if (!WORD_RE.test(w)) return { ok: false, error: `词条含非法字符(只允许中文/字母数字/空格): ${w}` };
    if ((kind === 'asr' || kind === 'device_asr') && ASR_BLACKLIST.has(w))
      return { ok: false, error: `「${w}」是语气词，禁止进 ASR 热词表（会破坏环境音免疫，咳嗽/嗯啊会被吸成指令）` };
    if (seen.has(w)) continue; // 去重静默
    seen.add(w);
    cleaned.push(w);
  }
  if (cleaned.length === 0) return { ok: false, error: '词表不能为空' };
  if (cleaned.length > 200) return { ok: false, error: '词表过大(>200)' };
  return { ok: true, words: cleaned };
}

/** 子集警告（不阻断）：打断语/退出词若不在 ASR 热词表中，孤立短指令可能被话语检测整段丢弃。
 *  device_asr 不参与（rust 侧与 asr 合并后整体生效，设备词天然被 boost）。 */
export function subsetWarnings(byKind: Partial<Record<HotwordKind, string[]>>): string[] {
  const asr = new Set(byKind.asr ?? []);
  const warnings: string[] = [];
  for (const kind of ['interrupt', 'exit'] as HotwordKind[]) {
    const missing = (byKind[kind] ?? []).filter((w) => !asr.has(w) && w.length <= 4);
    if (missing.length > 0)
      warnings.push(
        `${kind === 'interrupt' ? '打断语' : '退出词'}中 ${missing.map((w) => `「${w}」`).join('')} 不在 ASR 热词表，短指令识别率可能偏低`,
      );
  }
  return warnings;
}

class HotwordStore {
  private db: DatabaseSync | null = null;

  private conn(): DatabaseSync {
    if (this.db) return this.db;
    const raw = process.env.DEVICES_DB_PATH?.trim() || './data/devices.db';
    const p = path.resolve(raw);
    mkdirSync(path.dirname(p), { recursive: true });
    this.db = new DatabaseSync(p);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hotword_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL CHECK(kind IN ('interrupt','asr','exit','device_asr')),
        words_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('draft','published','archived')),
        version INTEGER NOT NULL DEFAULT 0,
        note TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        published_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_hotword_kind ON hotword_config(kind, status);
    `);
    this.migrateKindCheck(this.db);
    return this.db;
  }

  /** 老库迁移：初版 CHECK 无 device_asr（S2-B2 前建的生产表），SQLite 改约束须重建表。
   *  判据取 sqlite_master 的建表 SQL 文本；数据量个位数，重建零成本。失败记日志不阻断。 */
  private migrateKindCheck(db: DatabaseSync): void {
    try {
      const row = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='hotword_config'`)
        .get() as { sql: string } | undefined;
      if (!row || row.sql.includes('device_asr')) return;
      db.exec(`
        BEGIN;
        ALTER TABLE hotword_config RENAME TO hotword_config_old;
        CREATE TABLE hotword_config (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          kind TEXT NOT NULL CHECK(kind IN ('interrupt','asr','exit','device_asr')),
          words_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('draft','published','archived')),
          version INTEGER NOT NULL DEFAULT 0,
          note TEXT NOT NULL DEFAULT '',
          created_by TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          published_at INTEGER
        );
        INSERT INTO hotword_config SELECT * FROM hotword_config_old;
        DROP TABLE hotword_config_old;
        CREATE INDEX IF NOT EXISTS idx_hotword_kind ON hotword_config(kind, status);
        COMMIT;
      `);
      console.log('[hotword-store] kind CHECK 迁移完成(+device_asr)');
    } catch (e) {
      console.error(`[hotword-store] kind CHECK 迁移失败(device_asr 草稿将不可存): ${(e as Error).message}`);
    }
  }

  private row2v(r: Record<string, unknown>): HotwordVersion {
    return {
      id: r.id as number,
      kind: r.kind as HotwordKind,
      words: JSON.parse(r.words_json as string) as string[],
      status: r.status as HotwordVersion['status'],
      version: r.version as number,
      note: (r.note as string) ?? '',
      created_by: (r.created_by as string) ?? '',
      created_at: r.created_at as number,
      published_at: (r.published_at as number) ?? null,
    };
  }

  /** 草稿 upsert：每 kind 至多一条 draft */
  saveDraft(kind: HotwordKind, words: string[], by: string, note = ''): HotwordVersion {
    const db = this.conn();
    db.prepare(`DELETE FROM hotword_config WHERE kind = ? AND status = 'draft'`).run(kind);
    const now = Date.now();
    const r = db
      .prepare(
        `INSERT INTO hotword_config (kind, words_json, status, version, note, created_by, created_at)
         VALUES (?, ?, 'draft', 0, ?, ?, ?)`,
      )
      .run(kind, JSON.stringify(words), note, by, now);
    return this.getById(Number(r.lastInsertRowid))!;
  }

  draftOf(kind: HotwordKind): HotwordVersion | null {
    const r = this.conn()
      .prepare(`SELECT * FROM hotword_config WHERE kind = ? AND status = 'draft' LIMIT 1`)
      .get(kind) as Record<string, unknown> | undefined;
    return r ? this.row2v(r) : null;
  }

  deleteDraft(kind: HotwordKind): void {
    this.conn().prepare(`DELETE FROM hotword_config WHERE kind = ? AND status = 'draft'`).run(kind);
  }

  publishedOf(kind: HotwordKind): HotwordVersion | null {
    const r = this.conn()
      .prepare(`SELECT * FROM hotword_config WHERE kind = ? AND status = 'published' ORDER BY version DESC LIMIT 1`)
      .get(kind) as Record<string, unknown> | undefined;
    return r ? this.row2v(r) : null;
  }

  /** 发布成功后落版本：draft(若有)删除，旧 published→archived，新纪录 version+1 */
  markPublished(kind: HotwordKind, words: string[], by: string, note = ''): HotwordVersion {
    const db = this.conn();
    const maxV = db
      .prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM hotword_config WHERE kind = ?`)
      .get(kind) as { v: number };
    db.prepare(`UPDATE hotword_config SET status = 'archived' WHERE kind = ? AND status = 'published'`).run(kind);
    db.prepare(`DELETE FROM hotword_config WHERE kind = ? AND status = 'draft'`).run(kind);
    const now = Date.now();
    const r = db
      .prepare(
        `INSERT INTO hotword_config (kind, words_json, status, version, note, created_by, created_at, published_at)
         VALUES (?, ?, 'published', ?, ?, ?, ?, ?)`,
      )
      .run(kind, JSON.stringify(words), maxV.v + 1, note, by, now, now);
    return this.getById(Number(r.lastInsertRowid))!;
  }

  history(kind: HotwordKind, limit = 30): HotwordVersion[] {
    return (
      this.conn()
        .prepare(
          `SELECT * FROM hotword_config WHERE kind = ? AND status IN ('published','archived')
           ORDER BY version DESC LIMIT ?`,
        )
        .all(kind, limit) as Record<string, unknown>[]
    ).map((r) => this.row2v(r));
  }

  getById(id: number): HotwordVersion | null {
    const r = this.conn().prepare(`SELECT * FROM hotword_config WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? this.row2v(r) : null;
  }

  versionOf(kind: HotwordKind, version: number): HotwordVersion | null {
    const r = this.conn()
      .prepare(`SELECT * FROM hotword_config WHERE kind = ? AND version = ? AND status IN ('published','archived') LIMIT 1`)
      .get(kind, version) as Record<string, unknown> | undefined;
    return r ? this.row2v(r) : null;
  }

  /** 测试钩子：关闭连接（生产不调用） */
  close(): void {
    this.db?.close();
    this.db = null;
  }
}

export const hotwordStore = new HotwordStore();
