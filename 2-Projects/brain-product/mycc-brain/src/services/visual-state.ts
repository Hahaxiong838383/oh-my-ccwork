/**
 * visual-state.ts — 进程级视觉状态单例（Phase 2B-1）
 *
 * 轮询 data/activity/latest.json 的 mtime，缓存 VisualState。
 * brain-api.ts 通过 getVisualState() 读缓存，不在热路径读磁盘。
 */

import { statSync, readFileSync } from "fs";
import { join } from "path";

export interface VisualChange {
  readonly event: string;
  readonly ts: string;
  readonly detail: string;
}

export interface VisualObservation {
  readonly ts: string;
  readonly present: boolean | null;
  readonly rawText: string;
  readonly change: string | null;
}

export interface VisualState {
  readonly available: boolean;
  readonly stale: boolean;
  readonly present: boolean | null;
  readonly activity: "active" | "idle" | "away" | "unknown";
  readonly motionLevel: number | null;
  readonly confidence: number | null;
  readonly audioLevel: number | null;
  readonly audioAvailable: boolean;
  readonly sceneSummary: string | null;
  readonly personAppearance: string | null;
  readonly personAction: string | null;
  readonly nearbyObjects: readonly string[];
  readonly semanticConfidence: number | null;
  readonly semanticAvailable: boolean;
  readonly semanticStale: boolean;
  readonly semanticLastEventAt: string | null;
  readonly semanticMethod: string | null;
  readonly lastChange: VisualChange | null;
  readonly recentObservations: readonly VisualObservation[];
  readonly rawText: string | null;
  readonly lastEventAt: string | null;
  readonly staleMs: number;
  readonly source: string | null;
}

const STALE_THRESHOLD_MS = 60_000;
const SEMANTIC_STALE_THRESHOLD_MS = 120_000;
const POLL_INTERVAL_MS = 3_000;

const DEFAULT_STATE: VisualState = {
  available: false,
  stale: true,
  present: null,
  activity: "unknown",
  motionLevel: null,
  confidence: null,
  audioLevel: null,
  audioAvailable: false,
  sceneSummary: null,
  personAppearance: null,
  personAction: null,
  nearbyObjects: [],
  semanticConfidence: null,
  semanticAvailable: false,
  semanticStale: true,
  semanticLastEventAt: null,
  semanticMethod: null,
  lastChange: null,
  recentObservations: [],
  rawText: null,
  lastEventAt: null,
  staleMs: Infinity,
  source: null,
};

let _state: VisualState = { ...DEFAULT_STATE };
let _timer: ReturnType<typeof setInterval> | null = null;
let _latestPath = "";
let _semanticLatestPath = "";
let _lastMtimeMs = 0;
let _lastEventTimeMs = 0;
let _semanticLastMtimeMs = 0;
let _semanticLastEventTimeMs = 0;

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseTimestampMs(timestamp: unknown): number | null {
  if (typeof timestamp !== "string" || timestamp.trim() === "") return null;
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? ms : null;
}

function toActivity(value: unknown): VisualState["activity"] {
  return value === "active" || value === "idle" || value === "away" || value === "unknown"
    ? value
    : "unknown";
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function parseNearbyObjects(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim() !== "")
    .map((item) => item.trim())
    .slice(0, 8);
}

function applySemanticSnapshot(raw: unknown): void {
  if (!raw || typeof raw !== "object") {
    _state = {
      ..._state,
      sceneSummary: null,
      personAppearance: null,
      personAction: null,
      nearbyObjects: [],
      semanticConfidence: null,
      semanticAvailable: false,
      semanticStale: true,
      semanticLastEventAt: null,
      semanticMethod: null,
      lastChange: null,
      recentObservations: [],
      rawText: null,
    };
    return;
  }

  const record = raw as Record<string, unknown>;
  const eventTimeMs = parseTimestampMs(record.timestamp) ?? Date.now();
  _semanticLastEventTimeMs = eventTimeMs;
  const ageMs = Math.max(0, Date.now() - eventTimeMs);
  const semanticStale = ageMs > SEMANTIC_STALE_THRESHOLD_MS;

  // 解析 lastChange
  const rawChange = record.lastChange;
  const lastChange: VisualChange | null =
    rawChange && typeof rawChange === "object" && typeof (rawChange as any).event === "string"
      ? { event: String((rawChange as any).event), ts: String((rawChange as any).ts ?? ""), detail: String((rawChange as any).detail ?? "") }
      : null;

  _state = {
    ..._state,
    sceneSummary: toStringOrNull(record.sceneSummary),
    personAppearance: toStringOrNull(record.personAppearance),
    personAction: toStringOrNull(record.personAction),
    nearbyObjects: parseNearbyObjects(record.nearbyObjects),
    semanticConfidence: toFiniteNumber(record.semanticConfidence),
    semanticAvailable: record.semanticAvailable === true && !semanticStale,
    semanticStale,
    semanticLastEventAt: parseTimestampMs(record.timestamp) !== null ? String(record.timestamp) : new Date(eventTimeMs).toISOString(),
    semanticMethod: toStringOrNull(record.semanticMethod),
    lastChange,
    rawText: toStringOrNull(record.rawText),
  };
}

function pollOnce(): void {
  try {
    const stat = statSync(_latestPath);
    const mtimeMs = stat.mtimeMs;

    if (mtimeMs !== _lastMtimeMs) {
      // 文件有变化，重新读取
      _lastMtimeMs = mtimeMs;
      const raw = JSON.parse(readFileSync(_latestPath, "utf-8"));
      const eventTimeMs = parseTimestampMs(raw.timestamp) ?? mtimeMs;
      _lastEventTimeMs = eventTimeMs;
      const ageMs = Math.max(0, Date.now() - eventTimeMs);
      const stale = ageMs > STALE_THRESHOLD_MS;

      _state = {
        available: !stale,
        stale,
        present: raw.present === true ? true : raw.present === false ? false : null,
        activity: toActivity(raw.activity),
        motionLevel: toFiniteNumber(raw.motionLevel),
        confidence: toFiniteNumber(raw.confidence),
        audioLevel: toFiniteNumber(raw.audioLevel),
        audioAvailable: raw.audioAvailable === true,
        sceneSummary: _state.sceneSummary,
        personAppearance: _state.personAppearance,
        personAction: _state.personAction,
        nearbyObjects: _state.nearbyObjects,
        semanticConfidence: _state.semanticConfidence,
        semanticAvailable: _state.semanticAvailable,
        semanticStale: _state.semanticStale,
        semanticLastEventAt: _state.semanticLastEventAt,
        semanticMethod: _state.semanticMethod,
        lastChange: _state.lastChange,
        recentObservations: _state.recentObservations,
        rawText: _state.rawText,
        lastEventAt: parseTimestampMs(raw.timestamp) !== null ? raw.timestamp : new Date(eventTimeMs).toISOString(),
        staleMs: ageMs,
        source: typeof raw.source === "string" && raw.source.trim() ? raw.source : null,
      };
    } else {
      // mtime 未变，仅更新 staleMs
      const eventTimeMs = _lastEventTimeMs || mtimeMs;
      const ageMs = Math.max(0, Date.now() - eventTimeMs);
      const stale = ageMs > STALE_THRESHOLD_MS;
      _state = { ..._state, stale, available: !stale, staleMs: ageMs };
    }
  } catch {
    // 文件不存在或读取错误 → 不可用
    _state = { ...DEFAULT_STATE };
    _lastMtimeMs = 0;
    _lastEventTimeMs = 0;
  }

  try {
    const semanticStat = statSync(_semanticLatestPath);
    if (semanticStat.mtimeMs !== _semanticLastMtimeMs) {
      _semanticLastMtimeMs = semanticStat.mtimeMs;
      const raw = JSON.parse(readFileSync(_semanticLatestPath, "utf-8"));
      applySemanticSnapshot(raw);

      // 读取当天视觉历史（最近 5 条）
      try {
        const today = new Date().toISOString().slice(0, 10);
        const historyPath = _semanticLatestPath.replace("semantic-latest.json", `semantic-history-${today}.jsonl`);
        const historyContent = readFileSync(historyPath, "utf-8").trim();
        if (historyContent) {
          const lines = historyContent.split("\n");
          const recentLines = lines.slice(-5);
          const observations: VisualObservation[] = [];
          for (const line of recentLines) {
            try {
              const entry = JSON.parse(line);
              observations.push({
                ts: typeof entry.ts === "string" ? entry.ts : "",
                present: entry.present === true ? true : entry.present === false ? false : null,
                rawText: typeof entry.rawText === "string" ? entry.rawText : "",
                change: typeof entry.change === "string" ? entry.change : null,
              });
            } catch { /* skip malformed lines */ }
          }
          _state = { ..._state, recentObservations: observations };
        }
      } catch {
        // 历史文件不存在时不影响主流程
      }
    } else if (_semanticLastEventTimeMs > 0) {
      const ageMs = Math.max(0, Date.now() - _semanticLastEventTimeMs);
      const semanticStale = ageMs > SEMANTIC_STALE_THRESHOLD_MS;
      _state = {
        ..._state,
        semanticStale,
        semanticAvailable: _state.semanticAvailable && !semanticStale,
      };
    }
  } catch {
    _semanticLastMtimeMs = 0;
    _semanticLastEventTimeMs = 0;
    _state = {
      ..._state,
      sceneSummary: null,
      personAppearance: null,
      personAction: null,
      nearbyObjects: [],
      semanticConfidence: null,
      semanticAvailable: false,
      semanticStale: true,
      semanticLastEventAt: null,
      semanticMethod: null,
      lastChange: null,
      recentObservations: [],
      rawText: null,
    };
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
  _semanticLatestPath = join(dataDir, "activity", "semantic-latest.json");
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
