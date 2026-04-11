/**
 * store.ts — brain-wiki 数据层（v0.14 Phase 1）
 *
 * 独立于 memory.db 和 knowledge.db，绝不共用 connection。
 *
 * 面向 Phase 2 的 MCP server：cc / Claude Code 将通过 guide/search/read/write/delete
 * 5 个工具维护 wiki 页（/wiki/entities/... + /wiki/concepts/... + /wiki/overview.md ...）
 * 和 source 原始材料（/sources/...）。智能完全由客户端承担，服务端零 LLM 调用。
 *
 * 三条加固原则（吃 codex 对 v0.13.3 memory-db 迁移的反馈，避免历史问题重现）：
 *   1. **原子迁移**：`initSchema` 在 `BEGIN IMMEDIATE` 事务内完成 schema + user_version，
 *      任一步失败立即 ROLLBACK 并向上 throw，不会留半迁移状态。
 *   2. **Single-flight mutex**：`openWikiDb` 用模块级 in-flight Promise map（按 dbPath），
 *      冷启动时多个并发 caller 只会触发一次实际初始化。
 *   3. **精确 schema 检测**：用 `PRAGMA user_version` 标记版本，不做字符串模糊匹配。
 *      v1 = 1。后续 schema 变更升版号 + 写迁移步骤。
 *
 * 其它设计决策：
 *   - **无 triggers**：upsert/softDelete 里手动同步 wiki_documents_fts，和 v0.13.3 memory-db
 *     学到的教训一致（自动 trigger 在 schema 漂移时会埋隐患）。
 *   - **tombstone soft delete**：append-only + `tombstone=1`，getDocumentByPath / searchByFts
 *     自动过滤。FTS 里直接 DELETE 对应 rowid，避免搜索命中。
 *   - **中文 2-gram 预分词**：写入 FTS 前对 title/content 做滑窗分词，读端同样处理 query。
 *     better-sqlite3 打包的 SQLite 没编译 FTS5_TRIGRAM，unicode61 对无空格中文无效。
 *     pattern 和 knowledge/store.ts 一致，这里独立实现避免跨模块耦合。
 *   - **Database 参数传入**：没有全局单例，调用方持有 db 实例。测试时用 `:memory:`。
 *   - **lazy driver load**：better-sqlite3 运行时 import，避免 ESM 静态解析污染类型。
 */
import type {
  DocumentKind,
  WikiDocument,
  WikiDocumentInput,
  WikiSearchHit,
  WikiSearchOptions,
} from "./types.js";

/** 运行时类型打擦除：避开 better-sqlite3 类型依赖。 */
export type WikiDatabase = unknown;

/** 当前 schema 版本。升级 schema 时同步 bump。 */
export const WIKI_SCHEMA_VERSION = 1;

/**
 * v1 schema：wiki_documents 主表 + regular wiki_documents_fts 虚表 + 索引。
 *
 * FTS5 使用 **regular** 模式（无 `content=` 属性），FTS5 自己存 title/content/path
 * 的副本：
 *   - 普通 SQL INSERT / DELETE / UPDATE 全部支持（不需要 FTS5 'delete' 命令）
 *   - 避开 external content 的 SQLITE_CORRUPT_VTAB 陷阱（UPDATE base 后 DELETE fts
 *     的派生内容不一致）
 *   - 避开 contentless 的 "DELETE 需要传 old_values" 陷阱
 *   - 代价：FTS index 存一份 tokenized 副本（中英文扩张后约 2x base content 大小），
 *     对 wiki 规模（百页级）完全可接受
 *   - SELECT content FROM fts 返回的是 tokenized 版本（用来 match），原文一律 JOIN
 *     wiki_documents 取
 */
const SCHEMA_SQL_V1 = `
  CREATE TABLE IF NOT EXISTS wiki_documents (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    path         TEXT    NOT NULL UNIQUE,
    title        TEXT    NOT NULL,
    content      TEXT    NOT NULL,
    kind         TEXT    NOT NULL CHECK (kind IN ('wiki', 'source')),
    tags         TEXT,
    version      INTEGER NOT NULL DEFAULT 1,
    tombstone    INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_wiki_docs_kind ON wiki_documents(kind);
  CREATE INDEX IF NOT EXISTS idx_wiki_docs_tombstone ON wiki_documents(tombstone);
  CREATE VIRTUAL TABLE IF NOT EXISTS wiki_documents_fts USING fts5(
    title,
    content,
    path UNINDEXED,
    tokenize='unicode61'
  );
`;

// ---------------------------------------------------------------------------
// driver & 中文分词（与 knowledge/store.ts 同 pattern，独立实现）
// ---------------------------------------------------------------------------

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
    console.error("[wiki-store] better-sqlite3 not available");
    return false;
  }
}

/**
 * 中文 2-gram 预分词（与 knowledge/store.ts 的 tokenizeChineseForFts 等价实现）。
 *
 * 连续 ASCII 段保持完整，连续中文按 2-gram 滑窗切 + 单字备份。
 * 例："Futurus 公司战略" → "Futurus 公司 公 司战 司 战略 战"
 */
export function tokenizeCjk2Gram(text: string): string {
  if (!text) return "";
  const out: string[] = [];
  const isCjk = (c: string): boolean =>
    /[\u4e00-\u9fff\u3400-\u4dbf]/.test(c);
  let ascii = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (isCjk(c)) {
      if (ascii) {
        out.push(ascii);
        ascii = "";
      }
      if (i + 1 < text.length && isCjk(text[i + 1])) {
        out.push(text.slice(i, i + 2));
      }
      out.push(c);
    } else if (/\s/.test(c)) {
      if (ascii) {
        out.push(ascii);
        ascii = "";
      }
    } else {
      ascii += c;
    }
  }
  if (ascii) out.push(ascii);
  return out.join(" ");
}

/**
 * 把用户 query 转成 FTS5 MATCH 表达式。
 *
 * 策略：tokenize 后每个 token 作为 phrase，OR 拼接。空白或无有效 token → null。
 * 转义双引号避免 FTS5 语法错误。
 */
function buildFtsQuery(query: string): string | null {
  const cleaned = query.trim();
  if (!cleaned) return null;
  const tokenized = tokenizeCjk2Gram(cleaned);
  const tokens = tokenized.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  return tokens
    .map((t) => `"${t.replace(/"/g, "")}"`)
    .filter((t) => t !== '""')
    .join(" OR ");
}

// ---------------------------------------------------------------------------
// 初始化（Single-flight + 原子迁移）
// ---------------------------------------------------------------------------

/** 模块级 in-flight map：按 dbPath 保证同一时刻只有一个初始化在跑。 */
const inflightOpen = new Map<string, Promise<WikiDatabase | null>>();

/**
 * 打开或新建 brain-wiki.db。
 *
 * @param dbPath 绝对路径或 `:memory:`（测试用）
 * @returns WikiDatabase 实例；驱动加载失败或 init 异常时返回 null
 *
 * 并发安全：多个 caller 同时调用同一个 dbPath，只会跑一次实际 init；
 * 其它 caller 拿到同一个 Promise 的结果。init 失败后从 map 移除，允许重试。
 */
export async function openWikiDb(dbPath: string): Promise<WikiDatabase | null> {
  const existing = inflightOpen.get(dbPath);
  if (existing) return existing;

  const p = (async (): Promise<WikiDatabase | null> => {
    if (!(await loadDriver())) return null;
    try {
      const Ctor = DatabaseCtor as new (path: string) => unknown;
      const db = new Ctor(dbPath);
      const d = db as {
        pragma: (stmt: string, opts?: { simple?: boolean }) => unknown;
      };
      // WAL 提升并发读写；busy_timeout 防御竞争
      d.pragma("journal_mode = WAL");
      d.pragma("busy_timeout = 5000");
      // 原子迁移（内部 BEGIN IMMEDIATE；失败会 throw）
      initSchema(db);
      return db;
    } catch (err) {
      console.error("[wiki-store] openWikiDb failed:", err);
      return null;
    }
  })();

  inflightOpen.set(dbPath, p);
  // 不管成功还是失败都从 map 移除：失败允许重试；成功后 db 由 caller 持有，
  // 下次 openWikiDb 同路径会新开连接（幂等，schema 已初始化）
  p.finally(() => {
    inflightOpen.delete(dbPath);
  }).catch(() => {
    /* 已在 async 内 catch；这里避免 unhandled rejection */
  });

  return p;
}

/**
 * 原子 schema 迁移。
 *
 * 读 PRAGMA user_version，如果 ≥ WIKI_SCHEMA_VERSION 则什么都不做；
 * 否则在 BEGIN IMMEDIATE 单事务内执行 SCHEMA_SQL_V1 + 更新 user_version。
 *
 * 失败时 ROLLBACK 并 throw，由 openWikiDb 捕获后返回 null 并从 in-flight map 清理。
 *
 * 注意：better-sqlite3 的 CREATE VIRTUAL TABLE 可能有特殊约束，若未来新增 FTS 表需重新验证。
 */
function initSchema(db: unknown): void {
  const d = db as {
    pragma: (stmt: string, opts?: { simple?: boolean }) => unknown;
    exec: (sql: string) => void;
  };
  const currentVersion = Number(
    d.pragma("user_version", { simple: true }) ?? 0,
  );
  if (currentVersion >= WIKI_SCHEMA_VERSION) {
    return;
  }

  d.exec("BEGIN IMMEDIATE");
  try {
    d.exec(SCHEMA_SQL_V1);
    d.pragma(`user_version = ${WIKI_SCHEMA_VERSION}`);
    d.exec("COMMIT");
    console.log(`[wiki-store] schema v${WIKI_SCHEMA_VERSION} initialized`);
  } catch (err) {
    try {
      d.exec("ROLLBACK");
    } catch {
      /* rollback 失败只能吞（事务已部分失败），主错误通过 throw 冒泡 */
    }
    throw err;
  }
}

/** 测试/cleanup 用：关闭 db connection。 */
export function closeWikiDb(db: WikiDatabase): void {
  try {
    (db as { close: () => void }).close();
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * Upsert by path。
 *   - path 不存在 → INSERT，version=1
 *   - path 已存在（含 tombstone=1 的复活） → UPDATE，version+1，tombstone=0
 *   - FTS 同步：先 DELETE 旧 rowid，再 INSERT 新 tokenized content
 *   - 外层用 db.transaction 包住所有写操作
 */
export function upsertDocument(
  db: WikiDatabase,
  input: WikiDocumentInput,
): WikiDocument {
  const d = db as {
    prepare: (sql: string) => {
      run: (...args: unknown[]) => { lastInsertRowid: number | bigint };
      get: (...args: unknown[]) => unknown;
      all: (...args: unknown[]) => unknown[];
    };
    transaction: <T>(fn: () => T) => () => T;
  };

  const tagsJson = input.tags && input.tags.length > 0
    ? JSON.stringify(input.tags)
    : null;
  const now = new Date().toISOString();
  const tokenizedTitle = tokenizeCjk2Gram(input.title);
  const tokenizedContent = tokenizeCjk2Gram(input.content);

  const tx = d.transaction((): number => {
    const existing = d
      .prepare("SELECT id, version FROM wiki_documents WHERE path = ?")
      .get(input.path) as { id: number; version: number } | undefined;

    let id: number;
    if (existing) {
      id = existing.id;
      const newVersion = existing.version + 1;
      d.prepare(
        `UPDATE wiki_documents
            SET title = ?, content = ?, kind = ?, tags = ?, version = ?,
                tombstone = 0, updated_at = ?
          WHERE id = ?`,
      ).run(
        input.title,
        input.content,
        input.kind,
        tagsJson,
        newVersion,
        now,
        id,
      );
      // 清掉旧 FTS 行（external content FTS5 需要手动维护）
      d.prepare("DELETE FROM wiki_documents_fts WHERE rowid = ?").run(id);
    } else {
      const info = d
        .prepare(
          `INSERT INTO wiki_documents
             (path, title, content, kind, tags, version, tombstone, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)`,
        )
        .run(
          input.path,
          input.title,
          input.content,
          input.kind,
          tagsJson,
          now,
          now,
        );
      id = Number(info.lastInsertRowid);
    }

    // 写 FTS index（tokenized；原文由 JOIN wiki_documents 取）
    d.prepare(
      `INSERT INTO wiki_documents_fts (rowid, title, content, path)
       VALUES (?, ?, ?, ?)`,
    ).run(id, tokenizedTitle, tokenizedContent, input.path);

    return id;
  });

  const id = tx();

  const row = d
    .prepare(
      `SELECT id, path, title, content, kind, tags, version, tombstone, created_at, updated_at
         FROM wiki_documents WHERE id = ?`,
    )
    .get(id) as WikiDocumentRow;
  return rowToDocument(row);
}

/**
 * 按 path 取单个 document（tombstone=0 过滤）。
 * 返回 null 表示不存在或已软删。
 */
export function getDocumentByPath(
  db: WikiDatabase,
  path: string,
): WikiDocument | null {
  const d = db as {
    prepare: (sql: string) => { get: (...args: unknown[]) => unknown };
  };
  const row = d
    .prepare(
      `SELECT id, path, title, content, kind, tags, version, tombstone, created_at, updated_at
         FROM wiki_documents
        WHERE path = ? AND tombstone = 0`,
    )
    .get(path) as WikiDocumentRow | undefined;
  if (!row) return null;
  return rowToDocument(row);
}

/**
 * FTS 搜索。
 *   - 输入原始 query（中英混合）
 *   - 空 query 或全是无效字符 → 返回 []
 *   - 可选 kind 过滤 / topK（默认 10）
 *   - tombstone=0 过滤
 */
export function searchByFts(
  db: WikiDatabase,
  query: string,
  options: WikiSearchOptions = {},
): WikiSearchHit[] {
  const d = db as {
    prepare: (sql: string) => { all: (...args: unknown[]) => unknown[] };
  };

  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) return [];

  const topK = options.topK ?? 10;

  try {
    const baseSql = `
      SELECT w.id, w.path, w.title, w.content, w.kind, fts.rank
        FROM wiki_documents_fts fts
        JOIN wiki_documents w ON w.id = fts.rowid
       WHERE wiki_documents_fts MATCH ?
         AND w.tombstone = 0
    `;
    let rows: unknown[];
    if (options.kind) {
      rows = d
        .prepare(`${baseSql} AND w.kind = ? ORDER BY fts.rank LIMIT ?`)
        .all(ftsQuery, options.kind, topK);
    } else {
      rows = d
        .prepare(`${baseSql} ORDER BY fts.rank LIMIT ?`)
        .all(ftsQuery, topK);
    }
    return (rows as WikiSearchHitRow[]).map((r) => ({
      id: r.id,
      path: r.path,
      title: r.title,
      content: r.content,
      kind: r.kind as DocumentKind,
      rank: r.rank,
    }));
  } catch (err) {
    console.warn("[wiki-store] searchByFts failed:", err);
    return [];
  }
}

/**
 * Soft delete：tombstone=1，同时从 FTS 索引里清掉 rowid 避免命中。
 * @returns 是否找到并删除了 row
 */
export function softDeleteByPath(db: WikiDatabase, path: string): boolean {
  const d = db as {
    prepare: (sql: string) => {
      run: (...args: unknown[]) => { changes: number };
      get: (...args: unknown[]) => unknown;
    };
    transaction: <T>(fn: () => T) => () => T;
  };

  const tx = d.transaction((): boolean => {
    const row = d
      .prepare(
        "SELECT id FROM wiki_documents WHERE path = ? AND tombstone = 0",
      )
      .get(path) as { id: number } | undefined;
    if (!row) return false;

    const now = new Date().toISOString();
    d.prepare(
      "UPDATE wiki_documents SET tombstone = 1, updated_at = ? WHERE id = ?",
    ).run(now, row.id);
    d.prepare("DELETE FROM wiki_documents_fts WHERE rowid = ?").run(row.id);
    return true;
  });

  return tx();
}

// ---------------------------------------------------------------------------
// 内部 helpers
// ---------------------------------------------------------------------------

interface WikiDocumentRow {
  id: number;
  path: string;
  title: string;
  content: string;
  kind: string;
  tags: string | null;
  version: number;
  tombstone: number;
  created_at: string;
  updated_at: string;
}

interface WikiSearchHitRow {
  id: number;
  path: string;
  title: string;
  content: string;
  kind: string;
  rank: number;
}

function rowToDocument(row: WikiDocumentRow): WikiDocument {
  return {
    id: row.id,
    path: row.path,
    title: row.title,
    content: row.content,
    kind: row.kind as DocumentKind,
    tags: row.tags ? (JSON.parse(row.tags) as string[]) : [],
    version: row.version,
    tombstone: row.tombstone === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
