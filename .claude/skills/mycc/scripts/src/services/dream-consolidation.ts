/**
 * dream-consolidation.ts — 记忆巩固（Dream Phase 1）
 *
 * 每日 04:00 由 scheduler 触发，执行七步流水线：
 * 1. snapshot — 快照当前 memory-items.md
 * 2. delta merge — 合并 RECENT_EVENTS → memory-items delta
 * 3. archive — 归档 >30天 低频 items 到 5-Archive/
 * 4. RECENT_EVENTS cleanup — 清理 >7天 事件
 * 5. vector rebuild — 触发 SQLite 向量重建
 * 6. SQLite sync — syncAll 确保 md→SQLite 一致
 * 7. quality gate — postWriteGuard 检查，失败自动回滚
 *
 * 安全原则：所有写入前 createSnapshot()，写后 postWriteGuard()。
 * 功能开关：memory-config.json 的 dreamConsolidation.enabled 控制。
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadConfig,
  createSnapshot,
  computeMetrics,
  postWriteGuard,
  pruneSnapshots,
  type SnapshotResult,
  type QualityMetrics,
} from "./memory-rollback.js";
import { syncAll, getDB } from "./memory-db.js";

// ── Types ──────────────────────────────────────────────────────

export interface DreamResult {
  readonly success: boolean;
  readonly steps: ReadonlyArray<StepResult>;
  readonly duration: number;
  readonly error?: string;
}

interface StepResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

// ── Constants ──────────────────────────────────────────────────

const MEMORY_ITEMS_PATH = "0-System/memory-items.md";
const RECENT_EVENTS_PATH = "0-System/RECENT_EVENTS.md";
const ARCHIVE_DIR = "5-Archive";
const ARCHIVE_MEMORY_FILE = "archived-memory-items.md";

/** 事件保留天数 */
const EVENTS_RETAIN_DAYS = 7;

/** 归档阈值天数（超过此天数的低星 item 被归档） */
const ARCHIVE_THRESHOLD_DAYS = 30;

/** 低星阈值（≤ 此星数的 item 被归档） */
const ARCHIVE_STAR_THRESHOLD = 1;

/** Hebbian 免疫阈值：access_count ≥ 此值的 item 免于时间衰减归档（LSTM 遗忘门启发） */
const HEBBIAN_IMMUNITY_THRESHOLD = 3;

// ── Main Pipeline ──────────────────────────────────────────────

/**
 * 执行完整 Dream 记忆巩固流水线。
 * 由 scheduler 的 04:00 任务调用，或通过 POST /memory/dream 手动触发。
 */
export async function runDream(cwd: string): Promise<DreamResult> {
  const start = Date.now();
  const steps: StepResult[] = [];

  // 检查功能开关
  const config = loadConfig(cwd);
  if (!config.dreamConsolidation.enabled) {
    return {
      success: true,
      steps: [{ name: "config-check", ok: true, detail: "dreamConsolidation 已关闭，跳过" }],
      duration: Date.now() - start,
    };
  }

  console.log("[Dream] 开始记忆巩固流水线...");

  // Step 1: Snapshot
  let snapshot: SnapshotResult;
  let baseline: QualityMetrics;
  try {
    snapshot = createSnapshot(cwd);
    baseline = computeMetrics(cwd);
    steps.push({ name: "snapshot", ok: true, detail: `快照完成 (${snapshot.itemCount} items)` });
    console.log(`[Dream] Step 1/7 snapshot ✓ (${snapshot.itemCount} items)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    steps.push({ name: "snapshot", ok: false, detail: msg });
    return { success: false, steps, duration: Date.now() - start, error: msg };
  }

  // Step 2: Delta Merge — 从 RECENT_EVENTS 提取可沉淀条目
  try {
    const merged = stepDeltaMerge(cwd);
    steps.push({ name: "delta-merge", ok: true, detail: merged });
    console.log(`[Dream] Step 2/7 delta-merge ✓ (${merged})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    steps.push({ name: "delta-merge", ok: false, detail: msg });
    // 非致命，继续
  }

  // Step 3: Archive — 归档低频旧 items
  try {
    const archived = stepArchiveOldItems(cwd);
    steps.push({ name: "archive", ok: true, detail: archived });
    console.log(`[Dream] Step 3/7 archive ✓ (${archived})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    steps.push({ name: "archive", ok: false, detail: msg });
  }

  // Step 3.5: Conflict Detection — Hopfield 串扰防护
  try {
    const conflicts = stepDetectConflicts(cwd);
    steps.push({ name: "conflict-detect", ok: true, detail: conflicts });
    console.log(`[Dream] Step 3.5/8 conflict-detect ✓ (${conflicts})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    steps.push({ name: "conflict-detect", ok: false, detail: msg });
  }

  // Step 4: RECENT_EVENTS Cleanup
  try {
    const cleaned = stepCleanRecentEvents(cwd);
    steps.push({ name: "events-cleanup", ok: true, detail: cleaned });
    console.log(`[Dream] Step 4/8 events-cleanup ✓ (${cleaned})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    steps.push({ name: "events-cleanup", ok: false, detail: msg });
  }

  // Step 5: Vector Rebuild（通过 syncAll 触发）
  // Step 6: SQLite Sync
  try {
    const synced = syncAll(cwd);
    steps.push({ name: "sqlite-sync", ok: synced, detail: synced ? "同步完成" : "同步失败（降级文件模式）" });
    console.log(`[Dream] Step 5-6/7 sqlite-sync ${synced ? "✓" : "⚠"}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    steps.push({ name: "sqlite-sync", ok: false, detail: msg });
  }

  // Step 7: Quality Gate
  try {
    const check = postWriteGuard(cwd, snapshot, baseline);
    steps.push({
      name: "quality-gate",
      ok: check.ok,
      detail: check.ok
        ? `质量检查通过 (items=${check.metrics.itemCount})`
        : (check.alert ?? "质量下降"),
    });
    console.log(`[Dream] Step 7/7 quality-gate ${check.ok ? "✓" : "⚠ " + (check.alert ?? "")}`);

    // P1-6: Dream 飞书告警 — 质量门失败时发通知
    if (!check.ok) {
      try {
        const { spawnSync } = await import("node:child_process");
        const SEND_JS = join(cwd, ".claude/skills/tell-me/send.js");
        const alertMsg = `⚠️ Dream 记忆巩固质量下降\n\n${check.alert ?? "未知原因"}\n\n已自动回滚到快照。请检查 memory-items.md。`;
        spawnSync("node", [SEND_JS, "Dream 质量告警", alertMsg, "red"], {
          timeout: 10_000,
          encoding: "utf8",
        });
      } catch (notifyErr) {
        console.warn("[Dream] 飞书告警发送失败:", notifyErr);
      }

      return {
        success: false,
        steps,
        duration: Date.now() - start,
        error: check.alert,
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    steps.push({ name: "quality-gate", ok: false, detail: msg });
  }

  // 清理旧快照
  pruneSnapshots(cwd);

  const duration = Date.now() - start;
  console.log(`[Dream] 记忆巩固完成 (${duration}ms, ${steps.filter(s => s.ok).length}/${steps.length} steps ok)`);

  return { success: steps.every(s => s.ok), steps, duration };
}

// ── Step Implementations ───────────────────────────────────────

/**
 * Step 2: Delta Merge
 * 从 RECENT_EVENTS.md 提取可沉淀为 memory-items 的条目。
 * 规则：含 [沉淀] 或 [记忆] 标记的行，提取后追加到 memory-items.md。
 */
function stepDeltaMerge(cwd: string): string {
  const eventsPath = join(cwd, RECENT_EVENTS_PATH);
  if (!existsSync(eventsPath)) return "无 RECENT_EVENTS 文件";

  const content = readFileSync(eventsPath, "utf-8");
  const lines = content.split("\n");

  // 查找带 [沉淀] [记忆] [memory] 标记的行
  const sedimentLines = lines.filter(line =>
    /\[(沉淀|记忆|memory)\]/i.test(line) && line.trim().startsWith("-"),
  );

  if (sedimentLines.length === 0) return "无可沉淀条目";

  // 读取 memory-items 追加
  const memPath = join(cwd, MEMORY_ITEMS_PATH);
  const today = new Date().toISOString().slice(0, 10);

  const newItems = sedimentLines.map(line => {
    // 去掉标记，保留内容
    const cleaned = line
      .replace(/\[(沉淀|记忆|memory)\]/gi, "")
      .replace(/^\s*-\s*/, "- ")
      .trim();
    // 如果没有日期标记，加上
    return cleaned.includes("[20") ? cleaned : `${cleaned} [${today}]`;
  });

  // 追加到 memory-items 的 [project/状态] section 下
  const itemsContent = readFileSync(memPath, "utf-8");
  const marker = "## [project/状态]";
  const markerIdx = itemsContent.indexOf(marker);

  if (markerIdx >= 0) {
    // 找到 section，追加到 section 末尾（下一个 ## 之前）
    const afterMarker = itemsContent.indexOf("\n## ", markerIdx + marker.length);
    const insertPos = afterMarker >= 0 ? afterMarker : itemsContent.length;
    const updatedContent = itemsContent.slice(0, insertPos) +
      "\n" + newItems.join("\n") + "\n" +
      itemsContent.slice(insertPos);
    writeFileSync(memPath, updatedContent, "utf-8");
  } else {
    // 没有 section，追加到末尾
    appendFileSync(memPath, `\n\n${marker}\n\n${newItems.join("\n")}\n`, "utf-8");
  }

  return `沉淀 ${newItems.length} 条`;
}

/**
 * Step 3: Archive Old Items
 * 归档超过 ARCHIVE_THRESHOLD_DAYS 且星数 ≤ ARCHIVE_STAR_THRESHOLD 的 items。
 * v9 Hebbian 免疫：access_count ≥ HEBBIAN_IMMUNITY_THRESHOLD 的 item 免于时间衰减归档。
 * 启发来源：LSTM 遗忘门 + Hebbian 学习 —— 高频使用的记忆不应被遗忘。
 */
function stepArchiveOldItems(cwd: string): string {
  const memPath = join(cwd, MEMORY_ITEMS_PATH);
  if (!existsSync(memPath)) return "memory-items 不存在";

  // 从 SQLite 获取 access_count 数据（Hebbian 免疫查询）
  const accessCounts = new Map<string, number>();
  try {
    const db = getDB(cwd);
    if (db) {
      const rows = db.prepare(
        "SELECT content, access_count FROM items WHERE access_count >= ?",
      ).all(HEBBIAN_IMMUNITY_THRESHOLD) as Array<{ content: string; access_count: number }>;
      for (const row of rows) {
        // 用 content 前 40 字符做模糊匹配键（md 行 vs SQLite 行可能有微小差异）
        const key = row.content.slice(0, 40).trim();
        accessCounts.set(key, row.access_count);
      }
    }
  } catch { /* SQLite 不可用时降级为纯规则归档 */ }

  const content = readFileSync(memPath, "utf-8");
  const lines = content.split("\n");
  const now = Date.now();
  const thresholdMs = ARCHIVE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;

  const toArchive: string[] = [];
  const kept: string[] = [];
  let immuneCount = 0;

  for (const line of lines) {
    // 只处理 item 行（以 - 开头且含 ★）
    if (!line.startsWith("- ") || !line.includes("★")) {
      kept.push(line);
      continue;
    }

    // 解析日期
    const dateMatch = line.match(/(?<!\bevent:)\[(\d{4}-\d{2}-\d{2})\]/);
    const starCount = (line.match(/★/g) || []).length;

    if (dateMatch && starCount <= ARCHIVE_STAR_THRESHOLD) {
      const itemDate = new Date(dateMatch[1]).getTime();
      if (now - itemDate > thresholdMs) {
        // Hebbian 免疫检查：高频使用的 item 跳过归档
        const lineKey = line.replace(/^- ★+ /, "").slice(0, 40).trim();
        const isImmune = Array.from(accessCounts.keys()).some(
          (k) => k.includes(lineKey.slice(0, 20)) || lineKey.includes(k.slice(0, 20)),
        );
        if (isImmune) {
          kept.push(line);
          immuneCount++;
          continue;
        }
        toArchive.push(line);
        continue;
      }
    }

    kept.push(line);
  }

  if (toArchive.length === 0) {
    const immuneNote = immuneCount > 0 ? `（${immuneCount} 条因高频使用获 Hebbian 免疫）` : "";
    return `无需归档${immuneNote}`;
  }

  // 写入归档文件
  const archivePath = join(cwd, ARCHIVE_DIR, ARCHIVE_MEMORY_FILE);
  const archiveHeader = `# 归档记忆条目\n\n> 由 Dream 记忆巩固自动归档（${new Date().toISOString().slice(0, 10)}）\n\n`;

  if (existsSync(archivePath)) {
    appendFileSync(archivePath, "\n" + toArchive.join("\n") + "\n", "utf-8");
  } else {
    writeFileSync(archivePath, archiveHeader + toArchive.join("\n") + "\n", "utf-8");
  }

  // 更新 memory-items（移除已归档行）
  writeFileSync(memPath, kept.join("\n"), "utf-8");

  const immuneNote = immuneCount > 0 ? `，${immuneCount} 条 Hebbian 免疫` : "";
  return `归档 ${toArchive.length} 条低频旧 items${immuneNote}`;
}

/**
 * Step 3.5: Detect Conflicts — Hopfield 串扰防护
 * 在同一 category 内检测语义相近但可能矛盾的 items。
 * 检测到的冲突对标记 [⚡conflict] 前缀，cc 下次 session 加载时可决策取舍。
 * 启发来源：Hopfield 网络存储模式过多时出现伪吸引子（spurious states），
 * 类比记忆系统中语义相近但事实矛盾的条目互相干扰。
 */
function stepDetectConflicts(cwd: string): string {
  const db = getDB(cwd);
  if (!db) return "SQLite 不可用，跳过冲突检测";

  // 查询同 category 下的 items，按 category 分组
  const rows = db.prepare(
    "SELECT id, category, content FROM items WHERE content NOT LIKE '%[⚡conflict]%' ORDER BY category",
  ).all() as Array<{ id: string; category: string; content: string }>;

  // 按 category 分组
  const grouped = new Map<string, Array<{ id: string; content: string }>>();
  for (const row of rows) {
    const items = grouped.get(row.category) ?? [];
    items.push({ id: row.id, content: row.content });
    grouped.set(row.category, items);
  }

  let conflictCount = 0;
  const conflictPairs: string[] = [];

  for (const [category, items] of grouped) {
    if (items.length < 2) continue;

    // 两两比较同 category 内的 items（O(n²) 但每个 category 条目少）
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const similarity = computeJaccard(items[i].content, items[j].content);
        // Jaccard > 0.4 且没有版本链关系（→updates: / →Δ: / →supersedes:）
        if (similarity > 0.4) {
          const hasVersionChain = items[i].content.includes("→") || items[j].content.includes("→");
          if (!hasVersionChain) {
            conflictCount++;
            conflictPairs.push(`[${category}] "${items[i].content.slice(0, 30)}..." ↔ "${items[j].content.slice(0, 30)}..."`);
          }
        }
      }
    }
  }

  if (conflictCount === 0) return "未检测到冲突";

  // 将冲突信息写入 RECENT_EVENTS 供 cc 下次 session 发现
  const eventsPath = join(cwd, RECENT_EVENTS_PATH);
  const conflictNote = `\n- \`${new Date().toISOString().slice(11, 16)}\` [Dream 冲突检测] 发现 ${conflictCount} 对潜在记忆冲突，需 cc 决策：\n${conflictPairs.slice(0, 5).map((p) => `  - ${p}`).join("\n")}\n`;
  if (existsSync(eventsPath)) {
    appendFileSync(eventsPath, conflictNote, "utf-8");
  }

  return `检测到 ${conflictCount} 对潜在冲突，已写入 RECENT_EVENTS`;
}

/** Jaccard 相似度：基于词集合的重叠度 */
function computeJaccard(a: string, b: string): number {
  const tokenize = (s: string): Set<string> => {
    const tokens = s.toLowerCase()
      .replace(/[★\[\]()（）]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1);
    return new Set(tokens);
  };
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }
  return intersection / (setA.size + setB.size - intersection);
}

/**
 * Step 4: Clean RECENT_EVENTS
 * 清理超过 EVENTS_RETAIN_DAYS 天的事件行。
 */
function stepCleanRecentEvents(cwd: string): string {
  const eventsPath = join(cwd, RECENT_EVENTS_PATH);
  if (!existsSync(eventsPath)) return "无 RECENT_EVENTS 文件";

  const content = readFileSync(eventsPath, "utf-8");
  const lines = content.split("\n");
  const now = Date.now();
  const retainMs = EVENTS_RETAIN_DAYS * 24 * 60 * 60 * 1000;

  let removed = 0;
  const kept: string[] = [];

  for (const line of lines) {
    // 事件行通常含日期标记 [YYYY-MM-DD] 或 YYYY-MM-DD
    const dateMatch = line.match(/(\d{4}-\d{2}-\d{2})/);
    if (dateMatch) {
      const eventDate = new Date(dateMatch[1]).getTime();
      if (now - eventDate > retainMs) {
        removed++;
        continue;
      }
    }
    kept.push(line);
  }

  if (removed === 0) return "无过期事件";

  writeFileSync(eventsPath, kept.join("\n"), "utf-8");
  return `清理 ${removed} 条过期事件`;
}
