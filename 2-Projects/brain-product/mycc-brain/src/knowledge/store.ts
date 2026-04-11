/**
 * store.ts — 外挂知识系统的 SQLite 存储层
 *
 * 独立于 memory.db 的 knowledge.db，绝不共用连接。
 * Schema：knowledge_items + FTS5 虚表 + 三个触发器（ai / ad / au）。
 * 设计决策：
 *   - **无全局单例**：Database 作为参数传入，测试可用 `:memory:`。
 *   - **lazy driver load**：better-sqlite3 运行时 import，避免 ESM 静态解析。
 *   - **append-only 写入 + soft delete**：tombstone=1 代替 DELETE，保留审计轨迹。
 *   - **不引入 sqlite-vec**：Spike 阶段纯 FTS5，向量检索留给 P1。
 *
 * 参考：src/services/memory-db.ts（相同的 FTS5 + 触发器模式）。
 */
import type {
  DocSyncState,
  KnowledgeItemInput,
  KnowledgeSearchHit,
} from "./types.js";

/** 运行时不做类型收紧（避开 better-sqlite3 类型依赖）。 */
export type KnowledgeDatabase = unknown;

let DatabaseCtor: unknown = null;

async function loadDriver(): Promise<boolean> {
  if (DatabaseCtor) return true;
  try {
    const modName = "better-sqlite3";
    const mod = await import(modName);
    const m = mod as { default?: unknown };
    DatabaseCtor = m.default ?? mod;
    return true;
  } catch {
    console.error("[knowledge-store] better-sqlite3 not available");
    return false;
  }
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS knowledge_items (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_token    TEXT    NOT NULL,
    doc_title    TEXT    NOT NULL,
    space_id     TEXT    NOT NULL,
    namespace    TEXT    NOT NULL,
    content      TEXT    NOT NULL,
    keywords     TEXT    NOT NULL,
    confidence   REAL    NOT NULL,
    source_url   TEXT    NOT NULL,
    extracted_by TEXT    NOT NULL,
    created_at   INTEGER NOT NULL,
    tombstone    INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_knowledge_doc_token
    ON knowledge_items(doc_token);

  CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
    namespace, content, keywords,
    content='knowledge_items',
    content_rowid='id'
  );

  CREATE TRIGGER IF NOT EXISTS knowledge_ai AFTER INSERT ON knowledge_items BEGIN
    INSERT INTO knowledge_fts(rowid, namespace, content, keywords)
    VALUES (new.id, new.namespace, new.content, new.keywords);
  END;

  CREATE TRIGGER IF NOT EXISTS knowledge_ad AFTER DELETE ON knowledge_items BEGIN
    INSERT INTO knowledge_fts(knowledge_fts, rowid, namespace, content, keywords)
    VALUES ('delete', old.id, old.namespace, old.content, old.keywords);
  END;

  CREATE TRIGGER IF NOT EXISTS knowledge_au AFTER UPDATE ON knowledge_items BEGIN
    INSERT INTO knowledge_fts(knowledge_fts, rowid, namespace, content, keywords)
    VALUES ('delete', old.id, old.namespace, old.content, old.keywords);
    INSERT INTO knowledge_fts(rowid, namespace, content, keywords)
    VALUES (new.id, new.namespace, new.content, new.keywords);
  END;

  CREATE TABLE IF NOT EXISTS doc_sync_state (
    doc_token         TEXT PRIMARY KEY,
    doc_title         TEXT NOT NULL,
    space_id          TEXT NOT NULL,
    content_hash      TEXT NOT NULL DEFAULT '',
    last_synced_at    INTEGER NOT NULL DEFAULT 0,
    last_extracted_at INTEGER NOT NULL DEFAULT 0,
    status            TEXT NOT NULL,
    error_message     TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_doc_sync_status
    ON doc_sync_state(status);
  CREATE INDEX IF NOT EXISTS idx_doc_sync_space
    ON doc_sync_state(space_id);
`;

/** 打开（或创建）knowledge.db；`:memory:` 可用于测试 */
export async function openKnowledgeDB(
  dbPath: string,
): Promise<KnowledgeDatabase | null> {
  if (!(await loadDriver())) return null;
  const Ctor = DatabaseCtor as new (path: string) => unknown;
  const db = new Ctor(dbPath) as {
    pragma: (s: string) => void;
    exec: (s: string) => void;
  };
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA_SQL);
  return db;
}

type PreparedStmt = {
  run: (...params: unknown[]) => { lastInsertRowid: number | bigint; changes: number };
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
};
type DbHandle = {
  prepare: (sql: string) => PreparedStmt;
  transaction: <T>(fn: (arg: T) => void) => (arg: T) => void;
  close: () => void;
};

/** 写入单条，返回 rowid */
export function insertKnowledgeItem(
  db: KnowledgeDatabase,
  input: KnowledgeItemInput,
): number {
  const h = db as DbHandle;
  const stmt = h.prepare(`
    INSERT INTO knowledge_items (
      doc_token, doc_title, space_id, namespace, content,
      keywords, confidence, source_url, extracted_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    input.docToken,
    input.docTitle,
    input.spaceId,
    input.namespace,
    input.content,
    JSON.stringify(input.keywords),
    input.confidence,
    input.sourceUrl,
    input.extractedBy,
    Date.now(),
  );
  return Number(info.lastInsertRowid);
}

/** 批量写入，事务包裹 */
export function insertKnowledgeItems(
  db: KnowledgeDatabase,
  inputs: readonly KnowledgeItemInput[],
): readonly number[] {
  const h = db as DbHandle;
  const ids: number[] = [];
  const tx = h.transaction((items: readonly KnowledgeItemInput[]) => {
    for (const item of items) {
      ids.push(insertKnowledgeItem(db, item));
    }
  });
  tx(inputs);
  return ids;
}

/** FTS5 查询的特殊字符清洗（参考 memory-db.ts sanitizeFtsQuery） */
function sanitizeFtsQuery(query: string): string {
  const cleaned = query.replace(/[.*+\-"(){}[\]^~:@#$%&\\|<>=!?,;]/g, " ");
  const tokens = cleaned.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t}"`).join(" OR ");
}

/** 关键词召回；tombstone=1 自动过滤 */
export function knowledgeFtsSearch(
  db: KnowledgeDatabase,
  query: string,
  topK = 10,
): readonly KnowledgeSearchHit[] {
  const ftsQuery = sanitizeFtsQuery(query);
  if (!ftsQuery) return [];
  const h = db as DbHandle;
  try {
    const stmt = h.prepare(`
      SELECT
        k.id            AS id,
        k.namespace     AS namespace,
        k.content       AS content,
        k.doc_title     AS doc_title,
        k.source_url    AS source_url,
        knowledge_fts.rank AS rank
      FROM knowledge_fts
      JOIN knowledge_items k ON k.id = knowledge_fts.rowid
      WHERE knowledge_fts MATCH ? AND k.tombstone = 0
      ORDER BY knowledge_fts.rank
      LIMIT ?
    `);
    const rows = stmt.all(ftsQuery, topK) as Array<{
      id: number;
      namespace: string;
      content: string;
      doc_title: string;
      source_url: string;
      rank: number;
    }>;
    return rows.map(
      (r): KnowledgeSearchHit => ({
        id: r.id,
        namespace: r.namespace,
        content: r.content,
        docTitle: r.doc_title,
        sourceUrl: r.source_url,
        rank: r.rank,
      }),
    );
  } catch (err) {
    console.error("[knowledge-store] ftsSearch failed:", err);
    return [];
  }
}

/** 软删：tombstone=1（不触发 FTS 删除，查询端用 tombstone=0 过滤） */
export function softDeleteByDocToken(
  db: KnowledgeDatabase,
  docToken: string,
): number {
  const h = db as DbHandle;
  const stmt = h.prepare(
    "UPDATE knowledge_items SET tombstone = 1 WHERE doc_token = ? AND tombstone = 0",
  );
  const info = stmt.run(docToken);
  return info.changes;
}

/** 计数；默认只算 tombstone=0 */
export function countKnowledgeItems(
  db: KnowledgeDatabase,
  includeDeleted = false,
): number {
  const h = db as DbHandle;
  const sql = includeDeleted
    ? "SELECT COUNT(*) AS n FROM knowledge_items"
    : "SELECT COUNT(*) AS n FROM knowledge_items WHERE tombstone = 0";
  const row = h.prepare(sql).get() as { n: number };
  return row.n;
}

/** 关闭连接 */
export function closeKnowledgeDB(db: KnowledgeDatabase): void {
  const h = db as DbHandle;
  try {
    h.close();
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// doc_sync_state CRUD（P0.1 crawler 用）
// ---------------------------------------------------------------------------

const DOC_SYNC_COLUMNS =
  "doc_token, doc_title, space_id, content_hash, last_synced_at, last_extracted_at, status, error_message";

function rowToDocSyncState(row: Record<string, unknown>): DocSyncState {
  return {
    docToken: row.doc_token as string,
    docTitle: row.doc_title as string,
    spaceId: row.space_id as string,
    contentHash: row.content_hash as string,
    lastSyncedAt: row.last_synced_at as number,
    lastExtractedAt: row.last_extracted_at as number,
    status: row.status as DocSyncState["status"],
    errorMessage: row.error_message as string,
  };
}

/** 插入或更新一条 doc_sync_state（P0.1 crawler 用） */
export function upsertDocSyncState(
  db: KnowledgeDatabase,
  state: DocSyncState,
): void {
  const h = db as DbHandle;
  const stmt = h.prepare(`
    INSERT INTO doc_sync_state (
      doc_token, doc_title, space_id, content_hash,
      last_synced_at, last_extracted_at, status, error_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(doc_token) DO UPDATE SET
      doc_title = excluded.doc_title,
      space_id = excluded.space_id,
      content_hash = excluded.content_hash,
      last_synced_at = excluded.last_synced_at,
      last_extracted_at = excluded.last_extracted_at,
      status = excluded.status,
      error_message = excluded.error_message
  `);
  stmt.run(
    state.docToken,
    state.docTitle,
    state.spaceId,
    state.contentHash,
    state.lastSyncedAt,
    state.lastExtractedAt,
    state.status,
    state.errorMessage,
  );
}

/** 查单条状态，不存在返回 undefined */
export function getDocSyncState(
  db: KnowledgeDatabase,
  docToken: string,
): DocSyncState | undefined {
  const h = db as DbHandle;
  const row = h
    .prepare(
      `SELECT ${DOC_SYNC_COLUMNS} FROM doc_sync_state WHERE doc_token = ?`,
    )
    .get(docToken) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return rowToDocSyncState(row);
}

/** 列某个 status 下的所有文档（extractor 用来拉 pending 队列） */
export function listDocSyncStatesByStatus(
  db: KnowledgeDatabase,
  status: DocSyncState["status"],
  limit = 100,
): readonly DocSyncState[] {
  const h = db as DbHandle;
  const rows = h
    .prepare(
      `SELECT ${DOC_SYNC_COLUMNS} FROM doc_sync_state WHERE status = ? ORDER BY last_synced_at ASC LIMIT ?`,
    )
    .all(status, limit) as Array<Record<string, unknown>>;
  return rows.map(rowToDocSyncState);
}
