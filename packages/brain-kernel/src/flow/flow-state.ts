/**
 * 心流状态机 — 基于 Csikszentmihalyi 心流理论
 *
 * 四状态：
 * - FLOW:    challengeRatio ∈ [0.8, 1.2] — 技能与挑战匹配
 * - BOREDOM: challengeRatio < 0.8 — 技能远超挑战
 * - ANXIETY: challengeRatio > 1.2 — 挑战远超技能
 * - APATHY:  isDegrading = true — 降智检测触发
 */
import type { FlowState } from '@evodesk/shared';
import { getDb } from '../memory/memory-db.js';

// ============================================================
// DB Schema — flow_state_log
// ============================================================

export function initFlowStateTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS flow_state_log (
      id TEXT PRIMARY KEY,
      state TEXT NOT NULL CHECK(state IN ('FLOW', 'BOREDOM', 'ANXIETY', 'APATHY')),
      ratio REAL NOT NULL,
      timestamp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_flow_state_ts ON flow_state_log(timestamp DESC);
  `);
}

// ============================================================
// 状态判定
// ============================================================

const FLOW_LOWER = 0.8;
const FLOW_UPPER = 1.2;

export interface FlowStateInput {
  readonly challengeRatio: number;
  readonly isDegrading: boolean;
}

/**
 * 根据 challengeRatio + isDegrading 判定当前心流状态。
 * APATHY 优先（降智检测是最严重的信号）。
 */
export function determineFlowState(input: FlowStateInput): FlowState {
  if (input.isDegrading) return 'APATHY';
  if (input.challengeRatio < FLOW_LOWER) return 'BOREDOM';
  if (input.challengeRatio > FLOW_UPPER) return 'ANXIETY';
  return 'FLOW';
}

// ============================================================
// 状态转换记录
// ============================================================

/** 节流间隔：同状态 5 分钟内不重复写入 */
const THROTTLE_MS = 5 * 60 * 1000;
/** 保留最近 30 天的状态日志 */
const RETENTION_DAYS = 30;

let lastLoggedState: FlowState | null = null;
let lastLoggedAt = 0;

/**
 * 记录状态转换到 flow_state_log 表。
 * 节流：同状态 5 分钟内不重复写入，避免无界增长。
 */
export function logFlowStateTransition(state: FlowState, ratio: number): void {
  const now = Date.now();

  // 节流：同状态且间隔不足 → 跳过
  if (state === lastLoggedState && now - lastLoggedAt < THROTTLE_MS) return;

  try {
    getDb().prepare(
      'INSERT INTO flow_state_log (id, state, ratio, timestamp) VALUES (?, ?, ?, ?)'
    ).run(crypto.randomUUID(), state, ratio, now);

    lastLoggedState = state;
    lastLoggedAt = now;

    // 定期清理：每次写入时删除超过 30 天的旧记录
    const cutoff = now - RETENTION_DAYS * 24 * 3600 * 1000;
    getDb().prepare('DELETE FROM flow_state_log WHERE timestamp < ?').run(cutoff);
  } catch {
    // 表可能还未初始化，静默跳过
  }
}

/**
 * 获取最近的心流状态日志
 */
export function recentFlowStates(limit = 20): readonly { state: FlowState; ratio: number; timestamp: number }[] {
  try {
    const rows = getDb().prepare(
      'SELECT state, ratio, timestamp FROM flow_state_log ORDER BY timestamp DESC LIMIT ?'
    ).all(limit) as Array<{ state: string; ratio: number; timestamp: number }>;
    return rows.map(r => ({
      state: r.state as FlowState,
      ratio: r.ratio,
      timestamp: r.timestamp,
    }));
  } catch {
    return [];
  }
}
