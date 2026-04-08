/**
 * visual-gate.ts — 视觉门控（Phase 2B-1: 单条规则）
 *
 * 规则: visual.available && visual.present === false → force silent
 * 其他情况透传原始 level。
 */

import type { VisualState } from "./visual-state.js";

export type ProactiveLevel = "silent" | "prepare" | "suggest" | "act";

export interface VisualGateResult {
  readonly level: ProactiveLevel;
  readonly reason: string;
  readonly applied: boolean;
}

export function applyVisualGate(
  currentLevel: ProactiveLevel,
  visual: VisualState,
): VisualGateResult {
  // 唯一规则: 用户不在 → 静默
  if (visual.available && visual.present === false) {
    return {
      level: "silent",
      reason: "user away (present=false)",
      applied: currentLevel !== "silent",
    };
  }

  // 其他情况: 透传
  return {
    level: currentLevel,
    reason: visual.available
      ? `visual pass-through (present=${visual.present})`
      : "visual unavailable, pass-through",
    applied: false,
  };
}
