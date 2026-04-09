/**
 * audit-log.ts — 不可变审计日志模块
 *
 * 所有进化操作、L0 边界触及、信任状态变更写入 append-only JSONL。
 * 同步写入确保数据完整性，写入失败不阻塞主流程。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";

// ─── Types ───

export type AuditEventType =
  | "evolution"      // 进化操作（skill create/patch/retire, config change, etc）
  | "trust"          // 信任状态变更
  | "l0_boundary"    // L0 边界文件触及
  | "steering"       // steering_tax 事件
  | "trajectory";    // 轨迹写入

export interface AuditEntry {
  ts: string;           // ISO timestamp
  type: AuditEventType;
  layer?: "rule" | "config" | "model";   // 进化层级（仅 evolution 类型）
  action: string;       // 具体动作描述
  detail?: string;      // 额外细节
  fitnessDelta?: number; // 对 fitness 的预估影响
  riskScore?: number;    // 风险分（low=1, medium=3, high=10, critical=50）
  verdict?: "allow" | "deny" | "pending";  // 操作结果
}

// ─── Constants ───

const AUDIT_FILE = "audit-log.jsonl";
const DAILY_RISK_LIMIT = 100;

// ─── Helpers ───

function getAuditPath(brainRoot: string): string {
  return join(brainRoot, "data", AUDIT_FILE);
}

// ─── Core API ───

/**
 * 写入审计日志（append-only，同步写入确保不丢）
 */
export function writeAuditLog(brainRoot: string, entry: AuditEntry): void {
  try {
    const dir = join(brainRoot, "data");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ ...entry, ts: entry.ts || new Date().toISOString() }) + "\n";
    appendFileSync(getAuditPath(brainRoot), line);
  } catch {
    // 审计日志写入失败时打印到 stderr，但不阻塞主流程
    console.error("[audit] failed to write audit log");
  }
}

/**
 * 读取最近 N 天的审计日志
 */
export function readAuditLog(brainRoot: string, days = 7): AuditEntry[] {
  const path = getAuditPath(brainRoot);
  if (!existsSync(path)) return [];

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
  const entries: AuditEntry[] = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as AuditEntry;
      if (new Date(entry.ts) >= cutoff) entries.push(entry);
    } catch { /* skip malformed */ }
  }
  return entries;
}

/**
 * 计算当日累积风险分
 */
export function getTodayRiskScore(brainRoot: string): number {
  const today = new Date().toISOString().slice(0, 10);
  const entries = readAuditLog(brainRoot, 1);
  return entries
    .filter(e => e.ts.startsWith(today) && e.riskScore)
    .reduce((sum, e) => sum + (e.riskScore ?? 0), 0);
}

/**
 * 检查是否超过每日风险上限
 */
export function isRiskLimitExceeded(brainRoot: string): boolean {
  return getTodayRiskScore(brainRoot) >= DAILY_RISK_LIMIT;
}

// ─── Summary API ───

export interface AuditSummary {
  totalEntries: number;
  todayRiskScore: number;
  riskLimitExceeded: boolean;
  byType: Record<string, number>;
  recentEntries: AuditEntry[];
}

/**
 * 获取审计日志摘要（供 Admin API）
 */
export function getAuditSummary(brainRoot: string, days = 7): AuditSummary {
  const entries = readAuditLog(brainRoot, days);
  const byType: Record<string, number> = {};
  for (const entry of entries) {
    byType[entry.type] = (byType[entry.type] ?? 0) + 1;
  }
  return {
    totalEntries: entries.length,
    todayRiskScore: getTodayRiskScore(brainRoot),
    riskLimitExceeded: isRiskLimitExceeded(brainRoot),
    byType,
    recentEntries: entries.slice(-20),
  };
}
