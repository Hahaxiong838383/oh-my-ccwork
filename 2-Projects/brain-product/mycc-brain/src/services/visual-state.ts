/**
 * visual-state.ts — 进程级视觉状态单例（Phase 2B-1）
 *
 * 轮询 data/activity/latest.json 的 mtime，缓存 VisualState。
 * brain-api.ts 通过 getVisualState() 读缓存，不在热路径读磁盘。
 */

import { statSync, readFileSync } from "fs";
import { join } from "path";

export interface VisualState {
  readonly available: boolean;
  readonly stale: boolean;
  readonly present: boolean | null;
  readonly activity: "active" | "idle" | "away" | "unknown";
  readonly motionLevel: number | null;
  readonly confidence: number | null;
  readonly lastEventAt: string | null;
  readonly staleMs: number;
  readonly source: string | null;
}

const STALE_THRESHOLD_MS = 60_000;
const POLL_INTERVAL_MS = 3_000;

const DEFAULT_STATE: VisualState = {
  available: false,
  stale: true,
  present: null,
  activity: "unknown",
  motionLevel: null,
  confidence: null,
  lastEventAt: null,
  staleMs: Infinity,
  source: null,
};

let _state: VisualState = { ...DEFAULT_STATE };
let _timer: ReturnType<typeof setInterval> | null = null;
let _latestPath = "";
let _lastMtimeMs = 0;

function pollOnce(): void {
  try {
    const stat = statSync(_latestPath);
    const mtimeMs = stat.mtimeMs;

    if (mtimeMs !== _lastMtimeMs) {
      // 文件有变化，重新读取
      _lastMtimeMs = mtimeMs;
      const raw = JSON.parse(readFileSync(_latestPath, "utf-8"));
      const eventTime = raw.timestamp ? new Date(raw.timestamp).getTime() : mtimeMs;
      const ageMs = Date.now() - eventTime;
      const stale = ageMs > STALE_THRESHOLD_MS;

      _state = {
        available: !stale,
        stale,
        present: raw.present ?? null,
        activity: raw.activity ?? "unknown",
        motionLevel: raw.motionLevel ?? null,
        confidence: raw.confidence ?? null,
        lastEventAt: raw.timestamp ?? null,
        staleMs: ageMs,
        source: raw.source ?? null,
      };
    } else {
      // mtime 未变，仅更新 staleMs
      const eventTime = _state.lastEventAt ? new Date(_state.lastEventAt).getTime() : 0;
      const ageMs = eventTime ? Date.now() - eventTime : Infinity;
      const stale = ageMs > STALE_THRESHOLD_MS;
      _state = { ..._state, stale, available: !stale, staleMs: ageMs };
    }
  } catch {
    // 文件不存在或读取错误 → 不可用
    _state = { ...DEFAULT_STATE };
    _lastMtimeMs = 0;
  }
}

/** 获取当前视觉状态（内存缓存，无磁盘 IO）。 */
export function getVisualState(): VisualState {
  return _state;
}

/** 启动轮询。dataDir = brain data 目录（包含 activity/ 子目录）。 */
export function startVisualStatePolling(dataDir: string): void {
  if (_timer) return;
  _latestPath = join(dataDir, "activity", "latest.json");
  _timer = setInterval(pollOnce, POLL_INTERVAL_MS);
  pollOnce();
  console.log(`[visual-state] polling started: ${_latestPath}`);
}

/** 停止轮询。 */
export function stopVisualStatePolling(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
    console.log("[visual-state] polling stopped");
  }
}
