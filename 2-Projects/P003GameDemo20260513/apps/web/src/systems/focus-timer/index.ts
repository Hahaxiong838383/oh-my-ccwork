// 专注计时系统 —— M2 milestone 实现完整版
// 设计要点：
// - start / pause / resume / stop
// - 暂离 5min 内不中断（用户切到后台 -> 回来仍然算专注）
// - 每秒触发回调，宝箱系统订阅
// - 不 mutate 状态，全返回新对象

export interface FocusTimerState {
  startedAt: number | null;
  pausedAt: number | null;
  elapsedMs: number;
  status: 'idle' | 'running' | 'paused';
}

export const INITIAL_FOCUS_TIMER: FocusTimerState = {
  startedAt: null,
  pausedAt: null,
  elapsedMs: 0,
  status: 'idle',
};

export function startTimer(_state: FocusTimerState, _now: number = Date.now()): FocusTimerState {
  return { ..._state, startedAt: _now, status: 'running' };
}

// TODO M2: pauseTimer / resumeTimer / stopTimer / tickTimer
