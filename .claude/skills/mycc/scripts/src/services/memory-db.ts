/**
 * 记忆系统 SQLite 统一存储 v5.5
 *
 * 架构：md 文件是主数据源（人类可编辑），SQLite 是派生索引（自动重建）。
 * - memory-items.md 编辑后 → 检测 mtime 变更 → 重建 items + FTS5 + vectors
 * - 对话记忆、检索轨迹 → 直接写 SQLite（程序产生，无需 md 备份）
 *
 * 技术选型：
 * - better-sqlite3：同步 API，零 ORM 开销
 * - sqlite-vec：cosine KNN 向量搜索
 * - FTS5：全文检索（items + traces）
 * - WAL 模式：支持并发读
 *
 * 降级：SQLite 不可用时回退到文件读取（context-loader / chat-memory 的 v4 逻辑）
 */

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { readFileSync, existsSync, statSync } from "fs";
import * as path from "path";

// ============================================================
// 类型定义
// ============================================================

export interface ItemRow {
  id: string;
  category: string;
  scope: string;        // user/project/agent/session
  content: string;
  stars: number;
  write_date: string | null;
  event_date: string | null;
  chain_type: string | null;
  chain_ref: string | null;
}

export interface CentroidRow {
  category: string;
  scope: string;
  item_count: number;
  l0_summary: string | null;
}

export interface VectorRow {
  id: string;
  distance: number;
}

export interface TraceRow {
  id: number;
  timestamp: string;
  query: string;
  pipeline: string;
  rrf: string;
  injected: string;
  budget_used: number;
  budget_limit: number;
}

// ============================================================
// Schema
// ============================================================

const SCHEMA_SQL = `
-- 1. 原子记忆条目（派生自 memory-items.md）
CREATE TABLE IF NOT EXISTS items (
  id          TEXT PRIMARY KEY,
  category    TEXT NOT NULL,
  scope       TEXT NOT NULL DEFAULT 'project',  -- user/project/agent/session
  content     TEXT NOT NULL,
  stars       INTEGER DEFAULT 0,
  write_date  TEXT,
  event_date  TEXT,
  chain_type  TEXT,
  chain_ref   TEXT,
  created_at  TEXT DEFAULT (datetime('now')),
  updated_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_items_category ON items(category);
CREATE INDEX IF NOT EXISTS idx_items_scope ON items(scope);

-- FTS5 全文索引
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  id UNINDEXED, content, category, tokenize='unicode61'
);

-- 2. 对话记忆
CREATE TABLE IF NOT EXISTS conversations (
  chat_id     TEXT PRIMARY KEY,
  updated_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dag_nodes (
  id           TEXT PRIMARY KEY,
  chat_id      TEXT NOT NULL,
  level        INTEGER NOT NULL,
  source_start INTEGER NOT NULL,
  source_end   INTEGER NOT NULL,
  summary      TEXT NOT NULL,
  token_count  INTEGER DEFAULT 0,
  is_root      INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_dag_chat ON dag_nodes(chat_id);

CREATE TABLE IF NOT EXISTS dag_edges (
  parent_id TEXT NOT NULL,
  child_id  TEXT NOT NULL,
  PRIMARY KEY (parent_id, child_id)
);

CREATE TABLE IF NOT EXISTS chat_facts (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id  TEXT NOT NULL,
  fact     TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_facts_chat ON chat_facts(chat_id);

CREATE TABLE IF NOT EXISTS chat_summaries (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id  TEXT NOT NULL,
  summary  TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_summaries_chat ON chat_summaries(chat_id);

-- 3. 检索轨迹
CREATE TABLE IF NOT EXISTS traces (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp  TEXT NOT NULL,
  query      TEXT,
  pipeline   TEXT,
  rrf        TEXT,
  injected   TEXT,
  budget_used INTEGER,
  budget_limit INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS traces_fts USING fts5(
  query, tokenize='unicode61'
);

-- 4. 事件流（派生自 RECENT_EVENTS.md）
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_date TEXT NOT NULL,
  event_time TEXT,
  content    TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_date ON events(event_date);

-- 5. 元数据（跟踪源文件 mtime，判断是否需要重建）
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- 6. L0 类别中心向量（centroid = 类别内所有 item 向量的均值）
-- 用途：粗筛阶段用 centroid 快速定位相关类别（20 次 float32 vs 274 次）
-- 后续 RaBitQ 阶段三依赖此表做第一层过滤
CREATE TABLE IF NOT EXISTS centroids (
  category        TEXT PRIMARY KEY,
  scope           TEXT NOT NULL DEFAULT 'project',
  centroid_vector BLOB,           -- float32[512]，类别均值向量
  item_count      INTEGER,
  l0_summary      TEXT,           -- 预生成的 L0 概览文本
  updated_at      TEXT DEFAULT (datetime('now'))
);
`;

// sqlite-vec 虚拟表需要单独创建（不能放在多语句 exec 里）
const VEC_TABLE_SQL = `CREATE VIRTUAL TABLE IF NOT EXISTS items_vec USING vec0(
  id TEXT PRIMARY KEY,
  embedding float[512] distance_metric=cosine
)`;

// ============================================================
// 连接管理
// ============================================================

let _db: Database.Database | null = null;
let _dbPath: string = "";

/**
 * 获取 SQLite 数据库连接（单例）。
 * 不可用时返回 null，调用方回退到文件逻辑。
 */
export function getDB(cwd: string): Database.Database | null {
  const dbPath = path.join(cwd, "0-System/memory.db");

  if (_db && _dbPath === dbPath) return _db;

  try {
    const db = new Database(dbPath);

    // 加载 sqlite-vec 扩展
    sqliteVec.load(db);

    // WAL 模式 + 性能优化
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("cache_size = -8000"); // 8MB cache
    db.pragma("busy_timeout = 5000");

    // 创建 schema
    db.exec(SCHEMA_SQL);
    db.exec(VEC_TABLE_SQL);

    _db = db;
    _dbPath = dbPath;
    console.log("[MemoryDB] SQLite 连接就绪:", dbPath);
    return db;
  } catch (err) {
    console.warn("[MemoryDB] SQLite 初始化失败，降级到文件模式:", err);
    return null;
  }
}

/**
 * 关闭数据库连接（进程退出时调用）
 */
export function closeDB(): void {
  if (_db) {
    _db.close();
    _db = null;
    _dbPath = "";
    console.log("[MemoryDB] SQLite 连接已关闭");
  }
}

// ============================================================
// md → SQLite 同步（items + vectors）
// ============================================================

/** 从 item 行解析元数据 */
function parseItemLine(line: string, category: string, idx: number): ItemRow {
  // 星级
  const starCount = (line.match(/★/g) || []).length;

  // 写入日期 [YYYY-MM-DD]（排除 event: 前缀）
  const writeDateMatch = line.match(/(?<!\bevent:)\[(\d{4}-\d{2}-\d{2})\]/);
  const writeDate = writeDateMatch ? writeDateMatch[1] : null;

  // 事件日期 [event:YYYY-MM-DD]
  const eventDateMatch = line.match(/\[event:(\d{4}-\d{2}-\d{2})\]/);
  const eventDate = eventDateMatch ? eventDateMatch[1] : null;

  // 残差版本链
  let chainType: string | null = null;
  let chainRef: string | null = null;
  if (line.includes("#base")) {
    chainType = "base";
  } else if (line.includes("→Δ:")) {
    chainType = "delta";
    const m = line.match(/→Δ:(.+?)(?:\s*\[|\s*#|\s*$)/);
    chainRef = m ? m[1].trim() : null;
  } else if (line.includes("→supersedes:")) {
    chainType = "supersedes";
    const m = line.match(/→supersedes:(.+?)(?:\s*\[|\s*#|\s*$)/);
    chainRef = m ? m[1].trim() : null;
  } else if (line.includes("→updates:")) {
    chainType = "supersedes"; // 向后兼容
    const m = line.match(/→updates:(.+?)(?:\s*\[|\s*#|\s*$)/);
    chainRef = m ? m[1].trim() : null;
  }

  // scope：从 category 前缀提取（user/偏好 → "user"）
  const scope = category.split("/")[0] || "project";

  // ID：category + index（稳定 ID，重建时不变）
  const id = `${category}:${idx}`;

  return {
    id,
    category,
    scope,
    content: line.replace(/^-\s*/, "").trim(),
    stars: starCount,
    write_date: writeDate,
    event_date: eventDate,
    chain_type: chainType,
    chain_ref: chainRef,
  };
}

/**
 * 从 memory-items.md 同步到 SQLite items 表。
 * 检测 mtime 变更，仅在文件被编辑后重建。
 */
export function syncItemsFromMd(cwd: string): boolean {
  const db = getDB(cwd);
  if (!db) return false;

  const mdPath = path.join(cwd, "0-System/memory-items.md");
  if (!existsSync(mdPath)) return false;

  // 检查 mtime
  const currentMtime = statSync(mdPath).mtimeMs.toString();
  const savedMtime = db.prepare("SELECT value FROM meta WHERE key = 'items_md_mtime'").get() as { value: string } | undefined;

  if (savedMtime && savedMtime.value === currentMtime) {
    return true; // 无变更，跳过
  }

  console.log("[MemoryDB] memory-items.md 变更，重建 items 表...");

  const content = readFileSync(mdPath, "utf-8");
  const sections = content.split(/^## /m).filter(Boolean);

  const items: ItemRow[] = [];
  for (const section of sections) {
    const headerMatch = section.match(/^\[([^\]]+)\]/);
    if (!headerMatch) continue;
    const category = headerMatch[1];

    const lines = section.split("\n").filter((l) => l.startsWith("- "));
    lines.forEach((line, idx) => {
      items.push(parseItemLine(line, category, idx));
    });
  }

  // 事务内全量重建
  const rebuild = db.transaction(() => {
    db.exec("DELETE FROM items");
    db.exec("DELETE FROM items_fts");

    const insertItem = db.prepare(
      "INSERT INTO items (id, category, scope, content, stars, write_date, event_date, chain_type, chain_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    const insertFts = db.prepare(
      "INSERT INTO items_fts (id, content, category) VALUES (?, ?, ?)"
    );

    for (const item of items) {
      insertItem.run(item.id, item.category, item.scope, item.content, item.stars, item.write_date, item.event_date, item.chain_type, item.chain_ref);
      insertFts.run(item.id, item.content, item.category);
    }

    // 更新 mtime
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('items_md_mtime', ?)").run(currentMtime);
  });

  rebuild();
  console.log(`[MemoryDB] items 表重建完成：${items.length} 条，${new Set(items.map((i) => i.category)).size} 个类别`);
  return true;
}

/**
 * 从 memory-vectors.json 同步到 SQLite items_vec 表。
 * 检测 mtime 变更，仅在文件被修改后重建。
 */
export function syncVectorsFromJson(cwd: string): boolean {
  const db = getDB(cwd);
  if (!db) return false;

  const vecPath = path.join(cwd, "0-System/memory-vectors.json");
  if (!existsSync(vecPath)) return false;

  const currentMtime = statSync(vecPath).mtimeMs.toString();
  const savedMtime = db.prepare("SELECT value FROM meta WHERE key = 'vectors_json_mtime'").get() as { value: string } | undefined;

  if (savedMtime && savedMtime.value === currentMtime) {
    return true;
  }

  console.log("[MemoryDB] memory-vectors.json 变更，重建 items_vec 表...");

  try {
    const raw = readFileSync(vecPath, "utf-8");
    const data = JSON.parse(raw) as {
      items: Array<{ id: string; category: string; text: string; stars: number; vector: number[] }>;
    };

    // sqlite-vec 虚拟表需要 DROP + CREATE 来清空
    db.exec("DROP TABLE IF EXISTS items_vec");
    db.exec(VEC_TABLE_SQL);

    const insertVec = db.prepare(
      "INSERT INTO items_vec (id, embedding) VALUES (?, ?)"
    );

    const rebuild = db.transaction(() => {
      for (const item of data.items) {
        // sqlite-vec 需要 Float32Array 的 Buffer
        const buf = Buffer.from(new Float32Array(item.vector).buffer);
        insertVec.run(item.id, buf);
      }

      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('vectors_json_mtime', ?)").run(currentMtime);
    });

    rebuild();

    // 向量重建后自动计算 centroids
    buildCentroids(db, data.items);

    console.log(`[MemoryDB] items_vec 表重建完成：${data.items.length} 条向量`);
    return true;
  } catch (err) {
    console.warn("[MemoryDB] 向量同步失败:", err);
    return false;
  }
}

/**
 * 计算每个类别的中心向量（centroid = 类别内所有向量的均值）。
 *
 * 用途：
 * 1. L0 粗筛：用 centroid 快速判断哪些类别与 query 相关（20 次比对 vs 274 次）
 * 2. 阶段三 RaBitQ：centroid 做第一层过滤
 */
function buildCentroids(
  db: Database.Database,
  items: Array<{ id: string; category: string; vector: number[] }>,
): void {
  // 按类别分组
  const catVecs = new Map<string, number[][]>();
  for (const item of items) {
    const vecs = catVecs.get(item.category) || [];
    vecs.push(item.vector);
    catVecs.set(item.category, vecs);
  }

  db.exec("DELETE FROM centroids");

  const insert = db.prepare(
    "INSERT INTO centroids (category, scope, centroid_vector, item_count, l0_summary) VALUES (?, ?, ?, ?, ?)"
  );

  const buildTx = db.transaction(() => {
    for (const [category, vectors] of catVecs) {
      const dim = vectors[0].length;
      const mean = new Float32Array(dim);

      // 求均值
      for (const vec of vectors) {
        for (let i = 0; i < dim; i++) {
          mean[i] += vec[i];
        }
      }
      for (let i = 0; i < dim; i++) {
        mean[i] /= vectors.length;
      }

      // L2 归一化（cosine 搜索需要单位向量）
      let norm = 0;
      for (let i = 0; i < dim; i++) {
        norm += mean[i] * mean[i];
      }
      norm = Math.sqrt(norm);
      if (norm > 0) {
        for (let i = 0; i < dim; i++) {
          mean[i] /= norm;
        }
      }

      const scope = category.split("/")[0] || "project";
      const buf = Buffer.from(mean.buffer);

      // L0 摘要暂存 null，由 context-loader 的 generateL0OverviewFromDB 填充
      insert.run(category, scope, buf, vectors.length, null);
    }
  });

  buildTx();
  console.log(`[MemoryDB] centroids 重建完成：${catVecs.size} 个类别`);
}

/**
 * 同步所有 md 源到 SQLite（启动时 + 定期调用）。
 */
export function syncAll(cwd: string): boolean {
  const itemsOk = syncItemsFromMd(cwd);
  const vecsOk = syncVectorsFromJson(cwd);
  return itemsOk && vecsOk;
}

// ============================================================
// 查询接口（供 context-loader 使用）
// ============================================================

/**
 * 按类别查询 items（替代从 md 文件 split section）
 */
export function getItemsByCategory(cwd: string, category: string): ItemRow[] {
  const db = getDB(cwd);
  if (!db) return [];

  return db.prepare("SELECT * FROM items WHERE category = ? ORDER BY stars DESC").all(category) as ItemRow[];
}

/**
 * 获取所有类别及其条目数（供 L0 概览生成）
 */
export function getCategorySummary(cwd: string): Array<{ category: string; count: number }> {
  const db = getDB(cwd);
  if (!db) return [];

  return db.prepare(
    "SELECT category, COUNT(*) as count FROM items GROUP BY category ORDER BY category"
  ).all() as Array<{ category: string; count: number }>;
}

/**
 * 用 centroid 向量做类别粗筛：返回与 query 向量最相似的类别。
 * 比逐条比对快（~20 次 vs ~274 次），后续精排只看命中类别的 items。
 */
export function centroidSearch(
  cwd: string,
  queryVec: number[],
  topK: number = 5,
): Array<{ category: string; similarity: number }> {
  const db = getDB(cwd);
  if (!db) return [];

  try {
    const rows = db.prepare(
      "SELECT category, centroid_vector FROM centroids WHERE centroid_vector IS NOT NULL"
    ).all() as Array<{ category: string; centroid_vector: Buffer }>;

    const results: Array<{ category: string; similarity: number }> = [];
    for (const row of rows) {
      const centroid = new Float32Array(row.centroid_vector.buffer, row.centroid_vector.byteOffset, 512);
      // cosine similarity（centroid 已归一化）
      let dot = 0, normQ = 0;
      for (let i = 0; i < 512; i++) {
        dot += queryVec[i] * centroid[i];
        normQ += queryVec[i] * queryVec[i];
      }
      const sim = normQ > 0 ? dot / Math.sqrt(normQ) : 0;
      if (sim > 0.2) {
        results.push({ category: row.category, similarity: sim });
      }
    }

    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, topK);
  } catch {
    return [];
  }
}

/**
 * FTS5 全文搜索 items
 */
export function searchItems(cwd: string, query: string, limit: number = 20): ItemRow[] {
  const db = getDB(cwd);
  if (!db) return [];

  try {
    return db.prepare(`
      SELECT i.* FROM items i
      JOIN items_fts f ON i.id = f.id
      WHERE items_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(query, limit) as ItemRow[];
  } catch {
    return []; // FTS5 查询语法错误时静默返回空
  }
}

/**
 * 向量 KNN 搜索（替代 embedding.ts 的 vectorSearch）
 */
export function vectorSearchDB(
  cwd: string,
  queryVec: number[],
  topK: number = 20,
): VectorRow[] {
  const db = getDB(cwd);
  if (!db) return [];

  try {
    const buf = Buffer.from(new Float32Array(queryVec).buffer);
    return db.prepare(`
      SELECT id, distance FROM items_vec
      WHERE embedding MATCH ? AND k = ?
      ORDER BY distance
    `).all(buf, topK) as VectorRow[];
  } catch {
    return [];
  }
}

// ============================================================
// 对话记忆接口（供 chat-memory 使用）
// ============================================================

/** 保存对话摘要 */
export function saveSummary(cwd: string, chatId: string, summary: string): void {
  const db = getDB(cwd);
  if (!db) return;

  db.prepare("INSERT OR IGNORE INTO conversations (chat_id) VALUES (?)").run(chatId);
  db.prepare("INSERT INTO chat_summaries (chat_id, summary) VALUES (?, ?)").run(chatId, summary);

  // 保留最近 3 条
  db.prepare(`
    DELETE FROM chat_summaries WHERE chat_id = ? AND id NOT IN (
      SELECT id FROM chat_summaries WHERE chat_id = ? ORDER BY id DESC LIMIT 3
    )
  `).run(chatId, chatId);
}

/** 读取对话摘要 */
export function getSummaries(cwd: string, chatId: string): string[] {
  const db = getDB(cwd);
  if (!db) return [];

  const rows = db.prepare(
    "SELECT summary FROM chat_summaries WHERE chat_id = ? ORDER BY id"
  ).all(chatId) as Array<{ summary: string }>;

  return rows.map((r) => r.summary);
}

/** 保存 DAG 节点 */
export function saveDAGNodes(
  cwd: string,
  chatId: string,
  nodes: Array<{ id: string; level: number; sourceStart: number; sourceEnd: number; summary: string; tokenCount: number; isRoot: boolean; children: string[] }>,
): void {
  const db = getDB(cwd);
  if (!db) return;

  const save = db.transaction(() => {
    db.prepare("INSERT OR IGNORE INTO conversations (chat_id) VALUES (?)").run(chatId);

    // 清除旧 DAG
    db.prepare("DELETE FROM dag_edges WHERE parent_id IN (SELECT id FROM dag_nodes WHERE chat_id = ?)").run(chatId);
    db.prepare("DELETE FROM dag_nodes WHERE chat_id = ?").run(chatId);

    const insertNode = db.prepare(
      "INSERT INTO dag_nodes (id, chat_id, level, source_start, source_end, summary, token_count, is_root) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    const insertEdge = db.prepare(
      "INSERT INTO dag_edges (parent_id, child_id) VALUES (?, ?)"
    );

    for (const node of nodes) {
      insertNode.run(node.id, chatId, node.level, node.sourceStart, node.sourceEnd, node.summary, node.tokenCount, node.isRoot ? 1 : 0);
      for (const childId of node.children) {
        insertEdge.run(node.id, childId);
      }
    }

    db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE chat_id = ?").run(chatId);
  });

  save();
}

/** 添加 per-chat 事实（带去重） */
export function addFact(cwd: string, chatId: string, fact: string): boolean {
  const db = getDB(cwd);
  if (!db) return false;

  // Jaccard 去重：检查是否与已有事实太相似
  const existing = db.prepare(
    "SELECT fact FROM chat_facts WHERE chat_id = ?"
  ).all(chatId) as Array<{ fact: string }>;

  const newTokens = new Set(fact.toLowerCase().split(/\s+/).filter((t) => t.length >= 2));
  for (const row of existing) {
    const oldTokens = new Set(row.fact.toLowerCase().split(/\s+/).filter((t) => t.length >= 2));
    let intersection = 0;
    newTokens.forEach((t) => { if (oldTokens.has(t)) intersection++; });
    const union = newTokens.size + oldTokens.size - intersection;
    if (union > 0 && intersection / union > 0.5) return false; // 重复
  }

  db.prepare("INSERT INTO chat_facts (chat_id, fact) VALUES (?, ?)").run(chatId, fact);

  // 保留最多 15 条
  db.prepare(`
    DELETE FROM chat_facts WHERE chat_id = ? AND id NOT IN (
      SELECT id FROM chat_facts WHERE chat_id = ? ORDER BY id DESC LIMIT 15
    )
  `).run(chatId, chatId);

  return true;
}

/** 读取 per-chat 事实 */
export function getFacts(cwd: string, chatId: string): string[] {
  const db = getDB(cwd);
  if (!db) return [];

  const rows = db.prepare(
    "SELECT fact FROM chat_facts WHERE chat_id = ? ORDER BY id"
  ).all(chatId) as Array<{ fact: string }>;

  return rows.map((r) => r.fact);
}

// ============================================================
// 检索轨迹接口
// ============================================================

/** 写入检索轨迹（替代 JSONL 文件） */
export function saveTrace(
  cwd: string,
  trace: { timestamp: string; query: string; pipeline: unknown; rrf: unknown; injected: unknown; budget_used: number; budget_limit: number },
): void {
  const db = getDB(cwd);
  if (!db) return;

  try {
    db.prepare(`
      INSERT INTO traces (timestamp, query, pipeline, rrf, injected, budget_used, budget_limit)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      trace.timestamp,
      trace.query,
      JSON.stringify(trace.pipeline),
      JSON.stringify(trace.rrf),
      JSON.stringify(trace.injected),
      trace.budget_used,
      trace.budget_limit,
    );

    // FTS5 索引
    const lastId = db.prepare("SELECT last_insert_rowid() as id").get() as { id: number };
    db.prepare("INSERT INTO traces_fts (rowid, query) VALUES (?, ?)").run(lastId.id, trace.query);

    // 保留最近 7 天
    db.prepare("DELETE FROM traces WHERE created_at < datetime('now', '-7 days')").run();
  } catch {
    // 静默失败
  }
}

// ============================================================
// 事件流接口
// ============================================================

/** 同步 RECENT_EVENTS.md 到 events 表 */
export function syncEventsFromMd(cwd: string): boolean {
  const db = getDB(cwd);
  if (!db) return false;

  const eventsPath = path.join(cwd, "0-System/RECENT_EVENTS.md");
  if (!existsSync(eventsPath)) return false;

  const currentMtime = statSync(eventsPath).mtimeMs.toString();
  const savedMtime = db.prepare("SELECT value FROM meta WHERE key = 'events_md_mtime'").get() as { value: string } | undefined;

  if (savedMtime && savedMtime.value === currentMtime) {
    return true;
  }

  const content = readFileSync(eventsPath, "utf-8");
  const lines = content.split("\n");

  const rebuild = db.transaction(() => {
    db.exec("DELETE FROM events");

    const insert = db.prepare("INSERT INTO events (event_date, event_time, content) VALUES (?, ?, ?)");
    let currentDate = "";

    for (const line of lines) {
      const dateMatch = line.match(/^## (\d{4}-\d{2}-\d{2})/);
      if (dateMatch) {
        currentDate = dateMatch[1];
        continue;
      }

      if (line.startsWith("- ") && currentDate) {
        const timeMatch = line.match(/^- `(\d{2}:\d{2})`\s+(.*)/);
        if (timeMatch) {
          insert.run(currentDate, timeMatch[1], timeMatch[2]);
        } else {
          insert.run(currentDate, null, line.replace(/^-\s*/, ""));
        }
      }
    }

    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('events_md_mtime', ?)").run(currentMtime);
  });

  rebuild();
  return true;
}
