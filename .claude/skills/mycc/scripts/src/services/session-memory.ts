/**
 * session-memory.ts — Session 结束自动提取（Phase 2）
 *
 * 触发路径：
 * 1. chat-memory.ts 的 onSessionEnd() 末尾自动调用
 * 2. POST /memory/extract-session 手动触发
 *
 * 流程：
 * 1. 检查 config flag → sessionExtraction.enabled
 * 2. 检查 DAG token 总量 > MIN_TOKEN_THRESHOLD（过滤短对话）
 * 3. createSnapshot() 快照
 * 4. 调 Codex 从 RECENT_EVENTS + DAG 摘要提取原子记忆
 * 5. 索引同步 syncAll()
 * 6. postWriteGuard() 质量门
 *
 * 安全原则：所有写入前 createSnapshot()，写后 postWriteGuard()。
 * 功能开关：memory-config.json 的 sessionExtraction.enabled 控制。
 */

import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { runCliEngine } from "../adapters/cli-engine.js";
import {
  loadConfig,
  createSnapshot,
  computeMetrics,
  postWriteGuard,
} from "./memory-rollback.js";
import { syncAll } from "./memory-db.js";

// ── Types ──────────────────────────────────────────────────────

export interface ExtractionResult {
  readonly success: boolean;
  readonly extracted: number;
  readonly detail: string;
  readonly error?: string;
}

// ── Constants ──────────────────────────────────────────────────

const MEMORY_ITEMS_PATH = "0-System/memory-items.md";
const RECENT_EVENTS_PATH = "0-System/RECENT_EVENTS.md";

/** 最少 DAG token 数才触发提取（过滤闲聊短 session） */
const MIN_TOKEN_THRESHOLD = 200;

/** Codex 提取超时（ms） */
const EXTRACTION_TIMEOUT = 120_000;

// ── Main Entry ─────────────────────────────────────────────────

/**
 * 从最近事件 + 对话摘要提取原子记忆。
 * 由 onSessionEnd 自动触发，或 POST /memory/extract-session 手动触发。
 *
 * @param cwd mycc 根目录
 * @param dagTokenCount DAG 中的 token 总量（可选，手动触发时不传则跳过阈值检查）
 */
export async function extractFromSession(
  cwd: string,
  dagTokenCount?: number,
): Promise<ExtractionResult> {
  // 检查功能开关
  const config = loadConfig(cwd);
  if (!config.sessionExtraction.enabled) {
    return { success: true, extracted: 0, detail: "sessionExtraction 已关闭，跳过" };
  }

  // 检查 token 阈值
  if (dagTokenCount !== undefined && dagTokenCount < MIN_TOKEN_THRESHOLD) {
    return { success: true, extracted: 0, detail: `token 量不足 (${dagTokenCount} < ${MIN_TOKEN_THRESHOLD})` };
  }

  console.log("[SessionMemory] 开始 session 记忆提取...");

  // Step 1: Snapshot
  let snapshot;
  let baseline;
  try {
    snapshot = createSnapshot(cwd);
    baseline = computeMetrics(cwd);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, extracted: 0, detail: "快照失败", error: msg };
  }

  // Step 2: 收集提取素材
  const material = buildExtractionMaterial(cwd);
  if (!material) {
    return { success: true, extracted: 0, detail: "无可提取素材" };
  }

  // Step 3: 调 Codex 提取
  const memoryFilePath = join(cwd, MEMORY_ITEMS_PATH);
  const prompt = buildExtractionPrompt(material, memoryFilePath);

  try {
    const result = await runCliEngine("codex", prompt, cwd, {
      reasoningEffort: "high",
      timeout: EXTRACTION_TIMEOUT,
    });

    if (result.error === "USER_ABORTED") {
      return { success: true, extracted: 0, detail: "用户中止" };
    }

    if (result.error) {
      console.warn(`[SessionMemory] Codex 提取失败: ${result.error.substring(0, 100)}`);
      return { success: false, extracted: 0, detail: "Codex 提取失败", error: result.error };
    }

    const output = result.output.trim();
    if (output.includes("NO_NEW_FACTS")) {
      console.log("[SessionMemory] 无新事实");
      return { success: true, extracted: 0, detail: "无新事实" };
    }

    // Step 4: 索引同步
    syncAll(cwd);

    // Step 5: 质量门
    const check = postWriteGuard(cwd, snapshot, baseline);
    if (!check.ok) {
      console.warn(`[SessionMemory] 质量门未通过: ${check.alert}`);
      return {
        success: false,
        extracted: 0,
        detail: "质量门未通过，已回滚",
        error: check.alert,
      };
    }

    // 估算提取条数（按行数）
    const linesBefore = snapshot.itemCount;
    const linesAfter = check.metrics.itemCount;
    const extracted = Math.max(0, linesAfter - linesBefore);

    console.log(`[SessionMemory] 提取完成 (+${extracted} items)`);
    return { success: true, extracted, detail: `提取 ${extracted} 条新记忆` };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[SessionMemory] 未预期错误: ${msg}`);
    return { success: false, extracted: 0, detail: "异常", error: msg };
  }
}

/**
 * 从 RECENT_EVENTS 提取（手动触发入口，不依赖 DAG）。
 * 供 POST /memory/extract-session 使用。
 */
export async function extractFromRecentEvents(cwd: string): Promise<ExtractionResult> {
  return extractFromSession(cwd);
}

// ── Helpers ────────────────────────────────────────────────────

/**
 * 收集提取素材：RECENT_EVENTS 最近内容。
 * 返回 null 表示无可用素材。
 */
function buildExtractionMaterial(cwd: string): string | null {
  const parts: string[] = [];

  // RECENT_EVENTS（最近 50 行）
  const eventsPath = join(cwd, RECENT_EVENTS_PATH);
  if (existsSync(eventsPath)) {
    const content = readFileSync(eventsPath, "utf-8");
    const lines = content.split("\n");
    const recent = lines.slice(-50);
    if (recent.length > 0) {
      parts.push(`## 最近事件\n\n${recent.join("\n")}`);
    }
  }

  if (parts.length === 0) return null;
  return parts.join("\n\n");
}

/**
 * 构建 Codex 提取 prompt（复用 auto-capture 的模板风格）。
 */
function buildExtractionPrompt(material: string, memoryFilePath: string): string {
  return `你是一个记忆提取器，任务是从以下 session 素材中提取**新的、可复用的原子事实**，追加到记忆文件。

## Session 素材

${material}

## 记忆文件路径

${memoryFilePath}

## 提取规则

1. **先读取文件**，了解现有内容和分类结构。
2. 只提取**新的、具体的、可独立检索的原子事实**。不重复已有内容。
3. 使用正确的命名空间：
   - \`[user/*]\` — 关于用户的跨项目偏好、习惯、方法论
   - \`[project/*]\` — 关于 mycc 项目的技术、路径、配置、决策
4. 叶子原则：每条 Item 是最小可用单元，不写概要性描述。
5. 如果没有值得提取的新事实，**直接输出 "NO_NEW_FACTS" 即可，不要修改文件**。
6. 每次最多追加 5 条（session 级提取可比单轮多）。
7. 追加到最相关的分类下，没有合适分类就追加到 \`[project/状态]\`。
8. **双时间戳**：每条 Item 行末加 \`[YYYY-MM-DD]\` 写入日期。
9. **残差链格式**（v4 TurboQuant）：
   - 全新事实 → 正常追加
   - 更新已有基线 → 行末加 \`→Δ:基线关键词\`（增量修改，保留原基线）
   - 完全替换旧事实 → 行末加 \`→supersedes:旧关键词\`
   - 如果现有 item 有 \`#base\` 标记，你的增量应该用 \`→Δ:\` 而不是直接修改它
10. **星级评定**：★★★ = 核心决策/架构 / ★★ = 重要配置/路径 / ★ = 一般记录

## 操作

请执行：读文件 → 判断哪些是新事实 → 追加到文件（或输出 NO_NEW_FACTS）。`;
}
