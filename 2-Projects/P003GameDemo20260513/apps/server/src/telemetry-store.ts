import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * 设备遥测存储（联调合同 CODEX_P003_DEVICE_TELEMETRY_REPLY_20260824 + CC 实施计划，2026-08-24）。
 * 独立库 telemetry.db（分库哲学同 sms.db/devices.db）。三张表：
 *  - snapshot：设备状态快照全存（append，唯一键 sn+snapshot_id 幂等），查询取最新；
 *  - event：append-only 事件流（唯一键 sn+event_id；同 ID 同 payload=duplicated、异 payload=conflict 409 不覆盖）；
 *  - daily：设备×自然日聚合（Asia/Shanghai 固定 UTC+8，P0 国内产品；focus_segment 跨日按天分摊）。
 * 每行落双时间戳 + clock_skew_ms（钟差只标数据质量不拒收，合同 §11）。
 * guardedMinutes 口径（P0 近似，T16 对撞修正）：当日有有效姿态轮（correct+deviated>0）则
 * guarded=focus——查询时计算不落库，后到的 posture_round 自然生效。
 */

const DEFAULT_DB_PATH = './data/telemetry.db';
const TZ_OFFSET_MS = 8 * 3600_000; // Asia/Shanghai 固定 UTC+8（无夏令时）

export type SnapshotInput = {
  snapshot_id: string;
  captured_at_ms: number;
  lid_open?: boolean | null;
  present?: boolean | null;
  presence_state?: string | null;
  presence_source?: string | null;
  led_enabled?: boolean | null;
  brightness_level?: number | null;
  color_mode?: string | null;
  image_distance_m?: number | null;
  image_distance_state?: string | null;
  volume_percent?: number | null;
  signal_strength?: number | null;
  focus_active?: boolean | null;
  focus_id?: string | null;
};

export type EventInput = {
  event_id: string;
  type: string;
  occurred_at_ms: number;
  data: Record<string, unknown>;
};

export type IngestMeta = {
  schemaVersion: number;
  deviceTsMs: number;
  serverReceivedMs: number;
  traceId: string;
};

export type EventOutcome = 'accepted' | 'duplicated' | 'conflict' | 'invalid_event_data' | 'focus_segment_overlap';

const DAY_MS = 86400_000;
// Epoch milliseconds within four-digit calendar years; at most one day per segment.
// mini008 normally reports ~60s and a final short tail. No new clock-skew/late-upload gate.
const MAX_FOCUS_TIMESTAMP = 253402271999999;
// Keep the indexed expression identical in DDL/queries. CASE protects dirty legacy JSON
// regardless of the planner's predicate evaluation order; the partial index excludes it.
const FOCUS_END_SQL = "CASE WHEN json_valid(data_json) THEN json_extract(data_json, '$.end_ms') END";
function focusInterval(data: Record<string, unknown>): { start: number; end: number } | null {
  const start = data.start_ms, end = data.end_ms;
  if (typeof start !== 'number' || typeof end !== 'number'
    || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || start < 0 || end > MAX_FOCUS_TIMESTAMP || end <= start || end - start > DAY_MS) return null;
  return { start, end };
}

/** 自然日字符串（Asia/Shanghai）。 */
export function dayOf(ms: number): string {
  return new Date(ms + TZ_OFFSET_MS).toISOString().slice(0, 10);
}

function hashPayload(obj: unknown): string {
  return createHash('sha256').update(JSON.stringify(obj), 'utf8').digest('hex');
}

function resolveDbPath(): string {
  const raw = process.env.TELEMETRY_DB_PATH?.trim() || DEFAULT_DB_PATH;
  return resolve(process.cwd(), raw);
}

type PostureDay = {date:string;available:boolean;reason:string;played_count:number|null;suppressed_count:number|null;unknown_count:number;clock_suspect_count:number;updated_at_ms:number|null};
const emptyPostureDay=(date:string,reason:string):PostureDay=>({date,available:false,reason,played_count:null,suppressed_count:null,unknown_count:0,clock_suspect_count:0,updated_at_ms:null});
export function emptyPostureReminders(now=Date.now(),reason='no_reminder_events') {
  return {source:'telemetry.posture_reminder' as const,timezone:'Asia/Shanghai' as const,available:false,reason,
    today:emptyPostureDay(dayOf(now),reason),
    history:{available:false,reason,played_count:null as number|null,suppressed_count:null as number|null,unknown_count:0,clock_suspect_count:0,from_day:null as string|null,to_day:null as string|null,updated_at_ms:null as number|null},
    daily:[] as PostureDay[],coverage:{complete:false as const,reason:'received_events_only' as const,first_received_at_ms:null as number|null,last_received_at_ms:null as number|null,clock_suspect_count:0,invalid_time_count:0}};
}

class TelemetryStore {
  private readonly db: DatabaseSync;

  constructor() {
    const dbPath = resolveDbPath();
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS device_telemetry_snapshot (
        sn TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        captured_at_ms INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        device_ts_ms INTEGER NOT NULL,
        server_received_ms INTEGER NOT NULL,
        clock_skew_ms INTEGER NOT NULL,
        ingest_trace_id TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (sn, snapshot_id)
      );
      CREATE INDEX IF NOT EXISTS idx_tel_snap_sn_time ON device_telemetry_snapshot (sn, captured_at_ms DESC);
      CREATE TABLE IF NOT EXISTS device_telemetry_event (
        sn TEXT NOT NULL,
        event_id TEXT NOT NULL,
        type TEXT NOT NULL,
        occurred_at_ms INTEGER NOT NULL,
        data_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        server_received_ms INTEGER NOT NULL,
        clock_skew_ms INTEGER NOT NULL,
        ingest_trace_id TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (sn, event_id)
      );
      CREATE INDEX IF NOT EXISTS idx_tel_evt_sn_time ON device_telemetry_event (sn, occurred_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_tel_focus_sn_end ON device_telemetry_event (sn, (${FOCUS_END_SQL}))
        WHERE type = 'focus_segment' AND json_valid(data_json);
      CREATE TABLE IF NOT EXISTS device_telemetry_daily (
        sn TEXT NOT NULL,
        date TEXT NOT NULL,
        focus_ms INTEGER NOT NULL DEFAULT 0,
        correct_rounds INTEGER NOT NULL DEFAULT 0,
        deviated_rounds INTEGER NOT NULL DEFAULT 0,
        no_person_rounds INTEGER NOT NULL DEFAULT 0,
        failed_rounds INTEGER NOT NULL DEFAULT 0,
        reminder_played INTEGER NOT NULL DEFAULT 0,
        reminder_suppressed INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (sn, date)
      );
    `);
  }

  /** 快照幂等写入：同 (sn, snapshot_id) 重复 → duplicated（payload 不比对，快照无 409 语义）。 */
  ingestSnapshot(sn: string, snap: SnapshotInput, meta: IngestMeta): { accepted: boolean; duplicated: boolean } {
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO device_telemetry_snapshot
         (sn, snapshot_id, captured_at_ms, payload_json, schema_version, device_ts_ms, server_received_ms, clock_skew_ms, ingest_trace_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sn,
        snap.snapshot_id,
        snap.captured_at_ms,
        JSON.stringify(snap),
        meta.schemaVersion,
        meta.deviceTsMs,
        meta.serverReceivedMs,
        meta.serverReceivedMs - meta.deviceTsMs,
        meta.traceId,
      );
    const inserted = Number(r.changes) > 0;
    return { accepted: true, duplicated: !inserted };
  }

  /**
   * 事件幂等写入 + accepted 时增量聚合 daily。
   * 返回 accepted / duplicated（同 ID 同 payload）/ conflict（同 ID 异 payload，路由层入 rejected 409 语义）。
   */
  ingestEvent(sn: string, ev: EventInput, meta: IngestMeta): EventOutcome {
    if (ev.type !== 'focus_segment' && ev.type !== 'posture_reminder') return this.insertEvent(sn, ev, meta);
    // Keep first receipt and daily increments atomic; a failed increment must be retryable.
    // Focus overlap checking uses the same transaction, including across processes.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const outcome = this.insertEvent(sn, ev, meta);
      this.db.exec('COMMIT');
      return outcome;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private insertEvent(sn: string, ev: EventInput, meta: IngestMeta): EventOutcome {
    const hash = hashPayload({ type: ev.type, occurred_at_ms: ev.occurred_at_ms, data: ev.data });
    const existing = this.db
      .prepare(`SELECT payload_hash FROM device_telemetry_event WHERE sn = ? AND event_id = ?`)
      .get(sn, ev.event_id) as { payload_hash: string } | undefined;
    if (existing) return existing.payload_hash === hash ? 'duplicated' : 'conflict';
    if (ev.type === 'focus_segment') {
      const interval = focusInterval(ev.data);
      if (!interval || !Number.isSafeInteger(ev.occurred_at_ms)
        || ev.occurred_at_ms < 0 || ev.occurred_at_ms > MAX_FOCUS_TIMESTAMP) return 'invalid_event_data';
      if (this.focusSegments(sn, interval.start, interval.end).length) return 'focus_segment_overlap';
    }
    this.db
      .prepare(
        `INSERT INTO device_telemetry_event
         (sn, event_id, type, occurred_at_ms, data_json, payload_hash, schema_version, server_received_ms, clock_skew_ms, ingest_trace_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sn,
        ev.event_id,
        ev.type,
        ev.occurred_at_ms,
        JSON.stringify(ev.data),
        hash,
        meta.schemaVersion,
        meta.serverReceivedMs,
        meta.serverReceivedMs - meta.deviceTsMs,
        meta.traceId,
      );
    this.aggregate(sn, ev);
    return 'accepted';
  }

  /** 增量聚合（只在 accepted 时调用一次——duplicated 不重复计是幂等聚合的关键）。 */
  private aggregate(sn: string, ev: EventInput): void {
    const bump = (date: string, col: string, delta: number): void => {
      this.db
        .prepare(
          `INSERT INTO device_telemetry_daily (sn, date, ${col}) VALUES (?, ?, ?)
           ON CONFLICT(sn, date) DO UPDATE SET ${col} = ${col} + excluded.${col}`,
        )
        .run(sn, date, delta);
    };
    if (ev.type === 'focus_segment') {
      const interval = focusInterval(ev.data);
      if (!interval) return;
      const { start, end } = interval;
      // 跨日按天分摊（Asia/Shanghai 自然日切分）
      let cur = start;
      while (cur < end) {
        const day = dayOf(cur);
        const nextMidnight = Date.parse(`${day}T00:00:00+08:00`) + 86400_000;
        const sliceEnd = Math.min(end, nextMidnight);
        bump(day, 'focus_ms', sliceEnd - cur);
        cur = sliceEnd;
      }
      return;
    }
    if (ev.type === 'posture_round') {
      const result = String(ev.data.result ?? '');
      const col =
        result === 'correct'
          ? 'correct_rounds'
          : result === 'deviated'
            ? 'deviated_rounds'
            : result === 'no_person'
              ? 'no_person_rounds'
              : 'failed_rounds';
      bump(dayOf(ev.occurred_at_ms), col, 1);
      return;
    }
    if (ev.type === 'posture_reminder') {
      const outcome = ev.data.outcome;
      if ((outcome === 'played' || outcome === 'suppressed_cooldown')
        && Number.isSafeInteger(ev.occurred_at_ms) && ev.occurred_at_ms >= 1 && ev.occurred_at_ms <= MAX_FOCUS_TIMESTAMP) {
        bump(dayOf(ev.occurred_at_ms), outcome === 'played' ? 'reminder_played' : 'reminder_suppressed', 1);
      }
      // Unknown outcomes remain raw facts; they are neither playback nor cooldown.
    }
  }

  /** Raw focus evidence only; old daily rows can contain posture-only zero or invalid focus. */
  private focusSegments(sn: string, from: number, to: number) {
    const rows = this.db.prepare(`SELECT event_id, data_json, occurred_at_ms, server_received_ms
      FROM device_telemetry_event WHERE sn = ? AND type = 'focus_segment'
      AND json_valid(data_json)
      AND (${FOCUS_END_SQL}) > ? AND (${FOCUS_END_SQL}) < ?
      AND CASE WHEN json_valid(data_json) THEN json_extract(data_json, '$.start_ms') < ? ELSE 0 END
      ORDER BY server_received_ms, rowid`).all(sn, from, to + DAY_MS, to) as Array<{
        event_id: string; data_json: string; occurred_at_ms: number; server_received_ms: number;
      }>;
    // A valid segment lasts <= DAY_MS: start < to implies end < to + DAY_MS.
    // Both end bounds are indexable, including for late historical ingest. JS validation
    // and first-receipt ordering still decide validity/legacy overlap exactly as before.
    return rows.flatMap(row => {
      const interval = focusInterval(JSON.parse(row.data_json));
      return interval && Number.isSafeInteger(row.occurred_at_ms)
        && row.occurred_at_ms >= 0 && row.occurred_at_ms <= MAX_FOCUS_TIMESTAMP
        ? [{ ...interval, received: row.server_received_ms }] : [];
    });
  }

  /** 已上报使用时长，包含普通游戏/聊天；不代表学习质量或完整全天覆盖。 */
  usageRange(sn: string, fromDate: string, toDate: string) {
    const from = Date.parse(`${fromDate}T00:00:00+08:00`);
    const to = Date.parse(`${toDate}T00:00:00+08:00`) + DAY_MS;
    const totals = new Map<string, { ms: number; received: number }>();
    // Include a one-segment margin so a legacy overlap across the window edge cannot count twice.
    const segments = this.focusSegments(sn, from - DAY_MS, to + DAY_MS);
    const prior: Array<{ start: number; end: number }> = [];
    for (const s of segments) {
      // Keep a sorted union of earlier raw intervals, avoiding a quadratic scan on ordinary uploads.
      let lo = 0, hi = prior.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (prior[mid].end <= s.start) lo = mid + 1; else hi = mid;
      }
      const overlaps = lo < prior.length && prior[lo].start < s.end;
      let last = lo, start = s.start, stop = s.end;
      while (last < prior.length && prior[last].start < stop) {
        start = Math.min(start, prior[last].start); stop = Math.max(stop, prior[last].end); last++;
      }
      prior.splice(lo, last - lo, { start, end: stop });
      // Legacy later overlaps are conservatively omitted; historical event/daily rows stay unchanged.
      if (overlaps) continue;
      let cur = Math.max(from, s.start);
      const end = Math.min(to, s.end);
      while (cur < end) {
        const day = dayOf(cur);
        const next = Math.min(end, Date.parse(`${day}T00:00:00+08:00`) + DAY_MS);
        const old = totals.get(day);
        totals.set(day, { ms: (old?.ms ?? 0) + next - cur, received: Math.max(old?.received ?? 0, s.received) });
        cur = next;
      }
    }
    const daily = [];
    for (let cur = from; cur < to; cur += DAY_MS) {
      const date = dayOf(cur), total = totals.get(date);
      daily.push({ date, available: !!total, focus_minutes: total ? Math.round(total.ms / 60_000) : null,
        updated_at_ms: total?.received ?? null });
    }
    return daily;
  }

  /** Count immutable, per-device unique reminder events, never batches or posture rounds.
   * This remains the existing Telemetry SN history domain (weekly-report already reads
   * arbitrary historical weeks); no event IDs/text or additional cross-device scope is exposed.
   * Raw reads also preserve correct history when an old daily aggregate is incomplete.
   */
  postureReminders(sn:string,now=Date.now()):ReturnType<typeof emptyPostureReminders> {
    type Row={date:string|null;events:number;played:number;suppressed:number;unknown:number;clock_suspect:number;first_received:number;last_received:number};
    const rows=this.db.prepare(`WITH reminders AS (
      SELECT CASE WHEN typeof(occurred_at_ms)='integer' AND occurred_at_ms BETWEEN 1 AND ${MAX_FOCUS_TIMESTAMP}
        THEN strftime('%Y-%m-%d',occurred_at_ms/1000.0,'unixepoch','+8 hours') END date,
        CASE WHEN json_valid(data_json) THEN json_extract(data_json,'$.outcome') END outcome,
        CASE WHEN ABS(clock_skew_ms)>300000 OR occurred_at_ms>server_received_ms+300000 THEN 1 ELSE 0 END clock_suspect,
        server_received_ms
      FROM device_telemetry_event WHERE sn=? AND type='posture_reminder'
    ) SELECT date,COUNT(*) events,
      SUM(CASE WHEN outcome='played' THEN 1 ELSE 0 END) played,
      SUM(CASE WHEN outcome='suppressed_cooldown' THEN 1 ELSE 0 END) suppressed,
      SUM(CASE WHEN outcome IS NULL OR outcome NOT IN ('played','suppressed_cooldown') THEN 1 ELSE 0 END) unknown,
      SUM(clock_suspect) clock_suspect,MIN(server_received_ms) first_received,MAX(server_received_ms) last_received
      FROM reminders GROUP BY date ORDER BY date LIMIT 3661`).all(sn) as Row[];
    // Bound the response rather than silently calling a truncated range all history.
    if(rows.length>3660)throw new Error('posture_history_query_limit');
    const result=emptyPostureReminders(now),valid=rows.filter((r):r is Row & {date:string}=>r.date!==null);
    const reason=(played:number,suppressed:number,events:number)=>played+suppressed>0?'partial_history':events>0?'no_supported_outcome':'no_reminder_events';
    result.daily=valid.map(r=>({date:r.date,available:r.played+r.suppressed>0,reason:reason(r.played,r.suppressed,r.events),
      played_count:r.played+r.suppressed>0?r.played:null,suppressed_count:r.played+r.suppressed>0?r.suppressed:null,
      unknown_count:r.unknown,clock_suspect_count:r.clock_suspect,updated_at_ms:r.last_received}));
    result.today=result.daily.find(r=>r.date===dayOf(now))??result.today;
    const played=valid.reduce((n,r)=>n+r.played,0),suppressed=valid.reduce((n,r)=>n+r.suppressed,0),events=valid.reduce((n,r)=>n+r.events,0),available=played+suppressed>0;
    result.available=available;result.reason=valid.length?reason(played,suppressed,events):rows.length?'invalid_event_time':'no_reminder_events';
    result.history={available,reason:result.reason,played_count:available?played:null,suppressed_count:available?suppressed:null,
      unknown_count:valid.reduce((n,r)=>n+r.unknown,0),clock_suspect_count:valid.reduce((n,r)=>n+r.clock_suspect,0),
      from_day:valid[0]?.date??null,to_day:valid.at(-1)?.date??null,updated_at_ms:valid.length?Math.max(...valid.map(r=>r.last_received)):null};
    result.coverage={...result.coverage,first_received_at_ms:rows.length?Math.min(...rows.map(r=>r.first_received)):null,
      last_received_at_ms:rows.length?Math.max(...rows.map(r=>r.last_received)):null,
      clock_suspect_count:valid.reduce((n,r)=>n+r.clock_suspect,0),invalid_time_count:rows.filter(r=>r.date===null).reduce((n,r)=>n+r.events,0)};
    return result;
  }

  /** 最新快照（dashboard 设备实时态）。 */
  latestSnapshot(sn: string): { payload: SnapshotInput; server_received_ms: number } | null {
    const row = this.db
      .prepare(
        `SELECT payload_json, server_received_ms FROM device_telemetry_snapshot
         WHERE sn = ? ORDER BY captured_at_ms DESC LIMIT 1`,
      )
      .get(sn) as { payload_json: string; server_received_ms: number } | undefined;
    if (!row) return null;
    return { payload: JSON.parse(row.payload_json) as SnapshotInput, server_received_ms: row.server_received_ms };
  }

  /** 日聚合区间查询（含 guarded 口径计算：当日有有效姿态轮则 guarded=focus）。 */
  dailyRange(sn: string, fromDate: string, toDate: string): Array<{
    date: string;
    focus_ms: number;
    guarded_ms: number;
    correct_rounds: number;
    deviated_rounds: number;
    reminder_played: number;
  }> {
    const rows = this.db
      .prepare(
        `SELECT date, focus_ms, correct_rounds, deviated_rounds, no_person_rounds, failed_rounds, reminder_played
         FROM device_telemetry_daily WHERE sn = ? AND date >= ? AND date <= ? ORDER BY date`,
      )
      .all(sn, fromDate, toDate) as Array<{
      date: string;
      focus_ms: number;
      correct_rounds: number;
      deviated_rounds: number;
      no_person_rounds: number;
      failed_rounds: number;
      reminder_played: number;
    }>;
    return rows.map((r) => ({
      date: r.date,
      focus_ms: r.focus_ms,
      // P0 近似（合同实施计划 A3，T16 对撞修正）：守护启用期间≈当日有有效姿态轮
      guarded_ms: r.correct_rounds + r.deviated_rounds > 0 ? r.focus_ms : 0,
      correct_rounds: r.correct_rounds,
      deviated_rounds: r.deviated_rounds,
      reminder_played: r.reminder_played,
    }));
  }
}

export const telemetryStore = new TelemetryStore();
