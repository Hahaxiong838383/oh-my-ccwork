/**
 * memory-rollback.ts — 记忆系统回滚安全网
 *
 * 三层防护：
 * L1 快照 — 每次自动写入前 createSnapshot()
 * L2 质量门 — 写入后 checkQuality() 检测命中率降幅
 * L3 开关 — memory-config.json 独立控制每个功能
 *
 * 借鉴 Claude Code 源码的 compact boundary + circuit breaker 思想，
 * 结合 mycc 的 traces 表做质量度量。
 */

import { readFileSync, writeFileSync, copyFileSync, mkdirSync, readdirSync, unlinkSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import type Database from "better-sqlite3";

// ── Types ──────────────────────────────────────────────────────

export interface SnapshotResult {
  readonly snapshotPath: string;
  readonly itemCount: number;
  readonly timestamp: string;
}

export interface QualityMetrics {
  readonly hitRate: number;
  readonly itemCount: number;
  readonly categoriesCount: number;
}

export interface QualityCheck {
  readonly ok: boolean;
  readonly metrics: QualityMetrics;
  readonly alert?: string;
}

export interface MemoryConfig {
  readonly sessionExtraction: { readonly enabled: boolean };
  readonly dreamConsolidation: { readonly enabled: boolean };
  readonly agentMemory: { readonly enabled: boolean };
  readonly rollback: {
    readonly autoRevert: boolean;
    readonly hitRateThreshold: number;
    readonly maxSnapshots: number;
  };
}

// ── Constants ──────────────────────────────────────────────────

const SNAPSHOTS_DIR = "0-System/snapshots";
const MEMORY_ITEMS_PATH = "0-System/memory-items.md";
const CONFIG_PATH = "0-System/memory-config.json";

// ── Config ─────────────────────────────────────────────────────

const DEFAULT_CONFIG: MemoryConfig = {
  sessionExtraction: { enabled: false },
  dreamConsolidation: { enabled: false },
  agentMemory: { enabled: false },
  rollback: { autoRevert: true, hitRateThreshold: 0.20, maxSnapshots: 7 },
};

export function loadConfig(cwd: string): MemoryConfig {
  const configPath = join(cwd, CONFIG_PATH);
  try {
    const raw = readFileSync(configPath, "utf-8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function saveConfig(cwd: string, config: MemoryConfig): void {
  const configPath = join(cwd, CONFIG_PATH);
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

// ── Snapshot ───────────────────────────────────────────────────

function ensureSnapshotsDir(cwd: string): string {
  const dir = join(cwd, SNAPSHOTS_DIR);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function countItems(content: string): number {
  return content.split("\n").filter(line => line.startsWith("- ") && /★/.test(line)).length;
}

function countCategories(content: string): number {
  return content.split("\n").filter(line => /^## \[/.test(line)).length;
}

export function createSnapshot(cwd: string): SnapshotResult {
  const dir = ensureSnapshotsDir(cwd);
  const src = join(cwd, MEMORY_ITEMS_PATH);
  const now = new Date();
  const ts = now.toISOString().replace(/[-:T]/g, "").slice(0, 13); // YYYYMMDD-HHmm
  const filename = `memory-items.${ts}.md`;
  const dest = join(dir, filename);

  copyFileSync(src, dest);

  const content = readFileSync(src, "utf-8");
  const result: SnapshotResult = {
    snapshotPath: dest,
    itemCount: countItems(content),
    timestamp: now.toISOString(),
  };

  // Sidecar JSON for fast metadata lookup
  writeFileSync(
    dest.replace(".md", ".json"),
    JSON.stringify(result, null, 2),
    "utf-8",
  );

  return result;
}

// ── Quality Check ──────────────────────────────────────────────

function computeMetricsFromFile(cwd: string): QualityMetrics {
  const src = join(cwd, MEMORY_ITEMS_PATH);
  try {
    const content = readFileSync(src, "utf-8");
    return {
      hitRate: 1.0, // baseline when no traces available
      itemCount: countItems(content),
      categoriesCount: countCategories(content),
    };
  } catch {
    return { hitRate: 0, itemCount: 0, categoriesCount: 0 };
  }
}

/**
 * 从 SQLite traces 表计算命中率。
 * traces.injected 非空 = 命中（检索到了有用的记忆）。
 * 回退到文件级指标。
 */
function computeHitRateFromTraces(db: Database.Database): number | null {
  try {
    const row = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN injected != '' AND injected != '[]' THEN 1 ELSE 0 END) as hits
      FROM traces
      WHERE created_at >= datetime('now', '-24 hours')
    `).get() as { total: number; hits: number } | undefined;

    if (!row || row.total === 0) return null; // 无数据，回退
    return row.hits / row.total;
  } catch {
    return null; // traces 表不存在或查询失败
  }
}

/**
 * 综合质量指标：优先用 traces 表的真实命中率，回退到文件级指标。
 */
export function computeMetrics(cwd: string, db?: Database.Database): QualityMetrics {
  const fileMetrics = computeMetricsFromFile(cwd);

  // 尝试从 traces 表获取真实命中率
  if (db) {
    const hitRate = computeHitRateFromTraces(db);
    if (hitRate !== null) {
      return { ...fileMetrics, hitRate };
    }
  }

  return fileMetrics;
}

export function checkQuality(
  cwd: string,
  baseline: QualityMetrics,
  db?: Database.Database,
): QualityCheck {
  const current = computeMetrics(cwd, db);
  const config = loadConfig(cwd);
  const threshold = config.rollback.hitRateThreshold;

  // Item count 降幅检查（比 hitRate 更可靠的 Phase 1 指标）
  const itemDelta = baseline.itemCount > 0
    ? (baseline.itemCount - current.itemCount) / baseline.itemCount
    : 0;

  const categoryDelta = baseline.categoriesCount > 0
    ? (baseline.categoriesCount - current.categoriesCount) / baseline.categoriesCount
    : 0;

  // 如果 item 减少超过阈值比例，或 category 整个消失
  if (itemDelta > threshold || categoryDelta > 0.1) {
    const alert = `⚠️ 记忆质量下降: items ${baseline.itemCount}→${current.itemCount} (${(itemDelta * 100).toFixed(1)}%), categories ${baseline.categoriesCount}→${current.categoriesCount}`;
    return { ok: false, metrics: current, alert };
  }

  return { ok: true, metrics: current };
}

// ── Rollback ───────────────────────────────────────────────────

export function rollbackToSnapshot(cwd: string, snapshotPath: string): boolean {
  const dest = join(cwd, MEMORY_ITEMS_PATH);
  try {
    if (!existsSync(snapshotPath)) return false;
    copyFileSync(snapshotPath, dest);
    console.log(`[Rollback] Restored from ${basename(snapshotPath)}`);
    return true;
  } catch (err) {
    console.error("[Rollback] Failed:", err);
    return false;
  }
}

// ── Snapshot Management ────────────────────────────────────────

export function listSnapshots(cwd: string): ReadonlyArray<SnapshotResult> {
  const dir = join(cwd, SNAPSHOTS_DIR);
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter(f => f.endsWith(".json") && f.startsWith("memory-items."))
    .map(f => {
      try {
        return JSON.parse(readFileSync(join(dir, f), "utf-8")) as SnapshotResult;
      } catch {
        return null;
      }
    })
    .filter((s): s is SnapshotResult => s !== null)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

export function pruneSnapshots(cwd: string, keep?: number): number {
  const config = loadConfig(cwd);
  const maxKeep = keep ?? config.rollback.maxSnapshots;
  const dir = join(cwd, SNAPSHOTS_DIR);
  if (!existsSync(dir)) return 0;

  const files = readdirSync(dir)
    .filter(f => f.startsWith("memory-items."))
    .sort()
    .reverse();

  // Group by base name (each snapshot has .md + .json)
  const mdFiles = files.filter(f => f.endsWith(".md"));
  let pruned = 0;

  for (let i = maxKeep; i < mdFiles.length; i++) {
    const md = mdFiles[i];
    const json = md.replace(".md", ".json");
    try {
      unlinkSync(join(dir, md));
      if (existsSync(join(dir, json))) unlinkSync(join(dir, json));
      pruned++;
    } catch { /* ignore */ }
  }

  return pruned;
}

// ── Auto-Revert Helper ────────────────────────────────────────

/**
 * 写入后自动检查质量，必要时回滚。
 * 返回最终质量检查结果。
 */
export function postWriteGuard(
  cwd: string,
  snapshot: SnapshotResult,
  baseline: QualityMetrics,
): QualityCheck {
  const check = checkQuality(cwd, baseline);
  const config = loadConfig(cwd);

  if (!check.ok && config.rollback.autoRevert) {
    console.warn(`[AutoRevert] ${check.alert}`);
    rollbackToSnapshot(cwd, snapshot.snapshotPath);
    return { ...check, alert: `${check.alert} → 已自动回滚` };
  }

  return check;
}
