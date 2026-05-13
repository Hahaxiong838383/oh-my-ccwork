import { getDict } from '../../config/loader';

/**
 * 专注计时（来自 1.3 §二）
 *
 * 关键规则：
 * - 暂离 ≤ Shortleave (30s)：不打断
 * - Shortleave < 暂离 ≤ Longleave (60min)：暂停，提示"等待指挥官"
 * - 暂离 > Longleave：强制结算为离线
 * - 返回 ≤ Backtime (5s)：直接续上
 * - 跨日（北京 0 点）：当次专注视为同日，下次重新计算
 *
 * V0.2 仅给状态形与计算函数骨架，M4 接 focusMachine 时填业务
 */

export interface FocusTimerState {
  status: 'running' | 'paused' | 'forced_offline';
  startedAt: number | null;
  awayStartedAt: number | null;
  focusedMs: number;
  mode: 'explore' | 'companion';
}

export function initialFocusTimer(mode: 'explore' | 'companion'): FocusTimerState {
  return { status: 'running', startedAt: Date.now(), awayStartedAt: null, focusedMs: 0, mode };
}

export function tickAway(state: FocusTimerState, awayMs: number): FocusTimerState {
  const longleaveMs = getDict('Longleave') * 1000;
  if (awayMs > longleaveMs) return { ...state, status: 'forced_offline' };
  const shortleaveMs = getDict('Shortleave') * 1000;
  if (awayMs > shortleaveMs) return { ...state, status: 'paused' };
  return state;
}

// TODO M4: resumeOnReturn / accumulate / detectBoxGeneration
