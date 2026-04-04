/**
 * P2 每日巩固：过期清理 + Δ 基线重建 + 矛盾检测三步法
 *
 * 三个阶段：
 * 1. 过期清理（纯规则，不需要 LLM）
 * 2. Δ 自动巩固（需要 LLM 合并基线）
 * 3. 矛盾检测（需要 LLM 判断 + 处理）
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { chatCompletion } from "../adapters/openai-compat.js";
import type { MemoryLLMRoute } from "../config.js";

// ─── 类型定义 ───

export interface ConsolidationResult {
  expired: number;
  archived: number;
  basesRebuilt: number;
  conflictsResolved: number;
  errors: string[];
}

interface ParsedLine {
  raw: string;
  star: number;
  content: string;
  writeDate: string;       // YYYY-MM-DD
  eventDate: string | null; // [event:YYYY-MM-DD]
  tags: string[];
  isBase: boolean;
  deltaRef: string | null;  // →Δ:xxx 的 xxx
  hasConflict: boolean;     // [?conflict]
}

interface ParsedSection {
  header: string;
  lines: ParsedLine[];
  rawLines: string[];       // 保留原始行（包括非 item 行）
}

// ─── 解析工具 ───

function parseLine(raw: string): ParsedLine | null {
  if (!raw.startsWith("- ")) return null;

  const starMatch = raw.match(/^- (★+)/);
  const star = starMatch ? starMatch[1].length : 2;

  const dateMatch = raw.match(/\[(\d{4}-\d{2}-\d{2})\]/);
  const writeDate = dateMatch ? dateMatch[1] : "";

  const eventMatch = raw.match(/\[event:(\d{4}-\d{2}-\d{2})\]/);
  const eventDate = eventMatch ? eventMatch[1] : null;

  const tagMatches = raw.match(/#(\S+)/g) ?? [];
  const tags = tagMatches.map(t => t.slice(1));

  const isBase = tags.includes("base");
  const deltaMatch = raw.match(/→Δ:(\S+)/);
  const deltaRef = deltaMatch ? deltaMatch[1] : null;

  const hasConflict = raw.includes("[?conflict]");

  // 提取 content：去掉星号后，到第一个 [ 或 # 之前
  const afterStar = raw.replace(/^- ★+ /, "").replace(/^- /, "");
  const contentEnd = afterStar.search(/\s*\[|\s*#|\s*→/);
  const content = contentEnd === -1 ? afterStar.trim() : afterStar.slice(0, contentEnd).trim();

  return { raw, star, content, writeDate, eventDate, tags, isBase, deltaRef, hasConflict };
}

function parseMemoryFile(filePath: string): { preamble: string[]; sections: ParsedSection[] } {
  if (!existsSync(filePath)) return { preamble: [], sections: [] };

  const content = readFileSync(filePath, "utf-8");
  const allLines = content.split("\n");
  const preamble: string[] = [];
  const sections: ParsedSection[] = [];
  let current: ParsedSection | null = null;

  for (const line of allLines) {
    const catMatch = line.match(/^###?\s*\[.+?\]/);
    if (catMatch) {
      current = { header: line, lines: [], rawLines: [] };
      sections.push(current);
    } else if (current) {
      current.rawLines.push(line);
      const parsed = parseLine(line);
      if (parsed) {
        current.lines.push(parsed);
      }
    } else {
      preamble.push(line);
    }
  }

  return { preamble, sections };
}

function serializeFile(preamble: string[], sections: ParsedSection[]): string {
  const parts: string[] = [];

  if (preamble.length > 0) {
    parts.push(preamble.join("\n"));
  }

  for (const section of sections) {
    if (section.lines.length === 0) continue; // 跳过空 section
    parts.push(section.header);
    parts.push(section.lines.map(l => l.raw).join("\n"));
  }

  return parts.join("\n");
}

// ─── 日期工具 ───

function daysBetween(dateStr: string, today: Date): number {
  const d = new Date(dateStr + "T00:00:00Z");
  const t = new Date(today.toISOString().slice(0, 10) + "T00:00:00Z");
  return Math.floor((t.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
}

// ─── Phase 1: 过期清理（不需要 LLM）───

function runExpiredCleanup(
  sections: ParsedSection[],
  archivePath: string,
  today: Date,
): { expired: number; archived: number } {
  let expired = 0;
  let archived = 0;
  const archiveLines: string[] = [];

  for (const section of sections) {
    const kept: ParsedLine[] = [];

    for (const line of section.lines) {
      // 条件 1：eventDate 过期 >7 天 → 删除
      if (line.eventDate) {
        const daysOver = daysBetween(line.eventDate, today);
        if (daysOver > 7) {
          expired++;
          continue;
        }
      }

      // 条件 2/3 基于 writeDate
      if (line.writeDate) {
        const age = daysBetween(line.writeDate, today);

        // 条件 3：写入 >120 天 → 无条件归档
        if (age > 120) {
          archiveLines.push(line.raw);
          archived++;
          continue;
        }

        // 条件 2：写入 >90 天且 ★<3 → 归档
        if (age > 90 && line.star < 3) {
          archiveLines.push(line.raw);
          archived++;
          continue;
        }
      }

      kept.push(line);
    }

    section.lines = kept;
  }

  // 追加到归档文件
  if (archiveLines.length > 0) {
    const archiveDir = dirname(archivePath);
    mkdirSync(archiveDir, { recursive: true });

    const dateStr = today.toISOString().slice(0, 10);
    const header = `\n## Archived on ${dateStr}\n`;
    const archiveContent = header + archiveLines.join("\n") + "\n";
    appendFileSync(archivePath, archiveContent, "utf-8");
  }

  return { expired, archived };
}

// ─── Phase 2: Δ 自动巩固（需要 LLM）───

interface BaseGroup {
  section: ParsedSection;
  baseLine: ParsedLine;
  deltas: ParsedLine[];
  baseTag: string; // #base 对应的主题 tag
}

function findBaseGroups(sections: ParsedSection[]): BaseGroup[] {
  const groups: BaseGroup[] = [];

  for (const section of sections) {
    // 找到所有 #base 条目
    const bases = section.lines.filter(l => l.isBase);

    for (const baseLine of bases) {
      // base 的非 "base" tag 作为主题标识
      const baseTags = baseLine.tags.filter(t => t !== "base");
      if (baseTags.length === 0) continue;

      const baseTag = baseTags[0];

      // 找到引用这个 base 的 Δ 条目
      const deltas = section.lines.filter(l => {
        if (!l.deltaRef) return false;
        // deltaRef 可能是完整 tag 或部分匹配
        return baseTags.some(bt => l.deltaRef!.includes(bt) || bt.includes(l.deltaRef!));
      });

      if (deltas.length >= 3) {
        groups.push({ section, baseLine, deltas, baseTag });
      }
    }
  }

  return groups;
}

async function rebuildBase(
  group: BaseGroup,
  route: MemoryLLMRoute,
): Promise<string> {
  const baseContent = group.baseLine.raw;
  const deltaContents = group.deltas.map(d => d.raw).join("\n");

  const prompt = `你是记忆管理助手。请合并以下基线和增量为一条新基线。

规则：
1. 保留所有具体值（路径、端口、版本号、配置参数）
2. 丢弃过程性描述（"修复了"、"改为"等动作词简化为最终状态）
3. 输出格式：只输出一行，格式为 "- ★★★ [合并后的内容描述] #base #${group.baseTag}"
4. 不要输出任何解释，只输出那一行

基线：
${baseContent}

增量：
${deltaContents}`;

  const result = await chatCompletion({
    baseURL: route.baseURL,
    apiKey: route.apiKey,
    model: route.model,
    messages: [{ role: "user", content: prompt }],
    max_tokens: route.maxTokens ?? 2048,
  });

  return result.content.trim();
}

async function runDeltaConsolidation(
  sections: ParsedSection[],
  route: MemoryLLMRoute,
): Promise<{ basesRebuilt: number; errors: string[] }> {
  const groups = findBaseGroups(sections);
  let basesRebuilt = 0;
  const errors: string[] = [];

  for (const group of groups) {
    try {
      const newBaseLine = await rebuildBase(group, route);

      // 验证 LLM 输出格式
      if (!newBaseLine.startsWith("- ")) {
        errors.push(`Invalid LLM output for base "${group.baseTag}": ${newBaseLine.slice(0, 80)}`);
        continue;
      }

      const today = new Date().toISOString().slice(0, 10);

      // 构建新的 ParsedLine
      const newParsed = parseLine(`${newBaseLine} [${today}]`);
      if (!newParsed) {
        errors.push(`Failed to parse rebuilt base for "${group.baseTag}"`);
        continue;
      }

      // 从 section 中移除旧 base 和所有 Δ
      const removeSet = new Set([
        group.baseLine.raw,
        ...group.deltas.map(d => d.raw),
      ]);

      group.section.lines = group.section.lines.filter(l => !removeSet.has(l.raw));

      // 插入新 base
      group.section.lines.unshift(newParsed);

      basesRebuilt++;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`Delta consolidation failed for "${group.baseTag}": ${msg}`);
    }
  }

  return { basesRebuilt, errors };
}

// ─── Phase 3: 矛盾检测三步法（需要 LLM）───

interface ConflictItem {
  section: ParsedSection;
  line: ParsedLine;
}

function findConflictItems(sections: ParsedSection[]): ConflictItem[] {
  const items: ConflictItem[] = [];
  for (const section of sections) {
    for (const line of section.lines) {
      if (line.hasConflict) {
        items.push({ section, line });
      }
    }
  }
  return items;
}

function findRelatedItems(section: ParsedSection, conflictLine: ParsedLine): ParsedLine[] {
  return section.lines.filter(l => {
    if (l.raw === conflictLine.raw) return false;
    if (l.hasConflict) return false;
    // 同 tag 匹配
    const sharedTags = l.tags.filter(t => conflictLine.tags.includes(t) && t !== "base");
    return sharedTags.length > 0;
  });
}

interface ConflictJudgment {
  isConflict: boolean;
  action: "delete_old" | "supersede" | "remove_mark" | "keep_both";
  oldItemIndex?: number; // 被替代的旧条目在 related 中的 index
  reason: string;
}

async function judgeConflict(
  conflictLine: ParsedLine,
  relatedItems: ParsedLine[],
  route: MemoryLLMRoute,
): Promise<ConflictJudgment> {
  const relatedText = relatedItems.map((r, i) => `[${i}] ${r.raw}`).join("\n");

  const prompt = `你是记忆矛盾检测助手。判断标记了 [?conflict] 的新条目是否与已有条目真的矛盾。

判定标准：
- 同一主题实体 + 结论不同 → 矛盾
- 同一 tag 但不同实体 → 不矛盾
- 补充信息（非矛盾） → 不矛盾

新条目：
${conflictLine.raw}

同类别已有条目：
${relatedText || "（无相关条目）"}

请用 JSON 回复（不要 markdown 代码块）：
{
  "isConflict": true/false,
  "action": "delete_old" | "supersede" | "remove_mark" | "keep_both",
  "oldItemIndex": 0,
  "reason": "一句话原因"
}

action 说明：
- "delete_old": 矛盾且旧条目无 #base → 删旧写新
- "supersede": 矛盾且旧条目有 #base → 新写为 supersedes，旧基线及 Δ 全删
- "remove_mark": 非矛盾 → 去掉 [?conflict] 标记
- "keep_both": 无法判断 → 保留两者，去掉标记`;

  const result = await chatCompletion({
    baseURL: route.baseURL,
    apiKey: route.apiKey,
    model: route.model,
    messages: [{ role: "user", content: prompt }],
    max_tokens: route.maxTokens ?? 1024,
  });

  try {
    // 尝试从 LLM 回复中提取 JSON
    const text = result.content.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { isConflict: false, action: "remove_mark", reason: "LLM output not parseable" };
    }
    const parsed = JSON.parse(jsonMatch[0]) as ConflictJudgment;
    // 确保 action 合法
    const validActions = ["delete_old", "supersede", "remove_mark", "keep_both"] as const;
    if (!validActions.includes(parsed.action as typeof validActions[number])) {
      parsed.action = "remove_mark";
    }
    return parsed;
  } catch {
    return { isConflict: false, action: "remove_mark", reason: "JSON parse failed" };
  }
}

async function runConflictResolution(
  sections: ParsedSection[],
  route: MemoryLLMRoute,
): Promise<{ conflictsResolved: number; errors: string[] }> {
  const conflictItems = findConflictItems(sections);
  let conflictsResolved = 0;
  const errors: string[] = [];

  for (const { section, line } of conflictItems) {
    try {
      const related = findRelatedItems(section, line);
      const judgment = await judgeConflict(line, related, route);

      switch (judgment.action) {
        case "delete_old": {
          // 删除旧条目，清除新条目的 [?conflict] 标记
          if (judgment.oldItemIndex !== undefined && judgment.oldItemIndex < related.length) {
            const oldItem = related[judgment.oldItemIndex];
            section.lines = section.lines.filter(l => l.raw !== oldItem.raw);
          }
          line.raw = line.raw.replace(" [?conflict]", "").replace("[?conflict]", "");
          line.hasConflict = false;
          conflictsResolved++;
          break;
        }

        case "supersede": {
          // 旧基线 + 所有 Δ 全删，新条目去掉标记
          if (judgment.oldItemIndex !== undefined && judgment.oldItemIndex < related.length) {
            const oldBase = related[judgment.oldItemIndex];
            const oldBaseTags = oldBase.tags.filter(t => t !== "base");

            // 删除旧基线 + 所有引用它的 Δ
            const toRemove = new Set<string>();
            toRemove.add(oldBase.raw);
            for (const sl of section.lines) {
              if (sl.deltaRef && oldBaseTags.some(bt => sl.deltaRef!.includes(bt))) {
                toRemove.add(sl.raw);
              }
            }
            section.lines = section.lines.filter(l => !toRemove.has(l.raw));
          }
          line.raw = line.raw.replace(" [?conflict]", "").replace("[?conflict]", "");
          line.hasConflict = false;
          conflictsResolved++;
          break;
        }

        case "remove_mark":
        case "keep_both": {
          // 去掉 [?conflict] 标记
          line.raw = line.raw.replace(" [?conflict]", "").replace("[?conflict]", "");
          line.hasConflict = false;
          conflictsResolved++;
          break;
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`Conflict resolution failed: ${msg}`);
    }
  }

  return { conflictsResolved, errors };
}

// ─── 主入口 ───

export async function runConsolidation(
  dataDir: string,
  consolidationRoute: MemoryLLMRoute,
): Promise<ConsolidationResult> {
  const filePath = join(dataDir, "memory-items.md");
  const archivePath = join(dataDir, "..", "data", "memory-archive.md");
  const today = new Date();

  const result: ConsolidationResult = {
    expired: 0,
    archived: 0,
    basesRebuilt: 0,
    conflictsResolved: 0,
    errors: [],
  };

  if (!existsSync(filePath)) {
    result.errors.push("memory-items.md not found");
    return result;
  }

  const { preamble, sections } = parseMemoryFile(filePath);

  // Phase 1: 过期清理
  const cleanup = runExpiredCleanup(sections, archivePath, today);
  result.expired = cleanup.expired;
  result.archived = cleanup.archived;

  // Phase 2: Δ 自动巩固
  const delta = await runDeltaConsolidation(sections, consolidationRoute);
  result.basesRebuilt = delta.basesRebuilt;
  result.errors.push(...delta.errors);

  // Phase 3: 矛盾检测
  const conflict = await runConflictResolution(sections, consolidationRoute);
  result.conflictsResolved = conflict.conflictsResolved;
  result.errors.push(...conflict.errors);

  // 写回文件
  const newContent = serializeFile(preamble, sections);
  writeFileSync(filePath, newContent, "utf-8");

  return result;
}
