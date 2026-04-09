/**
 * trust-state.ts — TrustState 量化模块（Phase 2 P1-A）
 *
 * 信任分数驱动自主等级：
 * - conservative (<30): 保守模式，所有操作需确认
 * - standard (30-70): 标准模式，常规操作自主执行
 * - autonomous (>=70): 自主模式，主动决策
 *
 * 衰减逻辑：每 24h score *= 0.95（lazy 计算）
 * 初始值：score=50（standard 模式）
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { writeAuditLog } from "./audit-log.js";

// ─── Types ───

export type TrustEventType = "approve" | "deny";

export type TrustCategory =
  | "prediction_accurate"
  | "proactive_adopted"
  | "routine_ok"
  | "corrected"
  | "rejected"
  | "rollback";

export interface TrustEvent {
  readonly timestamp: string;
  readonly eventType: TrustEventType;
  readonly category: TrustCategory;
  readonly weight: number;
  readonly source: string;
  readonly conversationId?: string;
}

export type TrustMode = "conservative" | "standard" | "autonomous";

export interface TrustState {
  readonly score: number;
  readonly mode: TrustMode;
  readonly lastUpdated: string;
  readonly lastDecayApplied: string;
  readonly eventCount: { readonly approve: number; readonly deny: number };
}

export interface TrustTrendEntry {
  readonly date: string;
  readonly score: number;
  readonly approves: number;
  readonly denials: number;
}

export interface TrustReport {
  readonly state: TrustState;
  readonly trend: ReadonlyArray<TrustTrendEntry>;
  readonly recentEvents: ReadonlyArray<TrustEvent>;
}

// ─── Constants ───

const TRUST_STATE_FILE = "trust-state.json";
const TRUST_EVENTS_FILE = "trust-events.jsonl";
const DECAY_RATE = 0.95;
const DECAY_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

const DEFAULT_TRUST_STATE: TrustState = {
  score: 50,
  mode: "standard",
  lastUpdated: new Date().toISOString(),
  lastDecayApplied: new Date().toISOString(),
  eventCount: { approve: 0, deny: 0 },
};

// ─── Helpers ───

function getStatePath(brainRoot: string): string {
  return join(brainRoot, "data", TRUST_STATE_FILE);
}

function getEventsPath(brainRoot: string): string {
  return join(brainRoot, "data", TRUST_EVENTS_FILE);
}

function ensureDataDir(brainRoot: string): void {
  const dir = join(brainRoot, "data");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function scoreToMode(score: number): TrustMode {
  if (score < 30) return "conservative";
  if (score >= 70) return "autonomous";
  return "standard";
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, score));
}

function readStateFile(brainRoot: string): TrustState {
  const path = getStatePath(brainRoot);
  if (!existsSync(path)) return { ...DEFAULT_TRUST_STATE };
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as TrustState;
  } catch {
    return { ...DEFAULT_TRUST_STATE };
  }
}

function writeStateFile(brainRoot: string, state: TrustState): void {
  ensureDataDir(brainRoot);
  writeFileSync(getStatePath(brainRoot), JSON.stringify(state, null, 2) + "\n", "utf-8");
}

function readAllEvents(brainRoot: string): TrustEvent[] {
  const path = getEventsPath(brainRoot);
  if (!existsSync(path)) return [];
  try {
    const lines = readFileSync(path, "utf-8").trim().split("\n").filter(Boolean);
    const events: TrustEvent[] = [];
    for (const line of lines) {
      try {
        events.push(JSON.parse(line) as TrustEvent);
      } catch { /* skip malformed */ }
    }
    return events;
  } catch {
    return [];
  }
}

function applyDecay(state: TrustState): TrustState {
  const now = Date.now();
  const lastDecay = new Date(state.lastDecayApplied).getTime();
  const elapsed = now - lastDecay;

  if (elapsed < DECAY_INTERVAL_MS) return state;

  // 计算需要应用多少次衰减（每 24h 一次）
  const decayCount = Math.floor(elapsed / DECAY_INTERVAL_MS);
  const newScore = clampScore(state.score * Math.pow(DECAY_RATE, decayCount));
  const newMode = scoreToMode(newScore);

  return {
    ...state,
    score: Math.round(newScore * 100) / 100,
    mode: newMode,
    lastDecayApplied: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
  };
}

// ─── Core API ───

/**
 * 记录信任事件，重新计算 score 并更新 mode
 */
export function recordTrustEvent(brainRoot: string, event: TrustEvent): void {
  ensureDataDir(brainRoot);

  // 1. Append event to JSONL (审计级，同步写)
  const line = JSON.stringify(event) + "\n";
  appendFileSync(getEventsPath(brainRoot), line);

  // 2. 读取当前状态
  const currentState = readStateFile(brainRoot);

  // 3. 更新 score 和 eventCount
  const newScore = clampScore(currentState.score + event.weight);
  const newMode = scoreToMode(newScore);
  const newEventCount = event.eventType === "approve"
    ? { approve: currentState.eventCount.approve + 1, deny: currentState.eventCount.deny }
    : { approve: currentState.eventCount.approve, deny: currentState.eventCount.deny + 1 };

  const newState: TrustState = {
    score: Math.round(newScore * 100) / 100,
    mode: newMode,
    lastUpdated: new Date().toISOString(),
    lastDecayApplied: currentState.lastDecayApplied,
    eventCount: newEventCount,
  };

  // 4. 保存
  writeStateFile(brainRoot, newState);

  // 5. 审计日志
  writeAuditLog(brainRoot, {
    ts: event.timestamp,
    type: "trust",
    action: `trust_${event.eventType}`,
    detail: `category=${event.category} weight=${event.weight} score=${newState.score} mode=${newState.mode} source=${event.source}`,
  });
}

/**
 * 获取当前信任状态（含 lazy 衰减）
 */
export function getTrustState(brainRoot: string): TrustState {
  const state = readStateFile(brainRoot);
  const decayed = applyDecay(state);

  // 如果衰减发生了变化，保存新状态
  if (decayed.lastDecayApplied !== state.lastDecayApplied) {
    writeStateFile(brainRoot, decayed);
  }

  return decayed;
}

/**
 * 强制设置信任模式（由 veto-spiral 调用）
 */
export function forceTrustMode(brainRoot: string, mode: TrustMode, reason: string): void {
  const currentState = readStateFile(brainRoot);

  // mode → score 映射：确保 score 落在对应区间
  const modeScoreMap: Record<TrustMode, number> = {
    conservative: 20,
    standard: 50,
    autonomous: 80,
  };

  const newScore = modeScoreMap[mode];
  const newState: TrustState = {
    ...currentState,
    score: newScore,
    mode,
    lastUpdated: new Date().toISOString(),
  };

  writeStateFile(brainRoot, newState);

  writeAuditLog(brainRoot, {
    ts: new Date().toISOString(),
    type: "trust",
    action: "force_trust_mode",
    detail: `mode=${mode} score=${newScore} reason=${reason}`,
    riskScore: 10,
  });
}

/**
 * 获取信任趋势报告（供 Admin API）
 */
export function getTrustReport(brainRoot: string, days: number = 7): TrustReport {
  const state = getTrustState(brainRoot);
  const events = readAllEvents(brainRoot);
  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - days);

  // 按日聚合
  const dailyMap = new Map<string, { score: number; approves: number; denials: number }>();

  // 初始化每日条目
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateKey = d.toISOString().slice(0, 10);
    dailyMap.set(dateKey, { score: 0, approves: 0, denials: 0 });
  }

  // 统计每日事件
  let runningScore = 50; // 从初始值开始模拟
  for (const event of events) {
    const dateKey = event.timestamp.slice(0, 10);
    runningScore = clampScore(runningScore + event.weight);

    const entry = dailyMap.get(dateKey);
    if (entry) {
      entry.score = Math.round(runningScore * 100) / 100;
      if (event.eventType === "approve") entry.approves++;
      else entry.denials++;
    }
  }

  const trend: TrustTrendEntry[] = [];
  dailyMap.forEach((data, date) => {
    trend.push({
      date,
      score: data.score,
      approves: data.approves,
      denials: data.denials,
    });
  });

  // 最近 20 条事件
  const recentEvents = events
    .filter(e => new Date(e.timestamp) >= cutoff)
    .slice(-20);

  return { state, trend, recentEvents };
}
