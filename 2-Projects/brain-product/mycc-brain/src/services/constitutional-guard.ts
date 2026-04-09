/**
 * constitutional-guard.ts — Constitutional Guard 声明式规则引擎
 *
 * P1-C: 从 data/constitutional.yaml 加载规则，对进化操作、文件写入、
 * 信任模式等进行声明式约束检查。所有评估结果写入审计日志。
 *
 * YAML 解析：内置简单子集解析器，不依赖外部库。
 */

import { readFileSync, existsSync, statSync } from "fs";
import { join } from "path";
import { writeAuditLog } from "./audit-log.js";

// ─── Types ───

export interface GuardRule {
  readonly id: string;
  readonly scope: string;
  readonly target?: readonly string[];
  readonly condition?: string;
  readonly verdict: "allow" | "deny" | "requires_confirmation";
  readonly reason: string;
}

export interface GuardContext {
  readonly action: string;
  readonly target?: string;
  readonly trustMode?: "conservative" | "standard" | "autonomous";
  readonly dailyRiskScore?: number;
  readonly fitnessDelta?: number;
}

export interface GuardResult {
  readonly ruleId: string | null;
  readonly verdict: "allow" | "deny" | "requires_confirmation";
  readonly reason: string;
}

// ─── YAML Subset Parser ───

interface YamlNode {
  readonly [key: string]: string | readonly string[] | undefined;
}

/**
 * 简单 YAML 子集解析器
 * 支持：key: "value"、key: value、- item 数组、2 空格缩进层级
 */
function parseSimpleYaml(content: string): readonly YamlNode[] {
  const lines = content.split("\n");
  const rules: YamlNode[] = [];
  let currentRule: Record<string, string | string[]> | null = null;
  let currentArrayKey: string | null = null;

  for (const rawLine of lines) {
    // 跳过空行和注释
    if (rawLine.trim() === "" || rawLine.trim().startsWith("#")) continue;

    const indent = rawLine.length - rawLine.trimStart().length;
    const trimmed = rawLine.trim();

    // 顶层 "rules:" 标记 — 跳过
    if (indent === 0 && trimmed === "rules:") continue;

    // 缩进 2：规则列表项 "- id: xxx"
    if (indent === 2 && trimmed.startsWith("- ")) {
      if (currentRule) {
        rules.push(currentRule as unknown as YamlNode);
      }
      currentRule = {};
      currentArrayKey = null;
      const afterDash = trimmed.slice(2).trim();
      const parsed = parseKeyValue(afterDash);
      if (parsed) {
        currentRule[parsed.key] = parsed.value;
      }
      continue;
    }

    // 缩进 4：规则属性
    if (indent === 4 && currentRule) {
      // 检查是否是数组开头（key 后面只有空值）
      const parsed = parseKeyValue(trimmed);
      if (parsed) {
        if (parsed.value === "") {
          // 可能是数组声明，如 "target:"
          currentArrayKey = parsed.key;
          currentRule[currentArrayKey] = [];
        } else {
          currentArrayKey = null;
          currentRule[parsed.key] = parsed.value;
        }
      }
      continue;
    }

    // 缩进 6：数组项 "- item"
    if (indent === 6 && trimmed.startsWith("- ") && currentRule && currentArrayKey) {
      const value = stripQuotes(trimmed.slice(2).trim());
      const arr = currentRule[currentArrayKey];
      if (Array.isArray(arr)) {
        arr.push(value);
      }
      continue;
    }
  }

  // 最后一条规则
  if (currentRule) {
    rules.push(currentRule as unknown as YamlNode);
  }

  return rules;
}

function parseKeyValue(s: string): { readonly key: string; readonly value: string } | null {
  const colonIdx = s.indexOf(":");
  if (colonIdx === -1) return null;
  const key = s.slice(0, colonIdx).trim();
  const value = stripQuotes(s.slice(colonIdx + 1).trim());
  return { key, value };
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

// ─── Rule Cache ───

let cachedRules: readonly GuardRule[] | null = null;
let cachedMtime: number = 0;

function yamlPath(brainRoot: string): string {
  return join(brainRoot, "data", "constitutional.yaml");
}

// ─── Core API ───

/**
 * 从 data/constitutional.yaml 加载规则，带 mtime 缓存
 */
export function loadRules(brainRoot: string): readonly GuardRule[] {
  const filePath = yamlPath(brainRoot);
  if (!existsSync(filePath)) {
    console.error("[constitutional-guard] constitutional.yaml not found, using empty ruleset");
    return [];
  }

  try {
    const mtime = statSync(filePath).mtimeMs;
    if (cachedRules && mtime === cachedMtime) {
      return cachedRules;
    }

    const content = readFileSync(filePath, "utf-8");
    const nodes = parseSimpleYaml(content);

    const rules: GuardRule[] = nodes
      .filter(node => typeof node.id === "string" && typeof node.scope === "string")
      .map(node => ({
        id: node.id as string,
        scope: node.scope as string,
        target: Array.isArray(node.target) ? (node.target as readonly string[]) : undefined,
        condition: typeof node.condition === "string" && node.condition !== "" ? node.condition : undefined,
        verdict: parseVerdict(node.verdict as string | undefined),
        reason: (node.reason as string) ?? "",
      }));

    cachedRules = rules;
    cachedMtime = mtime;
    console.log(`[constitutional-guard] Loaded ${rules.length} rules`);
    return rules;
  } catch (err) {
    console.error("[constitutional-guard] Failed to parse constitutional.yaml:", err);
    return [];
  }
}

function parseVerdict(v: string | undefined): "allow" | "deny" | "requires_confirmation" {
  if (v === "deny") return "deny";
  if (v === "requires_confirmation") return "requires_confirmation";
  if (v === "allow") return "allow";
  return "allow";
}

/**
 * 清除缓存，强制重新加载
 */
export function reloadRules(brainRoot: string): void {
  cachedRules = null;
  cachedMtime = 0;
  loadRules(brainRoot);
}

/**
 * 条件解析器：支持 "key op value" 格式
 * 运算符：==, !=, >=, <=, >, <
 * 绝对不使用 eval()
 */
export function evaluateCondition(condition: string, context: GuardContext): boolean {
  const operators = [">=", "<=", "!=", "==", ">", "<"] as const;

  let matchedOp: typeof operators[number] | null = null;
  let opIdx = -1;

  for (const op of operators) {
    const idx = condition.indexOf(op);
    if (idx !== -1) {
      matchedOp = op;
      opIdx = idx;
      break;
    }
  }

  if (!matchedOp || opIdx === -1) return false;

  const key = condition.slice(0, opIdx).trim();
  const rawValue = condition.slice(opIdx + matchedOp.length).trim();

  // 从 context 映射 key
  const contextValue = resolveContextKey(key, context);
  if (contextValue === undefined) return false;

  // 解析目标值
  const targetValue = parseValue(rawValue);

  return compareValues(contextValue, matchedOp, targetValue);
}

function resolveContextKey(key: string, context: GuardContext): string | number | undefined {
  switch (key) {
    case "trust_mode": return context.trustMode;
    case "daily_risk_score": return context.dailyRiskScore;
    case "fitness_delta": return context.fitnessDelta;
    default: return undefined;
  }
}

function parseValue(raw: string): string | number {
  // 去引号
  const stripped = stripQuotes(raw);
  const num = Number(stripped);
  if (!isNaN(num) && stripped !== "") return num;
  return stripped;
}

function compareValues(
  left: string | number | undefined,
  op: ">=" | "<=" | "!=" | "==" | ">" | "<",
  right: string | number,
): boolean {
  if (left === undefined) return false;

  switch (op) {
    case "==": return left === right || String(left) === String(right);
    case "!=": return left !== right && String(left) !== String(right);
    case ">=": return Number(left) >= Number(right);
    case "<=": return Number(left) <= Number(right);
    case ">":  return Number(left) > Number(right);
    case "<":  return Number(left) < Number(right);
    default:   return false;
  }
}

// ─── Verdict Priority ───

const VERDICT_PRIORITY: Record<string, number> = {
  deny: 3,
  requires_confirmation: 2,
  allow: 1,
};

/**
 * 评估操作是否被 Constitutional Guard 允许
 * 多条规则匹配时返回最严格的 verdict
 */
export function evaluate(brainRoot: string, context: GuardContext): GuardResult {
  const rules = loadRules(brainRoot);

  let strictest: GuardResult = {
    ruleId: null,
    verdict: "allow",
    reason: "No matching rule, default allow",
  };

  for (const rule of rules) {
    if (!matchesRule(rule, context)) continue;

    const currentPriority = VERDICT_PRIORITY[strictest.verdict] ?? 0;
    const rulePriority = VERDICT_PRIORITY[rule.verdict] ?? 0;

    if (rulePriority > currentPriority) {
      strictest = {
        ruleId: rule.id,
        verdict: rule.verdict,
        reason: rule.reason,
      };
    }
  }

  // 写审计日志（audit verdict 只支持 allow/deny/pending，映射 requires_confirmation → pending）
  const auditVerdict = strictest.verdict === "requires_confirmation" ? "pending" : strictest.verdict;
  writeAuditLog(brainRoot, {
    ts: new Date().toISOString(),
    type: "l0_boundary",
    action: context.action,
    detail: strictest.reason,
    verdict: auditVerdict,
  });

  return strictest;
}

function matchesRule(rule: GuardRule, context: GuardContext): boolean {
  // scope 必须匹配
  if (rule.scope !== context.action) return false;

  // target 匹配（如果规则有 target 要求）
  if (rule.target && rule.target.length > 0) {
    if (!context.target) return false;
    if (!rule.target.includes(context.target)) return false;
  }

  // condition 匹配（如果规则有 condition 要求）
  if (rule.condition) {
    if (!evaluateCondition(rule.condition, context)) return false;
  }

  return true;
}
