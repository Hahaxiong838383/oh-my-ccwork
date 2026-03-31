/**
 * agent-memory.ts — Agent 独立记忆系统
 *
 * 借鉴 Claude Code 的 per-agent-type MEMORY.md 设计：
 * 每个引擎（cc/codex/gemini）独立积累经验，
 * 让 code-reviewer 第 100 次运行比第 1 次更了解项目。
 *
 * 数据文件：0-System/agent-memory/{engine}.md
 * 预算：每个文件最大 500 chars
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

// ── Types ──────────────────────────────────────────────────────

export type EngineType = "cc" | "codex" | "gemini";

export interface ExperienceSignal {
  readonly type: "success" | "friction" | "preference";
  readonly content: string;
}

interface ParsedItem {
  readonly line: string;
  readonly stars: number;
  readonly date: string;
}

// ── Constants ──────────────────────────────────────────────────

const AGENT_MEMORY_DIR = "0-System/agent-memory";
const MAX_BUDGET_CHARS = 500;
const SECTIONS = ["experience", "pitfalls", "preferences"] as const;

const SECTION_MAP: Record<ExperienceSignal["type"], typeof SECTIONS[number]> = {
  success: "experience",
  friction: "pitfalls",
  preference: "preferences",
};

// ── Template ───────────────────────────────────────────────────

function createTemplate(engine: EngineType): string {
  return `# ${engine} Agent Memory\n\n## [experience]\n\n## [pitfalls]\n\n## [preferences]\n`;
}

// ── Path Resolution ────────────────────────────────────────────

function agentMemoryPath(cwd: string, engine: EngineType): string {
  return join(cwd, AGENT_MEMORY_DIR, `${engine}.md`);
}

function ensureDir(cwd: string): void {
  mkdirSync(join(cwd, AGENT_MEMORY_DIR), { recursive: true });
}

// ── Read ───────────────────────────────────────────────────────

export function loadAgentMemory(cwd: string, engine: EngineType): string {
  const filePath = agentMemoryPath(cwd, engine);
  try {
    const content = readFileSync(filePath, "utf-8");
    // 裁剪到预算内
    if (content.length > MAX_BUDGET_CHARS) {
      return content.slice(0, MAX_BUDGET_CHARS) + "\n...(截断)";
    }
    return content;
  } catch {
    return "";
  }
}

// ── Write ──────────────────────────────────────────────────────

function parseMemoryFile(content: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let currentSection = "";

  for (const line of content.split("\n")) {
    const sectionMatch = line.match(/^## \[(\w+)\]/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      sections.set(currentSection, []);
    } else if (currentSection && line.startsWith("- ")) {
      const items = sections.get(currentSection) ?? [];
      sections.set(currentSection, [...items, line]);
    }
  }

  return sections;
}

function parseStars(line: string): number {
  const match = line.match(/★/g);
  return match ? match.length : 0;
}

function parseDate(line: string): string {
  const match = line.match(/\[(\d{4}-\d{2}-\d{2})\]/);
  return match ? match[1] : "1970-01-01";
}

function rebuildFile(engine: EngineType, sections: Map<string, string[]>): string {
  const lines: string[] = [`# ${engine} Agent Memory`, ""];

  for (const section of SECTIONS) {
    lines.push(`## [${section}]`);
    const items = sections.get(section) ?? [];
    for (const item of items) {
      lines.push(item);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ── Record Experience ──────────────────────────────────────────

export function recordAgentExperience(
  cwd: string,
  engine: EngineType,
  signal: ExperienceSignal,
): void {
  ensureDir(cwd);
  const filePath = agentMemoryPath(cwd, engine);

  // 读取或创建
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    content = createTemplate(engine);
  }

  const sections = parseMemoryFile(content);
  const targetSection = SECTION_MAP[signal.type];
  const items = sections.get(targetSection) ?? [];

  // Jaccard 去重：如果已有高度相似的 item，跳过
  const newText = signal.content.toLowerCase();
  const isDuplicate = items.some(item => {
    const existingText = item.replace(/^- ★* /, "").toLowerCase();
    const intersection = new Set([...newText].filter(c => existingText.includes(c)));
    const union = new Set([...newText, ...existingText]);
    return union.size > 0 && intersection.size / union.size > 0.7;
  });

  if (isDuplicate) return;

  // 新增 item
  const today = new Date().toISOString().slice(0, 10);
  const newItem = `- ★ ${signal.content} [${today}]`;
  sections.set(targetSection, [...items, newItem]);

  // 写入（可能触发裁剪）
  let newContent = rebuildFile(engine, sections);
  if (newContent.length > MAX_BUDGET_CHARS) {
    const pruned = pruneToFit(engine, sections);
    newContent = rebuildFile(engine, pruned);
  }

  writeFileSync(filePath, newContent, "utf-8");
}

// ── Prune ──────────────────────────────────────────────────────

function pruneToFit(
  engine: EngineType,
  sections: Map<string, string[]>,
): Map<string, string[]> {
  const result = new Map<string, string[]>();

  for (const section of SECTIONS) {
    const items = sections.get(section) ?? [];

    // 按 ★ 数降序，同星级按日期降序
    const sorted = [...items].sort((a, b) => {
      const starDiff = parseStars(b) - parseStars(a);
      if (starDiff !== 0) return starDiff;
      return parseDate(b).localeCompare(parseDate(a));
    });

    // 每个 section 至少保留 1 条
    result.set(section, sorted.length > 0 ? [sorted[0]] : []);
  }

  // 逐步增加，直到接近预算
  const allItems: Array<{ section: string; item: string; stars: number; date: string }> = [];
  for (const section of SECTIONS) {
    const items = sections.get(section) ?? [];
    for (const item of items.slice(1)) { // skip first (already kept)
      allItems.push({
        section,
        item,
        stars: parseStars(item),
        date: parseDate(item),
      });
    }
  }

  // 按重要性排序
  allItems.sort((a, b) => {
    const starDiff = b.stars - a.stars;
    if (starDiff !== 0) return starDiff;
    return b.date.localeCompare(a.date);
  });

  for (const entry of allItems) {
    const current = result.get(entry.section) ?? [];
    const candidate = new Map(result);
    candidate.set(entry.section, [...current, entry.item]);
    const size = rebuildFile(engine, candidate).length;
    if (size <= MAX_BUDGET_CHARS) {
      result.set(entry.section, [...current, entry.item]);
    } else {
      break; // 超预算，停止
    }
  }

  return result;
}

// ── Batch Record from Task Log ─────────────────────────────────

/**
 * 从 task-log.md 的 friction_skill 字段批量提取信号。
 * Dream 任务调用此函数。
 */
export function extractFromTaskLog(
  cwd: string,
  taskLogContent: string,
): void {
  const lines = taskLogContent.split("\n").filter(l => l.startsWith("|"));

  for (const line of lines) {
    const cols = line.split("|").map(c => c.trim()).filter(Boolean);
    if (cols.length < 6) continue;

    const engine = cols[3]?.toLowerCase() as EngineType;
    if (!["cc", "codex", "gemini"].includes(engine)) continue;

    const friction = cols[5];
    if (!friction || friction === "—") continue;

    recordAgentExperience(cwd, engine, {
      type: "friction",
      content: `${cols[2]} — friction: ${friction}`,
    });
  }
}
