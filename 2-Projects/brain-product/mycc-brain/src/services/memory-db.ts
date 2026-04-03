/** memory-db.ts — 精简版 SQLite 记忆数据库（FTS5 全文搜索 + sqlite-vec 向量检索） */
import { readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { embed, isOllamaReady } from "./embedding.js";

interface MemoryRow { category: string; content: string; rank: number }
interface VectorRow { id: string; category: string; content: string; distance: number }
interface ParsedItem { category: string; content: string }

let db: any = null;
let lastMtime = 0;
let Database: any = null;
let vecLoaded = false;

async function loadDriver(): Promise<boolean> {
  if (Database) return true;
  try {
    const modName = "better-sqlite3";
    const mod = await import(/* webpackIgnore: true */ modName);
    Database = mod.default ?? mod;
    return true;
  } catch {
    console.error("[memory-db] better-sqlite3 not available, FTS disabled");
    return false;
  }
}

function parseMemoryItems(content: string): ParsedItem[] {
  const items: ParsedItem[] = [];
  const lines = content.split("\n");
  let category = "";

  for (const line of lines) {
    const headerMatch = line.match(/^##\s+\[([^\]]+)\]/);
    if (headerMatch) {
      category = headerMatch[1];
      continue;
    }
    if (category && line.startsWith("- ")) {
      items.push({ category, content: line.slice(2).trim() });
    }
  }
  return items;
}

async function loadVec(): Promise<boolean> {
  if (vecLoaded) return true;
  if (!db) return false;
  try {
    const modName = "sqlite-vec";
    const mod = await import(/* webpackIgnore: true */ modName);
    const sqliteVec = mod.default ?? mod;
    sqliteVec.load(db);
    vecLoaded = true;
    console.log("[memory-db] sqlite-vec loaded");
    return true;
  } catch {
    console.error("[memory-db] sqlite-vec not available, vector search disabled");
    return false;
  }
}

export async function initDB(dataDir: string): Promise<boolean> {
  if (db) return true;
  if (!(await loadDriver())) return false;

  try {
    const dbPath = join(dataDir, "memory.db");
    db = new Database(dbPath);
    db.pragma("journal_mode = DELETE");

    db.exec(`
      CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        content  TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
        category, content, content='items', content_rowid='id'
      );
      CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
        INSERT INTO items_fts(rowid, category, content)
        VALUES (new.id, new.category, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN
        INSERT INTO items_fts(items_fts, rowid, category, content)
        VALUES ('delete', old.id, old.category, old.content);
      END;
    `);

    // sqlite-vec: 加载扩展并创建向量表（降级不影响 FTS）
    if (await loadVec()) {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS items_vec USING vec0(
          id TEXT PRIMARY KEY,
          embedding float[512] distance_metric=cosine
        );
      `);
    }

    return true;
  } catch (err) {
    console.error("[memory-db] initDB failed:", err);
    db = null;
    return false;
  }
}

export async function syncFromMd(dataDir: string): Promise<number> {
  const mdPath = join(dataDir, "memory-items.md");
  if (!existsSync(mdPath)) return 0;

  const mtime = statSync(mdPath).mtimeMs;
  if (mtime === lastMtime && db) return -1; // no change

  if (!(await initDB(dataDir))) return 0;

  try {
    const content = readFileSync(mdPath, "utf-8");
    const items = parseMemoryItems(content);

    const tx = db.transaction(() => {
      db.exec("DELETE FROM items");
      db.exec("INSERT INTO items_fts(items_fts) VALUES ('delete-all')");
      const insert = db.prepare(
        "INSERT INTO items (category, content) VALUES (?, ?)"
      );
      for (const item of items) {
        insert.run(item.category, item.content);
      }
    });
    tx();

    // 向量嵌入（异步，不阻塞 FTS 同步结果）
    if (vecLoaded && (await isOllamaReady())) {
      syncVectors(items).catch((err) =>
        console.error("[memory-db] syncVectors background error:", err)
      );
    }

    lastMtime = mtime;
    return items.length;
  } catch (err) {
    console.error("[memory-db] syncFromMd failed:", err);
    return 0;
  }
}

async function syncVectors(items: ParsedItem[]): Promise<void> {
  if (!db || !vecLoaded) return;

  // 清空旧向量
  try {
    db.exec("DELETE FROM items_vec");
  } catch { /* table may not exist */ }

  const insertVec = db.prepare(
    "INSERT INTO items_vec (id, embedding) VALUES (?, ?)"
  );
  const total = items.length;
  let embedded = 0;
  let skipped = 0;

  console.log(`[memory-db] embedding ${total} items...`);

  for (let i = 0; i < total; i++) {
    const item = items[i];
    const text = `${item.category}: ${item.content}`;
    const vec = await embed(text);
    if (vec) {
      try {
        insertVec.run(`${i}`, new Float32Array(vec));
        embedded++;
      } catch (err) {
        console.error(`[memory-db] vec insert failed for item ${i}:`, err);
        skipped++;
      }
    } else {
      skipped++;
    }

    if ((i + 1) % 50 === 0 || i === total - 1) {
      console.log(`[memory-db] embedding progress: ${i + 1}/${total} (embedded=${embedded}, skipped=${skipped})`);
    }
  }

  console.log(`[memory-db] embedding done: ${embedded} embedded, ${skipped} skipped`);
}

function sanitizeFtsQuery(query: string): string {
  // Remove FTS5 special characters that cause syntax errors
  const cleaned = query.replace(/[.*+\-"(){}[\]^~:@#$%&\\|<>=!?,;]/g, " ");
  // Split into tokens and wrap each in quotes for exact matching
  const tokens = cleaned.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t}"`).join(" OR ");
}

export function ftsSearch(
  dataDir: string,
  query: string,
  topK = 10
): MemoryRow[] {
  if (!db) return [];
  if (!query.trim()) return [];

  const ftsQuery = sanitizeFtsQuery(query);
  if (!ftsQuery) return [];

  try {
    const stmt = db.prepare(`
      SELECT category, content, rank
      FROM items_fts
      WHERE items_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `);
    return stmt.all(ftsQuery, topK) as MemoryRow[];
  } catch (err) {
    console.error("[memory-db] ftsSearch failed:", err);
    return [];
  }
}

export function vectorSearch(
  _dataDir: string,
  queryVec: number[],
  topK = 5,
): VectorRow[] {
  if (!db || !vecLoaded) return [];
  try {
    const stmt = db.prepare(`
      SELECT v.id, i.category, i.content, v.distance
      FROM items_vec v
      JOIN items i ON i.id = (CAST(v.id AS INTEGER) + 1)
      WHERE v.embedding MATCH ? AND k = ?
      ORDER BY v.distance
    `);
    return stmt.all(new Float32Array(queryVec), topK) as VectorRow[];
  } catch (err) {
    console.error("[memory-db] vectorSearch failed:", err);
    return [];
  }
}

export function closeDB(): void {
  if (db) {
    try {
      db.close();
    } catch { /* ignore */ }
    db = null;
    lastMtime = 0;
  }
}
