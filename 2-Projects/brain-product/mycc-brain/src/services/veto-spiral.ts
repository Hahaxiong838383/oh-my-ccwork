/**
 * veto-spiral.ts — 否决螺旋检测模块（Phase 2 P1-D）
 *
 * 检测连续否决模式，防止 brain 在错误方向上持续尝试。
 * - 连续 3 次否决 → warning（含元认知反思 prompt）
 * - 连续 5 次否决 → critical（自动降级到 conservative 模式）
 *
 * 任何 approve 事件重置计数器。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { forceTrustMode } from "./trust-state.js";
import { writeAuditLog } from "./audit-log.js";

// ─── Types ───

export interface VetoCounter {
  readonly consecutiveDenials: number;
  readonly lastDenialAt: string;
  readonly denialHistory: ReadonlyArray<{
    readonly timestamp: string;
    readonly reason: string;
  }>;
}

export type SpiralAlertLevel = "warning" | "critical";

export interface SpiralAlert {
  readonly level: SpiralAlertLevel;
  readonly consecutiveDenials: number;
  readonly action: "pause_and_reflect" | "degrade_to_conservative";
  readonly metacognitionPrompt: string;
}

// ─── Constants ───

export const SPIRAL_WARNING_THRESHOLD = 3;
export const SPIRAL_CRITICAL_THRESHOLD = 5;

const VETO_STATE_FILE = "veto-state.json";
const MAX_HISTORY_ENTRIES = 50;

// 防重入标志
let _spiralDegrading = false;

// ─── Helpers ───

function getStatePath(brainRoot: string): string {
  return join(brainRoot, "data", VETO_STATE_FILE);
}

function ensureDataDir(brainRoot: string): void {
  const dir = join(brainRoot, "data");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

const DEFAULT_VETO_STATE: VetoCounter = {
  consecutiveDenials: 0,
  lastDenialAt: "",
  denialHistory: [],
};

function readVetoState(brainRoot: string): VetoCounter {
  const path = getStatePath(brainRoot);
  if (!existsSync(path)) return { ...DEFAULT_VETO_STATE, denialHistory: [] };
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as VetoCounter;
  } catch {
    return { ...DEFAULT_VETO_STATE, denialHistory: [] };
  }
}

function writeVetoState(brainRoot: string, state: VetoCounter): void {
  ensureDataDir(brainRoot);
  writeFileSync(getStatePath(brainRoot), JSON.stringify(state, null, 2) + "\n", "utf-8");
}

function buildWarningPrompt(n: number, recentReasons: ReadonlyArray<{ readonly timestamp: string; readonly reason: string }>): string {
  const reasonList = recentReasons
    .slice(-3)
    .map((r, i) => `  ${i + 1}. ${r.reason}（${r.timestamp}）`)
    .join("\n");

  return `[元认知] 触发信号：否决螺旋（连续 ${n} 次被纠正）
- 最近否决原因：
${reasonList}
- 分析：我的推断基于什么假设？这个假设哪里有问题？
- 建议：暂停当前方向，调整策略后再继续`;
}

function buildCriticalPrompt(n: number, recentReasons: ReadonlyArray<{ readonly timestamp: string; readonly reason: string }>): string {
  const warningPart = buildWarningPrompt(n, recentReasons);
  return `${warningPart}
- 行动：已自动降级到保守模式，等待用户重新校准`;
}

// ─── Core API ───

/**
 * 递增否决计数，达到阈值时返回 SpiralAlert
 */
export function incrementDenial(brainRoot: string, reason: string): SpiralAlert | null {
  const current = readVetoState(brainRoot);
  const now = new Date().toISOString();

  // 追加历史记录（限制最大条目数）
  const newHistory = [
    ...current.denialHistory.slice(-(MAX_HISTORY_ENTRIES - 1)),
    { timestamp: now, reason },
  ];

  const newCount = current.consecutiveDenials + 1;

  const newState: VetoCounter = {
    consecutiveDenials: newCount,
    lastDenialAt: now,
    denialHistory: newHistory,
  };

  writeVetoState(brainRoot, newState);

  // 审计日志
  writeAuditLog(brainRoot, {
    ts: now,
    type: "steering",
    action: "veto_spiral_increment",
    detail: `consecutiveDenials=${newCount} reason=${reason}`,
    riskScore: newCount >= SPIRAL_CRITICAL_THRESHOLD ? 10 : newCount >= SPIRAL_WARNING_THRESHOLD ? 3 : 1,
  });

  // critical 阈值检查（优先于 warning）
  if (newCount >= SPIRAL_CRITICAL_THRESHOLD) {
    const prompt = buildCriticalPrompt(newCount, newHistory);

    // 防重入：避免 forceTrustMode 内部触发递归
    if (!_spiralDegrading) {
      _spiralDegrading = true;
      try {
        forceTrustMode(brainRoot, "conservative", "veto spiral critical");
      } finally {
        _spiralDegrading = false;
      }
    }

    return {
      level: "critical",
      consecutiveDenials: newCount,
      action: "degrade_to_conservative",
      metacognitionPrompt: prompt,
    };
  }

  // warning 阈值检查
  if (newCount >= SPIRAL_WARNING_THRESHOLD) {
    const prompt = buildWarningPrompt(newCount, newHistory);

    return {
      level: "warning",
      consecutiveDenials: newCount,
      action: "pause_and_reflect",
      metacognitionPrompt: prompt,
    };
  }

  return null;
}

/**
 * 重置否决计数器（收到 approve 事件时调用）
 */
export function resetCounter(brainRoot: string): void {
  const current = readVetoState(brainRoot);

  // 只有有连续否决时才需要重置
  if (current.consecutiveDenials === 0) return;

  const newState: VetoCounter = {
    ...current,
    consecutiveDenials: 0,
  };

  writeVetoState(brainRoot, newState);

  writeAuditLog(brainRoot, {
    ts: new Date().toISOString(),
    type: "steering",
    action: "veto_spiral_reset",
    detail: `previous_count=${current.consecutiveDenials}`,
  });
}

/**
 * 获取当前否决状态
 */
export function getVetoState(brainRoot: string): VetoCounter {
  return readVetoState(brainRoot);
}
