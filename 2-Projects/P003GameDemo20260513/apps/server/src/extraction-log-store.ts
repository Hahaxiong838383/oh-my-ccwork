/**
 * 记忆抽取流水（2026-09-03「记忆板块一直没更新」排查后加）：每轮抽取记一行——模型看到了多长的话、
 * 花了多少毫秒、画像动了哪些字段、情景候选几条入库几条、被门拒的原因。它是记忆板块的白盒
 * （对应人格成长的成长账本）：条目少的时候，能回答「是没抽到、没过门、还是重复」。
 * 同库 profile.db；每账号只留最近 100 行（写后裁剪）；失败绝不抛（记账不影响记忆链）。
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type ExtractionLogEntry = {
  id: string;
  account_id: string;
  ts: number;
  source_msg_id: string;
  user_len: number;
  llm_ms: number;
  ok: number; //          1=模型返回了 JSON；0=超时/失败/无 JSON
  patch_keys: string; //  画像更新字段，逗号分隔
  candidates: number; //  情景候选条数（过门后）
  added: number; //       实际入库条数
  rejected: string; //    被拒原因摘要（如「兴趣无证据×2;改名 no_intent」）
  note: string;
};

export type NewExtractionLog = Omit<ExtractionLogEntry, 'id' | 'account_id' | 'ts'> & { ts?: number };

const KEEP_PER_ACCOUNT = 100;
const DEFAULT_DB_PATH = './data/profile.db';

function resolveDbPath(): string {
  const raw = process.env.PROFILE_DB_PATH?.trim() || DEFAULT_DB_PATH;
  return resolve(process.cwd(), raw);
}

class ExtractionLogStore {
  private readonly db: DatabaseSync;

  constructor() {
    const dbPath = resolveDbPath();
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS extraction_log (
        id            TEXT PRIMARY KEY,
        account_id    TEXT NOT NULL,
        ts            INTEGER NOT NULL,
        source_msg_id TEXT NOT NULL DEFAULT '',
        user_len      INTEGER NOT NULL DEFAULT 0,
        llm_ms        INTEGER NOT NULL DEFAULT 0,
        ok            INTEGER NOT NULL DEFAULT 1,
        patch_keys    TEXT NOT NULL DEFAULT '',
        candidates    INTEGER NOT NULL DEFAULT 0,
        added         INTEGER NOT NULL DEFAULT 0,
        rejected      TEXT NOT NULL DEFAULT '',
        note          TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_extraction_log_account_ts ON extraction_log (account_id, ts DESC);
    `);
  }

  record(accountId: string, e: NewExtractionLog): void {
    try {
      const ts = e.ts ?? Date.now();
      this.db
        .prepare(`INSERT INTO extraction_log (id, account_id, ts, source_msg_id, user_len, llm_ms, ok, patch_keys, candidates, added, rejected, note)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(randomUUID(), accountId, ts, e.source_msg_id ?? '', e.user_len ?? 0, e.llm_ms ?? 0, e.ok ? 1 : 0,
          (e.patch_keys ?? '').slice(0, 200), e.candidates ?? 0, e.added ?? 0, (e.rejected ?? '').slice(0, 300), (e.note ?? '').slice(0, 200));
      this.db
        .prepare(`DELETE FROM extraction_log WHERE account_id = ? AND id NOT IN (
                    SELECT id FROM extraction_log WHERE account_id = ? ORDER BY ts DESC LIMIT ?)`)
        .run(accountId, accountId, KEEP_PER_ACCOUNT);
    } catch (err) {
      console.log('[extraction-log] 记账失败(不影响记忆链):', String((err as Error)?.message ?? err));
    }
  }

  list(accountId: string, limit = 20): ExtractionLogEntry[] {
    const n = Math.min(Math.max(limit, 1), KEEP_PER_ACCOUNT);
    return this.db
      .prepare(`SELECT * FROM extraction_log WHERE account_id = ? ORDER BY ts DESC LIMIT ?`)
      .all(accountId, n) as ExtractionLogEntry[];
  }

  clear(accountId: string): number {
    const r = this.db.prepare(`DELETE FROM extraction_log WHERE account_id = ?`).run(accountId);
    return Number(r.changes);
  }
}

export const extractionLogStore = new ExtractionLogStore();
