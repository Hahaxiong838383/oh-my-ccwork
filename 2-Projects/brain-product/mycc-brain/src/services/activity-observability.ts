/**
 * activity-observability.ts — Admin 视觉状态聚合（Phase 2B-1）
 *
 * 为 /admin/api/visual-status 提供聚合数据，逻辑不堆进 server.ts。
 */

import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { getVisualState, type VisualState } from "./visual-state.js";

export interface VisualStatusReport {
  readonly visual: VisualState;
  readonly daemon: Record<string, unknown> | null;
  readonly todayEventCount: number;
  readonly oldestLogDate: string | null;
  readonly statusFileExists: boolean;
  readonly latestFileExists: boolean;
  readonly latestEventAgeMs: number;
}

export function getVisualStatusReport(dataDir: string): VisualStatusReport {
  const activityDir = join(dataDir, "activity");
  const latestPath = join(activityDir, "latest.json");
  const statusPath = join(activityDir, "status.json");

  const visual = getVisualState();

  // 读 daemon status
  let daemon: Record<string, unknown> | null = null;
  if (existsSync(statusPath)) {
    try {
      daemon = JSON.parse(readFileSync(statusPath, "utf-8"));
    } catch { /* ignore parse error */ }
  }

  // 统计今日事件数
  const today = new Date().toISOString().slice(0, 10);
  const todayLogPath = join(activityDir, `${today}.jsonl`);
  let todayEventCount = 0;
  if (existsSync(todayLogPath)) {
    try {
      const content = readFileSync(todayLogPath, "utf-8");
      todayEventCount = content.trim().split("\n").filter(Boolean).length;
    } catch { /* ignore */ }
  }

  // 找最早的日志日期
  let oldestLogDate: string | null = null;
  if (existsSync(activityDir)) {
    try {
      const files = readdirSync(activityDir)
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
        .sort();
      if (files.length > 0) {
        oldestLogDate = files[0].replace(".jsonl", "");
      }
    } catch { /* ignore */ }
  }

  return {
    visual,
    daemon,
    todayEventCount,
    oldestLogDate,
    statusFileExists: existsSync(statusPath),
    latestFileExists: existsSync(latestPath),
    latestEventAgeMs: visual.staleMs === Infinity ? -1 : Math.round(visual.staleMs),
  };
}
