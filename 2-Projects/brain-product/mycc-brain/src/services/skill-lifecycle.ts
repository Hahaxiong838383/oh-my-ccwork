/**
 * skill-lifecycle.ts — Skill 自主沉淀与生命周期管理
 *
 * P1-B: 任务成功完成 + 工具调用 >5 次 → 自主判断是否沉淀为 Skill
 * Skill 是"活的程序性记忆"，有完整生命周期：创建 → 使用 → 老化 → 修补/淘汰
 *
 * 存储：data/skills/skill-registry.jsonl（每行一个 SkillRecord JSON）
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import { writeAuditLog } from "./audit-log.js";

// ─── Types ───

export interface SkillRecord {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly triggerPattern: string;
  readonly toolSequence: readonly string[];
  readonly createdAt: string;
  readonly lastUsedAt: string;
  readonly useCount: number;
  readonly successCount: number;
  readonly failCount: number;
  readonly status: SkillStatus;
  readonly agingSince?: string;  // ISO timestamp: 进入 aging 状态的时间
  readonly source: "auto" | "manual";
}

export type SkillStatus = "active" | "aging" | "retired";

export interface SkillCandidate {
  readonly query: string;
  readonly toolsUsed: readonly string[];
  readonly toolCallCount: number;
  readonly success: boolean;
}

export interface SkillSummary {
  readonly total: number;
  readonly active: number;
  readonly aging: number;
  readonly retired: number;
  readonly recentlyCreated: readonly SkillRecord[];
  readonly topUsed: readonly SkillRecord[];
}

// ─── Constants ───

const REGISTRY_DIR = "skills";
const REGISTRY_FILE = "skill-registry.jsonl";
const MIN_TOOL_CALLS = 5;
const OVERLAP_THRESHOLD = 0.8;
const AGING_DAYS = 30;
const RETIRE_DAYS = 60;
const LOW_SUCCESS_RATE = 0.6;
const MIN_USE_FOR_SUCCESS_CHECK = 5;

// ─── Helpers ───

function getRegistryPath(brainRoot: string): string {
  return join(brainRoot, "data", REGISTRY_DIR, REGISTRY_FILE);
}

function ensureDir(brainRoot: string): void {
  const dir = join(brainRoot, "data", REGISTRY_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function readAllSkills(brainRoot: string): SkillRecord[] {
  const path = getRegistryPath(brainRoot);
  if (!existsSync(path)) return [];

  const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
  const skills: SkillRecord[] = [];
  for (const line of lines) {
    try {
      skills.push(JSON.parse(line) as SkillRecord);
    } catch { /* skip malformed */ }
  }
  return skills;
}

function writeAllSkills(brainRoot: string, skills: readonly SkillRecord[]): void {
  ensureDir(brainRoot);
  const content = skills.map(s => JSON.stringify(s)).join("\n") + (skills.length > 0 ? "\n" : "");
  writeFileSync(getRegistryPath(brainRoot), content);
}

function generateId(): string {
  const ts = Date.now().toString(36);
  const hash = Math.random().toString(36).slice(2, 6);
  return `skill-${ts}-${hash}`;
}

/**
 * 计算两个工具序列的重叠度（Jaccard 相似度）
 */
function toolOverlap(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0 || b.length === 0) return 0;

  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

/**
 * 从 query 生成触发模式：CJK bigram + latin words
 * 输出正则字符串，用于后续匹配
 */
function buildTriggerPattern(query: string): string {
  const keywords: string[] = [];

  // CJK bigrams
  const cjkChars = query.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) ?? [];
  for (let i = 0; i < cjkChars.length - 1; i++) {
    keywords.push(cjkChars[i] + cjkChars[i + 1]);
  }

  // latin words (3+ chars)
  const latinWords = query.match(/[a-zA-Z]{3,}/g) ?? [];
  for (const w of latinWords) {
    keywords.push(w.toLowerCase());
  }

  if (keywords.length === 0) return "";

  // 取前 5 个关键词，用 | 连接
  const selected = keywords.slice(0, 5);
  return selected.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
}

/**
 * 生成技能名：query 前 20 字 + 工具数
 */
function buildSkillName(query: string, toolCount: number): string {
  const trimmed = query.slice(0, 20).replace(/\s+/g, " ").trim();
  return `${trimmed}(${toolCount}tools)`;
}

// ─── Core API ───

/**
 * 判断是否应创建 Skill
 * 条件：toolCallCount > 5 + success + 不与现有 Skill 重叠 >80%
 */
export function shouldCreateSkill(brainRoot: string, candidate: SkillCandidate): boolean {
  if (candidate.toolCallCount <= MIN_TOOL_CALLS) return false;
  if (!candidate.success) return false;
  if (candidate.toolsUsed.length === 0) return false;

  const existing = readAllSkills(brainRoot);
  const activeSkills = existing.filter(s => s.status === "active");

  for (const skill of activeSkills) {
    if (toolOverlap(skill.toolSequence, candidate.toolsUsed) > OVERLAP_THRESHOLD) {
      return false;
    }
  }

  return true;
}

/**
 * 创建新 Skill 并持久化
 */
export function createSkill(brainRoot: string, candidate: SkillCandidate): SkillRecord {
  ensureDir(brainRoot);

  const now = new Date().toISOString();
  const record: SkillRecord = {
    id: generateId(),
    name: buildSkillName(candidate.query, candidate.toolsUsed.length),
    description: candidate.query.slice(0, 100),
    triggerPattern: buildTriggerPattern(candidate.query),
    toolSequence: [...candidate.toolsUsed],
    createdAt: now,
    lastUsedAt: now,
    useCount: 1,
    successCount: 1,
    failCount: 0,
    status: "active",
    source: "auto",
  };

  // append to JSONL
  appendFileSync(getRegistryPath(brainRoot), JSON.stringify(record) + "\n");

  // audit log
  writeAuditLog(brainRoot, {
    ts: now,
    type: "evolution",
    layer: "rule",
    action: "skill_create",
    detail: `Auto-created skill: ${record.name} (${record.id})`,
    riskScore: 1,
    verdict: "allow",
  });

  return record;
}

/**
 * 在 active 技能中查找匹配的 Skill
 * 命中时更新 lastUsedAt + useCount
 */
export function findMatchingSkill(brainRoot: string, query: string): SkillRecord | null {
  const skills = readAllSkills(brainRoot);
  const activeSkills = skills.filter(s => s.status === "active" && s.triggerPattern);

  for (const skill of activeSkills) {
    try {
      const regex = new RegExp(skill.triggerPattern, "iu");
      if (regex.test(query)) {
        // update lastUsedAt + useCount (immutable: rebuild entire list)
        const updated: SkillRecord = {
          ...skill,
          lastUsedAt: new Date().toISOString(),
          useCount: skill.useCount + 1,
        };
        const newSkills = skills.map(s => s.id === skill.id ? updated : s);
        writeAllSkills(brainRoot, newSkills);
        return updated;
      }
    } catch { /* skip invalid regex */ }
  }

  return null;
}

/**
 * 记录 Skill 执行结果
 * successRate < 60% 且 useCount >= 5 → aging
 */
export function recordSkillOutcome(brainRoot: string, skillId: string, success: boolean): void {
  const skills = readAllSkills(brainRoot);
  const idx = skills.findIndex(s => s.id === skillId);
  if (idx === -1) return;

  const skill = skills[idx];
  const updated: SkillRecord = {
    ...skill,
    successCount: skill.successCount + (success ? 1 : 0),
    failCount: skill.failCount + (success ? 0 : 1),
  };

  const totalUses = updated.successCount + updated.failCount;
  const successRate = totalUses > 0 ? updated.successCount / totalUses : 1;

  const final: SkillRecord = (
    successRate < LOW_SUCCESS_RATE &&
    totalUses >= MIN_USE_FOR_SUCCESS_CHECK &&
    updated.status === "active"
  )
    ? { ...updated, status: "aging" as const, agingSince: new Date().toISOString() }
    : updated;

  if (final.status !== skill.status) {
    writeAuditLog(brainRoot, {
      ts: new Date().toISOString(),
      type: "evolution",
      layer: "rule",
      action: "skill_aging",
      detail: `Skill ${skill.name} (${skill.id}) aged due to low success rate: ${(successRate * 100).toFixed(0)}%`,
      riskScore: 1,
      verdict: "allow",
    });
  }

  const newSkills = [...skills];
  newSkills[idx] = final;
  writeAllSkills(brainRoot, newSkills);
}

/**
 * 老化检查：
 * - 30 天未使用 → aging
 * - aging + 60 天未使用 → retired
 */
export function runAgingCheck(brainRoot: string): { aged: number; retired: number } {
  const skills = readAllSkills(brainRoot);
  if (skills.length === 0) return { aged: 0, retired: 0 };

  const now = Date.now();
  let aged = 0;
  let retired = 0;

  const updated = skills.map(skill => {
    const lastUsed = new Date(skill.lastUsedAt).getTime();
    const daysSinceUse = (now - lastUsed) / (1000 * 60 * 60 * 24);

    if (skill.status === "active" && daysSinceUse >= AGING_DAYS) {
      aged++;
      return { ...skill, status: "aging" as const, agingSince: new Date().toISOString() };
    }

    if (skill.status === "aging") {
      // retire 基于进入 aging 后经过的天数，而非 lastUsedAt
      const agingStart = skill.agingSince ? new Date(skill.agingSince).getTime() : lastUsed;
      const daysSinceAging = (now - agingStart) / (1000 * 60 * 60 * 24);
      if (daysSinceAging >= RETIRE_DAYS) {
        retired++;
        return { ...skill, status: "retired" as const };
      }
    }

    return skill;
  });

  if (aged > 0 || retired > 0) {
    writeAllSkills(brainRoot, updated);

    writeAuditLog(brainRoot, {
      ts: new Date().toISOString(),
      type: "evolution",
      layer: "rule",
      action: "skill_aging_check",
      detail: `Aging check: ${aged} aged, ${retired} retired`,
      riskScore: 1,
      verdict: "allow",
    });
  }

  return { aged, retired };
}

/**
 * 获取 Skill 摘要（供 Admin API）
 */
export function getSkillSummary(brainRoot: string): SkillSummary {
  const skills = readAllSkills(brainRoot);

  const active = skills.filter(s => s.status === "active");
  const aging = skills.filter(s => s.status === "aging");
  const retiredList = skills.filter(s => s.status === "retired");

  // 最近创建的 5 个
  const recentlyCreated = [...skills]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 5);

  // 使用最多的 5 个（仅 active）
  const topUsed = [...active]
    .sort((a, b) => b.useCount - a.useCount)
    .slice(0, 5);

  return {
    total: skills.length,
    active: active.length,
    aging: aging.length,
    retired: retiredList.length,
    recentlyCreated,
    topUsed,
  };
}
