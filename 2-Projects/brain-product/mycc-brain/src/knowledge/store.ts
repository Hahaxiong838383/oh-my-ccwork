/**
 * store.ts — 外挂知识系统的 SQLite 存储层
 *
 * 独立于 memory.db 的 knowledge.db，绝不共用连接。
 * Schema：knowledge_items + FTS5 external-content 虚表（无 triggers）。
 * 设计决策：
 *   - **无全局单例**：Database 作为参数传入，测试可用 `:memory:`。
 *   - **lazy driver load**：better-sqlite3 运行时 import，避免 ESM 静态解析。
 *   - **append-only 写入 + soft delete**：tombstone=1 代替 DELETE，保留审计轨迹。
 *   - **不引入 sqlite-vec**：Spike 阶段纯 FTS5，向量检索留给 P1。
 *   - **v0.12.3：中文 2-gram 预分词**：better-sqlite3 打包的 SQLite 没编译 FTS5_TRIGRAM，
 *     unicode61 tokenizer 把无空格中文当 1 个巨 token → 纯中文 query 召回率 0。
 *     解决：写端把中文 content 切成 2-gram 滑窗（外加单字备份）空格分隔后存入 FTS index；
 *     读端把 query 切成 2-gram 用 OR 拼接 phrase 查询。external content 表仍存原文，
 *     SELECT 时 JOIN knowledge_items 拿 `k.content`（原文），index 和原文解耦。
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

/**
 * v0.12.3：中文 2-gram 预分词。
 *
 * 把 text 切成空格分隔的 tokens：
 *   - 连续 ASCII 段保持完整（Futurus / SOP / 2026 等）
 *   - 连续中文段按 2-gram 滑窗切 + 单字备份（"公司战略" → "公司 公 司战 司 战略 战"）
 *   - 其他字符当分隔符
 * 存入 FTS index 后，unicode61 按空格切出 tokens，MATCH 能命中纯中文 query。
 */
export function tokenizeChineseForFts(text: string): string {
  if (!text) return "";
  const out: string[] = [];
  const isChinese = (c: string): boolean =>
    /[\u4e00-\u9fff\u3400-\u4dbf]/.test(c);
  let ascii = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (isChinese(c)) {
      if (ascii) {
        out.push(ascii);
        ascii = "";
      }
      // 2-gram 滑窗
      if (i + 1 < text.length && isChinese(text[i + 1])) {
        out.push(text.slice(i, i + 2));
      }
      out.push(c); // 单字备份，防止孤字 query 漏召
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
 * v0.12.4：中文停用词（bigram 级别）。用于 buildKnowledgeFtsQuery 前置过滤。
 *
 * 背景：v0.12.3 用 bigram OR 拼 phrase，川哥的 query "测试一下我公司是干什么的有什么能耐"
 * 生成的 13 个 bigram 全是虚词（"测试/试一/是干/干什/..."），FTS 只能靠"公司"1 个
 * bigram 召回一堆弱相关 doc，rank 没参考意义。
 *
 * 策略：把口语助词、代词、虚词构成的 bigram 从 query phrase set 里剔除，
 * 让剩下的 phrase 更贴近 query 的"业务实词"。过滤后如果 phrase 太少，
 * 整个 query 视为"无意图"，knowledgeFtsSearch 直接返回空。
 */
const CHINESE_QUERY_STOPWORDS: ReadonlySet<string> = new Set([
  // 测试/问答口语
  "测试", "试一", "一下", "看看", "瞧瞧", "告诉", "诉我",
  // 疑问助词
  "什么", "怎么", "么样", "是不", "不是", "有没", "没有", "是否", "可不",
  "能不", "行不",
  // 代词组合
  "我的", "你的", "他的", "她的", "它的", "我在", "你在", "他在", "她是",
  "我是", "你是", "他是", "我公", "你公", "我有", "你有", "有什",
  // 虚词连接
  "是干", "干什", "么的", "有的", "的是", "是的", "了的", "的了",
  "有多", "多少", "多么", "能耐", "么能", "的能",
  // 常见句尾
  "吗的", "呢的", "了吗", "了吧", "的吗", "的吧",
  // 其他高频虚词组合
  "但是", "因为", "所以", "然后", "那么", "那个", "这个", "这里", "那里",
]);

/**
 * 默认 rank 绝对阈值：FTS 的 rank 必须 < 此值才保留（越负越相关）。
 *
 * 实测发现 BM25 rank 在**小数据集**下会退化到 ~-1e-6（几乎 0 但确实是负数），
 * 例如 knowledge_items.db 只有 1-5 行时，单匹配 rank ≈ -1.375e-6。
 * 这意味着 rank 绝对阈值**不可靠** — 取 -0.1 会误杀小库所有结果，
 * 取 0 则等于没设阈值。结论：rank 阈值默认设为 0（放行所有负数），
 * 真正的过滤靠 effectiveBigrams 数量门 + min_match ratio。
 *
 * env `KNOWLEDGE_RANK_MAX` 仍保留，给大库场景做进一步收紧用。
 */
const KNOWLEDGE_RANK_MAX_DEFAULT = 0;

/**
 * 默认 min_match ratio：命中的有效 bigram 数 / query 有效 bigram 总数 必须 ≥ 此值。
 * 0.4 意味着短 query（例如 2 个 bigram）至少命中 1 个；长 query（10 个 bigram）至少命中 4 个。
 * 这是 v0.12.3 bigram OR 污染的最后一道门。
 */
const KNOWLEDGE_MIN_MATCH_RATIO_DEFAULT = 0.4;

function getKnowledgeRankMax(): number {
  const raw = process.env.KNOWLEDGE_RANK_MAX;
  if (!raw) return KNOWLEDGE_RANK_MAX_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) ? n : KNOWLEDGE_RANK_MAX_DEFAULT;
}

function getKnowledgeMinMatchRatio(): number {
  const raw = process.env.KNOWLEDGE_MIN_MATCH_RATIO;
  if (!raw) return KNOWLEDGE_MIN_MATCH_RATIO_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1
    ? n
    : KNOWLEDGE_MIN_MATCH_RATIO_DEFAULT;
}

/**
 * 内部 helper：提取 query 的有效 bigrams（已过滤停用词和低价值 token）。
 *
 * 返回 `{ ftsQuery, effectiveBigrams, rawBigramsCount }`：
 *   - ftsQuery 是 FTS5 MATCH 使用的字符串
 *   - effectiveBigrams 是过滤后的 bigram 集合（去停用词），用于 post-filter
 *   - rawBigramsCount 是停用词过滤前的 bigram 总数，用于判断 query 是"短精准"还是"长口语化"
 *
 * v0.12.4 引入，用于替代 v0.12.3 的 buildKnowledgeFtsQuery 内部逻辑。
 */
function extractKnowledgeQueryTokens(rawQuery: string): {
  readonly ftsQuery: string;
  readonly effectiveBigrams: readonly string[];
  readonly rawBigramsCount: number;
} {
  const cleaned = rawQuery
    .replace(
      /[.*+\-"(){}[\]^~:@#$%&\\|<>=!?,;，。！？、；：""''（）【】《》]/g,
      " ",
    )
    .trim();
  if (!cleaned) return { ftsQuery: "", effectiveBigrams: [], rawBigramsCount: 0 };
  const isChinese = (c: string): boolean =>
    /[\u4e00-\u9fff\u3400-\u4dbf]/.test(c);
  const seen = new Set<string>();
  const phrases: string[] = [];
  const effective: string[] = [];
  let rawBigramsCount = 0;
  for (const seg of cleaned.split(/\s+/)) {
    if (!seg) continue;
    if (/^[A-Za-z0-9_.\-]+$/.test(seg)) {
      // 纯 ASCII（Futurus / 2026 / SOP） → 作为独立 phrase，不进停用词过滤
      if (!seen.has(seg)) {
        phrases.push(seg);
        effective.push(seg); // ASCII 强信号，计入有效 bigram
        seen.add(seg);
        rawBigramsCount += 1;
      }
      continue;
    }
    // 含中文：按 2-gram 滑窗
    for (let i = 0; i <= seg.length - 2; i++) {
      const g = seg.slice(i, i + 2);
      if (!isChinese(g[0]) || !isChinese(g[1])) continue;
      if (seen.has(g)) continue;
      seen.add(g);
      rawBigramsCount += 1;
      phrases.push(g); // FTS query 仍使用所有 bigram（保证写端能找到任何边缘匹配）
      if (!CHINESE_QUERY_STOPWORDS.has(g)) {
        effective.push(g); // 有效 bigram 只包含非停用词
      }
    }
  }
  if (phrases.length === 0) return { ftsQuery: "", effectiveBigrams: [], rawBigramsCount: 0 };
  const ftsQuery = phrases.map((p) => `"${p}"`).join(" OR ");
  return { ftsQuery, effectiveBigrams: effective, rawBigramsCount };
}

/**
 * v0.12.3：把用户 query 转成 FTS5 MATCH 字符串（2-gram OR 策略）。
 * v0.12.4：内部委托给 extractKnowledgeQueryTokens，停用词过滤在 post-filter 阶段生效。
 *
 * 保留 signature 不变以兼容外部调用（测试、调试工具）。
 */
export function buildKnowledgeFtsQuery(rawQuery: string): string {
  return extractKnowledgeQueryTokens(rawQuery).ftsQuery;
}

/** v0.12.3：knowledge.db schema 版本。< 此值时 openKnowledgeDB 重建 FTS index。 */
const KNOWLEDGE_FTS_SCHEMA_VERSION = 2;

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

  -- v0.12.3：删除了 knowledge_ai/ad/au triggers。FTS index 写入改为 store 代码显式管理
  -- （insertKnowledgeItem / maybeRebuildKnowledgeFts）。原因：SQL trigger 无法调 JS 端
  -- 中文分词函数，只能在应用层把 content 预分词后写入 FTS。soft delete 不清 FTS index，
  -- 查询端 JOIN knowledge_items 用 tombstone=0 过滤。

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
  // v0.12.3：如果 FTS schema 版本落后（例如旧 unicode61 原文 index），重建 FTS
  maybeRebuildKnowledgeFts(db);
  return db;
}

/**
 * v0.12.3：检测并重建 FTS index（如果 schema 版本落后）。
 * 使用 SQLite `PRAGMA user_version` 追踪版本。旧库升级时跑一次全量 reindex（~ms 级）。
 */
export function maybeRebuildKnowledgeFts(db: KnowledgeDatabase): boolean {
  const h = db as DbHandle & {
    exec: (s: string) => void;
  };
  const versionRow = h.prepare("PRAGMA user_version").get() as
    | { user_version: number }
    | undefined;
  const current = versionRow?.user_version ?? 0;
  if (current >= KNOWLEDGE_FTS_SCHEMA_VERSION) return false;
  const rows = h
    .prepare(
      `SELECT id, namespace, content, keywords FROM knowledge_items WHERE tombstone = 0`,
    )
    .all() as Array<{
    id: number;
    namespace: string;
    content: string;
    keywords: string;
  }>;
  // 先清 FTS（external content delete-all 语法）
  try {
    h.exec(`INSERT INTO knowledge_fts(knowledge_fts) VALUES ('delete-all')`);
  } catch {
    // 如果新库尚无数据，delete-all 可能失败——忽略
  }
  const ins = h.prepare(
    `INSERT INTO knowledge_fts(rowid, namespace, content, keywords) VALUES (?, ?, ?, ?)`,
  );
  const tx = h.transaction((items: typeof rows) => {
    for (const r of items) {
      ins.run(
        r.id,
        tokenizeChineseForFts(r.namespace),
        tokenizeChineseForFts(r.content),
        tokenizeChineseForFts(r.keywords),
      );
    }
  });
  tx(rows);
  h.exec(`PRAGMA user_version = ${KNOWLEDGE_FTS_SCHEMA_VERSION}`);
  if (rows.length > 0) {
    console.log(
      `[knowledge-store] FTS reindex v${current} → v${KNOWLEDGE_FTS_SCHEMA_VERSION}: ${rows.length} items`,
    );
  }
  return true;
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
  const keywordsJson = JSON.stringify(input.keywords);
  const info = stmt.run(
    input.docToken,
    input.docTitle,
    input.spaceId,
    input.namespace,
    input.content,
    keywordsJson,
    input.confidence,
    input.sourceUrl,
    input.extractedBy,
    Date.now(),
  );
  const id = Number(info.lastInsertRowid);
  // v0.12.3：显式写 FTS index（预分词）。原 trigger 已删除。
  const fts = h.prepare(
    `INSERT INTO knowledge_fts(rowid, namespace, content, keywords) VALUES (?, ?, ?, ?)`,
  );
  fts.run(
    id,
    tokenizeChineseForFts(input.namespace),
    tokenizeChineseForFts(input.content),
    tokenizeChineseForFts(keywordsJson),
  );
  return id;
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

/**
 * 关键词召回；tombstone=1 自动过滤。
 *
 * v0.12.4 加入三层 post-filter（对抗 v0.12.3 bigram OR 污染）：
 *   1. 绝对 rank 阈值：rank > KNOWLEDGE_RANK_MAX（默认 -3.5）的 hit 丢弃
 *   2. min_match 有效 bigram 比例：命中的 effective bigrams / query 总 effective bigrams 需 ≥ KNOWLEDGE_MIN_MATCH_RATIO（默认 0.4）
 *   3. stopword 过滤：query 里全是虚词 bigram 时，effective bigrams 为空 → 整个 query 视为"无意图"，返回空
 *
 * 阈值均可通过 env 覆盖：KNOWLEDGE_RANK_MAX / KNOWLEDGE_MIN_MATCH_RATIO
 */
export function knowledgeFtsSearch(
  db: KnowledgeDatabase,
  query: string,
  topK = 10,
): readonly KnowledgeSearchHit[] {
  // v0.12.3/v0.12.4：使用 2-gram OR 构造 FTS MATCH query 并提取有效 bigrams
  const { ftsQuery, effectiveBigrams, rawBigramsCount } = extractKnowledgeQueryTokens(query);
  if (!ftsQuery) return [];
  // v0.12.4：query 里全是停用词 bigram → 无意图，直接 bail（避免污染）
  if (effectiveBigrams.length === 0) {
    return [];
  }
  // v0.12.4：effective bigrams 数量门。
  // 规则（按短/长 query 区分）：
  //   - ASCII token ≥ 1（例如 "SQLite"/"Futurus"/"HUD"）→ 通过
  //   - 短 query（rawBigrams ≤ 3，例如 "部署"/"愿景"）→ 至少 1 个有效 bigram 即通过（精准短查询）
  //   - 长 query（rawBigrams > 3，例如川哥的 13-bigram 口语化 query）→ 至少 2 个有效 bigram
  //     原因：长 query 若过滤停用词后只剩 1 个 bigram，说明 query 90%+ 是虚词，意图不明确
  const isAsciiToken = (b: string): boolean => /^[A-Za-z0-9_.\-]+$/.test(b);
  const asciiCount = effectiveBigrams.filter(isAsciiToken).length;
  const chineseBigramCount = effectiveBigrams.length - asciiCount;
  if (asciiCount === 0) {
    const minRequired = rawBigramsCount <= 3 ? 1 : 2;
    if (chineseBigramCount < minRequired) {
      return [];
    }
  }
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
    // v0.12.4：先取 topK*3（最多 30）给 post-filter 留余地，再精排
    const rawLimit = Math.min(30, Math.max(topK * 3, topK));
    const rows = stmt.all(ftsQuery, rawLimit) as Array<{
      id: number;
      namespace: string;
      content: string;
      doc_title: string;
      source_url: string;
      rank: number;
    }>;
    const rankMax = getKnowledgeRankMax();
    const minMatchRatio = getKnowledgeMinMatchRatio();
    const minMatchCount = Math.max(
      1,
      Math.floor(effectiveBigrams.length * minMatchRatio),
    );
    const filtered: KnowledgeSearchHit[] = [];
    // v0.12.4：post-filter 使用小写匹配（FTS unicode61 默认大小写不敏感，
    // JS includes 大小写敏感，需要在 JS 层也做折叠才能和 FTS 一致）。
    const loweredBigrams = effectiveBigrams.map((b) => b.toLowerCase());
    for (const r of rows) {
      // 门 1：rank 绝对阈值
      if (r.rank > rankMax) continue;
      // 门 2：min_match 有效 bigram 命中数（大小写不敏感）
      const haystack = `${r.namespace}\n${r.content}`.toLowerCase();
      let matchCount = 0;
      for (const bg of loweredBigrams) {
        if (haystack.includes(bg)) {
          matchCount += 1;
          if (matchCount >= minMatchCount) break;
        }
      }
      if (matchCount < minMatchCount) continue;
      filtered.push({
        id: r.id,
        namespace: r.namespace,
        content: r.content,
        docTitle: r.doc_title,
        sourceUrl: r.source_url,
        rank: r.rank,
      });
      if (filtered.length >= topK) break;
    }
    return filtered;
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

// ---------------------------------------------------------------------------
// Admin 面板专用只读 query helpers（2026-04-11 v0.12.0 Admin UI 知识库面板）
// 所有函数都加 tombstone=0 过滤（除非明确说明）
// ---------------------------------------------------------------------------

/** 单条 knowledge_item 的面向 Admin 的序列化视图 */
export interface KnowledgeItemView {
  readonly id: number;
  readonly docToken: string;
  readonly docTitle: string;
  readonly namespace: string;
  readonly content: string;
  readonly keywords: readonly string[];
  readonly confidence: number;
  readonly sourceUrl: string;
  readonly createdAt: number;
}

function rowToKnowledgeItemView(row: Record<string, unknown>): KnowledgeItemView {
  let keywords: readonly string[] = [];
  try {
    const parsed = JSON.parse(row.keywords as string);
    if (Array.isArray(parsed)) keywords = parsed.map((k) => String(k));
  } catch {
    /* ignore malformed */
  }
  return {
    id: row.id as number,
    docToken: row.doc_token as string,
    docTitle: row.doc_title as string,
    namespace: row.namespace as string,
    content: row.content as string,
    keywords,
    confidence: row.confidence as number,
    sourceUrl: row.source_url as string,
    createdAt: row.created_at as number,
  };
}

const ITEM_COLS =
  "id, doc_token, doc_title, namespace, content, keywords, confidence, source_url, created_at";

/** 按 docToken 列 items（tombstone=0） */
export function listItemsByDocToken(
  db: KnowledgeDatabase,
  docToken: string,
  limit = 50,
): readonly KnowledgeItemView[] {
  const h = db as DbHandle;
  const rows = h
    .prepare(
      `SELECT ${ITEM_COLS} FROM knowledge_items WHERE doc_token = ? AND tombstone = 0 ORDER BY id ASC LIMIT ?`,
    )
    .all(docToken, limit) as Array<Record<string, unknown>>;
  return rows.map(rowToKnowledgeItemView);
}

/** 按 namespace 前缀列 items（tombstone=0） */
export function listItemsByNamespace(
  db: KnowledgeDatabase,
  namespacePrefix: string,
  limit = 50,
): readonly KnowledgeItemView[] {
  const h = db as DbHandle;
  const rows = h
    .prepare(
      `SELECT ${ITEM_COLS} FROM knowledge_items WHERE namespace LIKE ? AND tombstone = 0 ORDER BY id DESC LIMIT ?`,
    )
    .all(`${namespacePrefix}%`, limit) as Array<Record<string, unknown>>;
  return rows.map(rowToKnowledgeItemView);
}

/** 按 namespace 聚合 count，按降序返回 top N */
export function topNamespaces(
  db: KnowledgeDatabase,
  limit = 10,
): ReadonlyArray<{ readonly namespace: string; readonly count: number }> {
  const h = db as DbHandle;
  const rows = h
    .prepare(
      `SELECT namespace, COUNT(*) AS n FROM knowledge_items WHERE tombstone = 0 GROUP BY namespace ORDER BY n DESC LIMIT ?`,
    )
    .all(limit) as Array<{ namespace: string; n: number }>;
  return rows.map((r) => ({ namespace: r.namespace, count: r.n }));
}

/** 按 doc_sync_state.status 聚合计数 */
export function countByDocSyncStatus(
  db: KnowledgeDatabase,
): Readonly<Record<DocSyncState["status"], number>> {
  const h = db as DbHandle;
  const rows = h
    .prepare(`SELECT status, COUNT(*) AS n FROM doc_sync_state GROUP BY status`)
    .all() as Array<{ status: string; n: number }>;
  const result: Record<string, number> = { pending: 0, synced: 0, extracted: 0, failed: 0 };
  for (const r of rows) result[r.status] = r.n;
  return result as Readonly<Record<DocSyncState["status"], number>>;
}

/** 列 doc_sync_state（可选 status 筛选 + 分页） */
export function listAllDocSync(
  db: KnowledgeDatabase,
  opts: {
    readonly status?: DocSyncState["status"];
    readonly limit?: number;
    readonly offset?: number;
  } = {},
): readonly DocSyncState[] {
  const h = db as DbHandle;
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  const rows = opts.status
    ? (h
        .prepare(
          `SELECT ${DOC_SYNC_COLUMNS} FROM doc_sync_state WHERE status = ? ORDER BY last_synced_at DESC LIMIT ? OFFSET ?`,
        )
        .all(opts.status, limit, offset) as Array<Record<string, unknown>>)
    : (h
        .prepare(
          `SELECT ${DOC_SYNC_COLUMNS} FROM doc_sync_state ORDER BY last_synced_at DESC LIMIT ? OFFSET ?`,
        )
        .all(limit, offset) as Array<Record<string, unknown>>);
  return rows.map(rowToDocSyncState);
}

/** 单 doc 的 items 数（tombstone=0） */
export function countItemsByDocToken(db: KnowledgeDatabase, docToken: string): number {
  const h = db as DbHandle;
  const row = h
    .prepare(
      `SELECT COUNT(*) AS n FROM knowledge_items WHERE doc_token = ? AND tombstone = 0`,
    )
    .get(docToken) as { n: number };
  return row.n;
}

/** 按天聚合 items 创建数（近 N 天，包含今天；YYYY-MM-DD） */
export function dailyItemTrend(
  db: KnowledgeDatabase,
  days = 7,
): ReadonlyArray<{ readonly date: string; readonly count: number }> {
  const h = db as DbHandle;
  const now = Date.now();
  const startMs = now - days * 24 * 60 * 60 * 1000;
  const rows = h
    .prepare(
      `SELECT created_at FROM knowledge_items WHERE tombstone = 0 AND created_at >= ?`,
    )
    .all(startMs) as Array<{ created_at: number }>;
  // 初始化近 days 天的桶
  const buckets = new Map<string, number>();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    buckets.set(key, 0);
  }
  for (const r of rows) {
    const key = new Date(r.created_at).toISOString().slice(0, 10);
    if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  return Array.from(buckets.entries()).map(([date, count]) => ({ date, count }));
}

/** 最近一次 sync 成功的时间戳（取 last_synced_at 最大值） */
export function lastSyncedAt(db: KnowledgeDatabase): number {
  const h = db as DbHandle;
  const row = h
    .prepare(`SELECT MAX(last_synced_at) AS ts FROM doc_sync_state`)
    .get() as { ts: number | null };
  return row.ts ?? 0;
}

/**
 * 标记单 doc 为 pending（让下次 cron 重爬）；返回 { changed, prevStatus }
 *
 * v0.12.4 修复 Codex HIGH 1：原实现只改 doc_sync_state.status，
 * 但 knowledgeFtsSearch 仅按 knowledge_items.tombstone=0 过滤，
 * 导致 stale 文档继续污染召回。新实现在同一事务里 tombstone=1
 * 所有 items，让旧 fact 真正下线，直到 cron 重爬回写新 rows。
 */
export function markDocStale(
  db: KnowledgeDatabase,
  docToken: string,
): { readonly changed: boolean; readonly prevStatus: DocSyncState["status"] | null } {
  const cur = getDocSyncState(db, docToken);
  if (!cur) return { changed: false, prevStatus: null };
  if (cur.status === "pending") return { changed: false, prevStatus: "pending" };
  const h = db as DbHandle;
  const updateDoc = h.prepare(
    `UPDATE doc_sync_state SET status = 'pending', error_message = '' WHERE doc_token = ?`,
  );
  const tombstoneItems = h.prepare(
    `UPDATE knowledge_items SET tombstone = 1 WHERE doc_token = ? AND tombstone = 0`,
  );
  let docChanged = false;
  const tx = h.transaction((tok: string) => {
    const info = updateDoc.run(tok);
    docChanged = info.changes > 0;
    tombstoneItems.run(tok);
  });
  tx(docToken);
  return { changed: docChanged, prevStatus: cur.status };
}
