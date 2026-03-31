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
  id            TEXT PRIMARY KEY,
  category      TEXT NOT NULL,
  scope         TEXT NOT NULL DEFAULT 'project',  -- user/project/agent/session
  content       TEXT NOT NULL,
  stars         INTEGER DEFAULT 0,
  write_date    TEXT,
  event_date    TEXT,
  chain_type    TEXT,
  chain_ref     TEXT,
  quality_score REAL DEFAULT 0.5,     -- EDM: 记忆质量分 (0-1)
  last_accessed TEXT,                  -- FadeMem: 最近被检索注入的时间
  access_count  INTEGER DEFAULT 0,    -- FadeMem: 被检索注入的累计次数
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
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
  predicted  TEXT,
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

    // Migration: traces 表增加 predicted 列（兼容旧库）
    try {
      const cols = db.prepare("PRAGMA table_info(traces)").all() as Array<{ name: string }>;
      if (!cols.some(c => c.name === "predicted")) {
        db.exec("ALTER TABLE traces ADD COLUMN predicted TEXT");
      }
    } catch { /* 静默 */ }

    // Migration: items 表增加 EDM + FadeMem 列（兼容旧库）
    try {
      const itemCols = db.prepare("PRAGMA table_info(items)").all() as Array<{ name: string }>;
      const colNames = new Set(itemCols.map(c => c.name));
      if (!colNames.has("quality_score")) {
        db.exec("ALTER TABLE items ADD COLUMN quality_score REAL DEFAULT 0.5");
      }
      if (!colNames.has("last_accessed")) {
        db.exec("ALTER TABLE items ADD COLUMN last_accessed TEXT");
      }
      if (!colNames.has("access_count")) {
        db.exec("ALTER TABLE items ADD COLUMN access_count INTEGER DEFAULT 0");
      }
    } catch { /* 静默 */ }

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
// ============================================================
// EDM 记忆质量评分（Eval-Driven Memory）
// ============================================================

/**
 * 计算单条 item 的质量分（0-1）。
 *
 * 评分维度：
 * - 具体性：包含路径、端口、版本号、URL 等具体值 → 高质量
 * - 信息量：内容长度适中（15-200 字符最佳）
 * - 星级：★ 标记反映人类评价
 * - 结构化：有因果链/版本链标记 → 说明经过整理
 */
function computeQualityScore(item: ItemRow): number {
  let score = 0.5; // 基线

  // 具体性检测（有具体值加分）
  const hasPath = /\/[a-zA-Z][\w/.-]+/.test(item.content);
  const hasPort = /:\d{4,5}\b/.test(item.content);
  const hasVersion = /v?\d+\.\d+/.test(item.content);
  const hasUrl = /https?:\/\//.test(item.content);
  const specificityBonus = (hasPath ? 0.05 : 0) + (hasPort ? 0.05 : 0) + (hasVersion ? 0.05 : 0) + (hasUrl ? 0.05 : 0);
  score += Math.min(specificityBonus, 0.15);

  // 信息量（去掉标记后的纯文本长度）
  const cleanContent = item.content.replace(/[★#→←\[\]]/g, "").trim();
  if (cleanContent.length < 10) score -= 0.2;       // 太短，信息不足
  else if (cleanContent.length < 20) score -= 0.1;  // 偏短
  else if (cleanContent.length > 200) score -= 0.05; // 偏长（不够原子化）

  // 星级加成
  if (item.stars >= 3) score += 0.15;
  else if (item.stars >= 2) score += 0.1;
  else if (item.stars >= 1) score += 0.05;

  // 结构化标记（有因果链/版本链 → 经过整理的高质量记忆）
  if (item.chain_type) score += 0.05;

  return Math.max(0, Math.min(1, score));
}

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

  // 保留旧的访问数据（FadeMem：sync 不应清除访问统计）
  const oldAccess = new Map<string, { last_accessed: string | null; access_count: number }>();
  try {
    const rows = db.prepare("SELECT id, last_accessed, access_count FROM items WHERE last_accessed IS NOT NULL").all() as Array<{ id: string; last_accessed: string | null; access_count: number }>;
    for (const row of rows) {
      oldAccess.set(row.id, { last_accessed: row.last_accessed, access_count: row.access_count });
    }
  } catch { /* 首次运行无数据 */ }

  // 事务内全量重建
  const rebuild = db.transaction(() => {
    db.exec("DELETE FROM items");
    db.exec("DELETE FROM items_fts");

    const insertItem = db.prepare(
      "INSERT INTO items (id, category, scope, content, stars, write_date, event_date, chain_type, chain_ref, quality_score, last_accessed, access_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    const insertFts = db.prepare(
      "INSERT INTO items_fts (id, content, category) VALUES (?, ?, ?)"
    );

    for (const item of items) {
      const qScore = computeQualityScore(item);
      const old = oldAccess.get(item.id);
      insertItem.run(
        item.id, item.category, item.scope, item.content, item.stars,
        item.write_date, item.event_date, item.chain_type, item.chain_ref,
        qScore, old?.last_accessed ?? null, old?.access_count ?? 0,
      );
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
  trace: {
    timestamp: string;
    query: string;
    pipeline: unknown;
    rrf: unknown;
    injected: unknown;
    predicted?: string[];
    budget_used: number;
    budget_limit: number;
  },
): void {
  const db = getDB(cwd);
  if (!db) return;

  try {
    db.prepare(`
      INSERT INTO traces (timestamp, query, pipeline, rrf, injected, predicted, budget_used, budget_limit)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      trace.timestamp,
      trace.query,
      JSON.stringify(trace.pipeline),
      JSON.stringify(trace.rrf),
      JSON.stringify(trace.injected),
      trace.predicted ? JSON.stringify(trace.predicted) : null,
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

/**
 * PP 自动验证闭环：聚合最近 N 天有 predicted 的轨迹，
 * 对比 predicted vs injected，返回预测准确率和偏差模式。
 *
 * 准确率 = predicted 中被 injected 命中的比率（precision）
 * 召回率 = injected 中被 predicted 覆盖的比率（recall）
 * 偏差大（precision < 0.5）时，应触发预测策略调整。
 */
export interface PredictionVerification {
  readonly totalWithPredictions: number;
  readonly precision: number;   // predicted 中多少被实际注入
  readonly recall: number;      // injected 中多少被预测到
  /** 经常预测但从未注入的类别（幻觉候选） */
  readonly overPredicted: ReadonlyArray<{ category: string; count: number }>;
  /** 经常注入但从未预测的类别（盲区候选） */
  readonly underPredicted: ReadonlyArray<{ category: string; count: number }>;
}

export function verifyPredictions(cwd: string, days: number = 7): PredictionVerification {
  const empty: PredictionVerification = {
    totalWithPredictions: 0, precision: 0, recall: 0,
    overPredicted: [], underPredicted: [],
  };
  const db = getDB(cwd);
  if (!db) return empty;

  try {
    const rows = db.prepare(
      `SELECT predicted, injected FROM traces
       WHERE predicted IS NOT NULL AND created_at >= datetime('now', '-${days} days')`,
    ).all() as Array<{ predicted: string; injected: string }>;

    if (rows.length === 0) return empty;

    let totalHits = 0;
    let totalPredicted = 0;
    let totalInjected = 0;
    let totalRecallHits = 0;
    const overCounts = new Map<string, number>();
    const underCounts = new Map<string, number>();

    for (const row of rows) {
      const predicted: string[] = JSON.parse(row.predicted || "[]");
      const injectedRaw: Array<{ category: string }> = JSON.parse(row.injected || "[]");
      const injectedSet = new Set(injectedRaw.map(i => i.category));

      totalPredicted += predicted.length;
      totalInjected += injectedSet.size;

      for (const p of predicted) {
        if (injectedSet.has(p)) {
          totalHits++;
        } else {
          overCounts.set(p, (overCounts.get(p) || 0) + 1);
        }
      }

      for (const cat of injectedSet) {
        if (predicted.includes(cat)) {
          totalRecallHits++;
        } else {
          underCounts.set(cat, (underCounts.get(cat) || 0) + 1);
        }
      }
    }

    const overPredicted = [...overCounts.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    const underPredicted = [...underCounts.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    return {
      totalWithPredictions: rows.length,
      precision: totalPredicted > 0 ? totalHits / totalPredicted : 0,
      recall: totalInjected > 0 ? totalRecallHits / totalInjected : 0,
      overPredicted,
      underPredicted,
    };
  } catch {
    return empty;
  }
}

/** v6 AST: 轨迹聚合统计 — 从 write-only 到反馈闭环 */
export interface TraceStats {
  /** 每个类别被注入的次数（降序） */
  readonly categoryHitRate: ReadonlyArray<{ category: string; count: number; rate: number }>;
  /** 被 RRF 排名但未注入的类别（检索盲区候选） */
  readonly missedCategories: ReadonlyArray<{ category: string; rrfCount: number; injectCount: number }>;
  /** 平均预算使用率 */
  readonly avgBudgetUsage: number;
  /** 轨迹总数 */
  readonly totalTraces: number;
}

/**
 * v6 AST: 聚合最近 N 天的检索轨迹，生成类别命中率统计。
 *
 * 用于 ASAC 反馈闭环：历史高命中类别在下次检索中获得 boost。
 * 冷启动安全：无数据时返回空统计，调用方可安全忽略。
 */
export function aggregateTraces(cwd: string, days: number = 7): TraceStats {
  const empty: TraceStats = { categoryHitRate: [], missedCategories: [], avgBudgetUsage: 0, totalTraces: 0 };
  const db = getDB(cwd);
  if (!db) return empty;

  try {
    // 拉取最近 N 天的轨迹
    const rows = db.prepare(
      `SELECT rrf, injected, budget_used, budget_limit FROM traces WHERE created_at >= datetime('now', '-${days} days')`,
    ).all() as Array<{ rrf: string; injected: string; budget_used: number; budget_limit: number }>;

    if (rows.length === 0) return empty;

    const rrfCounts = new Map<string, number>();
    const injectCounts = new Map<string, number>();
    let totalBudgetRatio = 0;

    for (const row of rows) {
      // RRF 类别统计
      const rrfList: Array<{ category: string }> = JSON.parse(row.rrf || "[]");
      for (const item of rrfList) {
        rrfCounts.set(item.category, (rrfCounts.get(item.category) || 0) + 1);
      }

      // 注入类别统计
      const injectedList: Array<{ category: string }> = JSON.parse(row.injected || "[]");
      for (const item of injectedList) {
        injectCounts.set(item.category, (injectCounts.get(item.category) || 0) + 1);
      }

      // 预算使用率
      if (row.budget_limit > 0) {
        totalBudgetRatio += row.budget_used / row.budget_limit;
      }
    }

    // 类别命中率（注入次数 / 总轨迹数）
    const categoryHitRate = Array.from(injectCounts.entries())
      .map(([category, count]) => ({ category, count, rate: count / rows.length }))
      .sort((a, b) => b.count - a.count);

    // 检索盲区：被 RRF 排到过但从未注入的类别
    const missedCategories = Array.from(rrfCounts.entries())
      .filter(([cat]) => !injectCounts.has(cat))
      .map(([category, rrfCount]) => ({ category, rrfCount, injectCount: 0 }))
      .sort((a, b) => b.rrfCount - a.rrfCount);

    return {
      categoryHitRate,
      missedCategories,
      avgBudgetUsage: totalBudgetRatio / rows.length,
      totalTraces: rows.length,
    };
  } catch {
    return empty;
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

// ============================================================
// FadeMem 访问频率追踪 + 指数衰减
// ============================================================

/** FadeMem 衰减参数：λ=0.05 对应半衰期 ≈ 14 天 */
const FADE_LAMBDA = 0.05;

/**
 * 记录一批 item 被检索注入（更新 last_accessed + access_count）。
 * 在 context-loader 的 extractCategories 完成后调用。
 */
export function recordItemAccess(cwd: string, categories: ReadonlyArray<string>): void {
  const db = getDB(cwd);
  if (!db || categories.length === 0) return;

  try {
    const now = new Date().toISOString();
    const stmt = db.prepare(
      "UPDATE items SET last_accessed = ?, access_count = access_count + 1 WHERE category = ?",
    );
    const batch = db.transaction(() => {
      for (const cat of categories) {
        stmt.run(now, cat);
      }
    });
    batch();
  } catch {
    // 静默
  }
}

/**
 * 获取指定类别下所有 item 的质量分 + 访问衰减系数。
 *
 * 返回 Map<itemId, { quality, decayFactor }>
 * - quality: 0-1 EDM 质量分
 * - decayFactor: 0-1 FadeMem 衰减系数（1=刚访问，→0=长期未访问）
 *
 * decayFactor = e^(-λ * daysSinceLastAccess)
 * 从未被访问的 item: daysSinceLastAccess = daysSinceCreation，给予基线衰减
 */
export function getQualityAndDecayScores(
  cwd: string,
  categories: ReadonlyArray<string>,
): Map<string, { quality: number; decayFactor: number }> {
  const result = new Map<string, { quality: number; decayFactor: number }>();
  const db = getDB(cwd);
  if (!db || categories.length === 0) return result;

  try {
    const placeholders = categories.map(() => "?").join(",");
    const rows = db.prepare(
      `SELECT id, quality_score, last_accessed, access_count, created_at FROM items WHERE category IN (${placeholders})`,
    ).all(...categories) as Array<{
      id: string;
      quality_score: number | null;
      last_accessed: string | null;
      access_count: number;
      created_at: string;
    }>;

    const now = Date.now();
    for (const row of rows) {
      const quality = row.quality_score ?? 0.5;

      // 计算距上次访问的天数
      let daysSince: number;
      if (row.last_accessed) {
        daysSince = Math.max(0, (now - new Date(row.last_accessed).getTime()) / (1000 * 60 * 60 * 24));
      } else {
        // 从未被访问：用创建时间，但给更宽容的衰减（λ 减半）
        daysSince = Math.max(0, (now - new Date(row.created_at).getTime()) / (1000 * 60 * 60 * 24));
      }

      // FadeMem 指数衰减：e^(-λ * days)
      // 从未被访问的 item 用 λ/2（更宽容），避免新 item 被过度惩罚
      const lambda = row.last_accessed ? FADE_LAMBDA : FADE_LAMBDA / 2;
      const decayFactor = Math.exp(-lambda * daysSince);

      result.set(row.id, { quality, decayFactor });
    }
  } catch {
    // 静默
  }

  return result;
}

// ============================================================
// 行为漂移量化监控（Behavioral Drift Detection）
// ============================================================

/** 行为漂移统计结果 */
export interface BehaviorDriftStats {
  /** 总任务数 */
  totalTasks: number;
  /** 引擎分布 { engine: count } */
  engineDistribution: ReadonlyArray<{ engine: string; count: number; ratio: number }>;
  /** 摩擦密度：有 friction 标记的任务占比 */
  frictionDensity: number;
  /** 摩擦 skill 热点（按频率排序） */
  frictionHotspots: ReadonlyArray<{ skill: string; count: number }>;
  /** 任务类型分布 */
  taskTypeDistribution: ReadonlyArray<{ type: string; count: number; ratio: number }>;
  /** 每日任务数趋势（最近 N 天） */
  dailyTaskCounts: ReadonlyArray<{ date: string; count: number }>;
  /** 分析时间窗口 */
  windowDays: number;
}

/**
 * 从 task-log.md 解析行为指标，用于检测 cc 的行为漂移。
 *
 * 数据源：`0-System/task-log.md`
 * 格式：| 时间 | 任务类型 | 摘要 | 执行引擎 | 状态 | friction_skill |
 *
 * @param cwd 项目根目录
 * @param days 回看天数（默认 14）
 */
export function computeBehaviorDrift(cwd: string, days: number = 14): BehaviorDriftStats {
  const empty: BehaviorDriftStats = {
    totalTasks: 0,
    engineDistribution: [],
    frictionDensity: 0,
    frictionHotspots: [],
    taskTypeDistribution: [],
    dailyTaskCounts: [],
    windowDays: days,
  };

  const logPath = path.join(cwd, "0-System/task-log.md");
  if (!existsSync(logPath)) return empty;

  try {
    const content = readFileSync(logPath, "utf-8");
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const engineCounts = new Map<string, number>();
    const typeCounts = new Map<string, number>();
    const frictionCounts = new Map<string, number>();
    const dailyCounts = new Map<string, number>();
    let totalTasks = 0;
    let frictionTasks = 0;

    for (const line of content.split("\n")) {
      const cells = line.split("|").map(c => c.trim()).filter(Boolean);
      if (cells.length < 5) continue;

      // 解析时间列（格式：2026-03-31 14:00 或 2026-03-31）
      const timeStr = cells[0];
      const dateMatch = timeStr.match(/^(\d{4}-\d{2}-\d{2})/);
      if (!dateMatch) continue;

      const date = dateMatch[1];
      const taskDate = new Date(date);
      if (taskDate < cutoff) continue;

      totalTasks++;

      // 任务类型
      const taskType = cells[1];
      typeCounts.set(taskType, (typeCounts.get(taskType) ?? 0) + 1);

      // 引擎
      const engineRaw = cells[3].toLowerCase();
      let engine = "unknown";
      if (engineRaw.includes("codex")) engine = "codex";
      else if (engineRaw.includes("gemini")) engine = "gemini";
      else if (engineRaw.includes("cc") || engineRaw.includes("claude")) engine = "cc";
      engineCounts.set(engine, (engineCounts.get(engine) ?? 0) + 1);

      // friction
      const frictionCol = cells.length >= 6 ? cells[5] : "";
      if (frictionCol && frictionCol !== "—" && frictionCol !== "-") {
        frictionTasks++;
        frictionCounts.set(frictionCol, (frictionCounts.get(frictionCol) ?? 0) + 1);
      }

      // 每日计数
      dailyCounts.set(date, (dailyCounts.get(date) ?? 0) + 1);
    }

    if (totalTasks === 0) return empty;

    const toDistribution = (map: Map<string, number>, nameKey: string) =>
      [...map.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => ({
          [nameKey]: name,
          count,
          ratio: Math.round((count / totalTasks) * 100) / 100,
        })) as ReadonlyArray<Record<string, unknown>>;

    return {
      totalTasks,
      engineDistribution: toDistribution(engineCounts, "engine") as unknown as BehaviorDriftStats["engineDistribution"],
      frictionDensity: Math.round((frictionTasks / totalTasks) * 100) / 100,
      frictionHotspots: [...frictionCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([skill, count]) => ({ skill, count })),
      taskTypeDistribution: toDistribution(typeCounts, "type") as unknown as BehaviorDriftStats["taskTypeDistribution"],
      dailyTaskCounts: [...dailyCounts.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, count]) => ({ date, count })),
      windowDays: days,
    };
  } catch {
    return empty;
  }
}
