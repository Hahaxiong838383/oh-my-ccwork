import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * 设备诊断日志存储（合同：Godot/Launcher codex《DIAGNOSTIC_LOG_SERVER_HANDOFF》+ CC 复核回执 v1 §3.6，2026-09-18/19）。
 * 独立库 diagnostics.db（分库哲学同 telemetry.db）。三张表：
 *  - event：append-only，主键 (sn, client_event_id)——幂等键**按 SN 作用域**，跨设备同 ID 互不影响；
 *    同 ID 同载荷 = duplicated（对端侧等价 accepted）、异载荷 = conflict（进 rejected，让丢失可见）；
 *  - rejected：逐条拒绝原因留档（codex 回执 §4.2「拒绝原因由服务端保存」），只存 ≤1 KiB 脱敏摘录；
 *  - batch：每批一行台账（后台按 SN 看最近上传 / 计数 / 钟差）。
 * 每行落 server_received_ms + clock_skew_ms（= server − sent_at_ms）：钟差只标数据质量**不拒收**（回执 §1.4）。
 * 保留：全部级别 14 天（川哥 2026-09-19 冻结），purge 在摄入路径上按小时节流 + 进程启动时各跑一次。
 * 合同建议的 NDJSON 分桶 / 64 MiB 滚动 / gzip 不做（回执 §3.6 差异声明）。
 */

const DEFAULT_DB_PATH = './data/diagnostics.db';
/** §6 冻结：全部级别 14 天（error/fatal 不延长） */
export const DIAGLOG_RETENTION_DAYS_DEFAULT = 14;
const PURGE_MIN_INTERVAL_MS = 3600_000;

export type DiagLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export type DiagEventInput = {
  client_event_id: string;
  occurred_at_ms: number;
  level: DiagLevel;
  component: string;
  event: string;
  message: string;
  trace_id: string;
  data: Record<string, unknown>;
  redacted_count: number;
};

export type DiagBatchMeta = {
  schemaVersion: number;
  sentAtMs: number;
  serverReceivedMs: number;
  requestId: string;
  client: { product: string; component: string; protocol_version: string; content_version: string };
};

export type DiagEventOutcome = 'accepted' | 'duplicated' | 'conflict';

export type DiagEventRow = {
  sn: string;
  client_event_id: string;
  level: DiagLevel;
  component: string;
  event: string;
  message: string;
  trace_id: string;
  data_json: string;
  payload_hash: string;
  occurred_at_ms: number;
  sent_at_ms: number;
  server_received_ms: number;
  clock_skew_ms: number;
  schema_version: number;
  client_product: string;
  client_component: string;
  client_protocol_version: string;
  client_content_version: string;
  request_id: string;
  redacted_count: number;
};

export type DiagRejectedRow = {
  id: number;
  sn: string;
  client_event_id: string;
  reason: string;
  event: string;
  level: string;
  excerpt: string;
  server_received_ms: number;
  request_id: string;
};

export type DiagBatchRow = {
  id: number;
  sn: string;
  request_id: string;
  server_received_ms: number;
  sent_at_ms: number;
  clock_skew_ms: number;
  events_total: number;
  accepted: number;
  duplicated: number;
  rejected: number;
  redacted: number;
  client_content_version: string;
};

function hashPayload(obj: unknown): string {
  return createHash('sha256').update(JSON.stringify(obj), 'utf8').digest('hex');
}

function resolveDbPath(): string {
  const raw = process.env.DIAGNOSTICS_DB_PATH?.trim() || DEFAULT_DB_PATH;
  return resolve(process.cwd(), raw);
}

class DiagnosticsStore {
  private readonly db: DatabaseSync;
  private lastPurgeAt = 0;

  constructor() {
    const dbPath = resolveDbPath();
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS device_diag_event (
        sn TEXT NOT NULL,
        client_event_id TEXT NOT NULL,
        level TEXT NOT NULL,
        component TEXT NOT NULL,
        event TEXT NOT NULL,
        message TEXT NOT NULL,
        trace_id TEXT NOT NULL DEFAULT '',
        data_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        occurred_at_ms INTEGER NOT NULL,
        sent_at_ms INTEGER NOT NULL,
        server_received_ms INTEGER NOT NULL,
        clock_skew_ms INTEGER NOT NULL,
        schema_version INTEGER NOT NULL,
        client_product TEXT NOT NULL DEFAULT '',
        client_component TEXT NOT NULL DEFAULT '',
        client_protocol_version TEXT NOT NULL DEFAULT '',
        client_content_version TEXT NOT NULL DEFAULT '',
        request_id TEXT NOT NULL DEFAULT '',
        redacted_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (sn, client_event_id)
      );
      CREATE INDEX IF NOT EXISTS idx_diag_evt_sn_time ON device_diag_event (sn, server_received_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_diag_evt_time ON device_diag_event (server_received_ms);
      CREATE INDEX IF NOT EXISTS idx_diag_evt_level_time ON device_diag_event (level, server_received_ms DESC);
      CREATE TABLE IF NOT EXISTS device_diag_rejected (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sn TEXT NOT NULL,
        client_event_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        event TEXT NOT NULL DEFAULT '',
        level TEXT NOT NULL DEFAULT '',
        excerpt TEXT NOT NULL DEFAULT '',
        server_received_ms INTEGER NOT NULL,
        request_id TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_diag_rej_time ON device_diag_rejected (server_received_ms);
      CREATE INDEX IF NOT EXISTS idx_diag_rej_sn_time ON device_diag_rejected (sn, server_received_ms DESC);
      CREATE TABLE IF NOT EXISTS device_diag_batch (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sn TEXT NOT NULL,
        request_id TEXT NOT NULL DEFAULT '',
        server_received_ms INTEGER NOT NULL,
        sent_at_ms INTEGER NOT NULL,
        clock_skew_ms INTEGER NOT NULL,
        events_total INTEGER NOT NULL,
        accepted INTEGER NOT NULL,
        duplicated INTEGER NOT NULL,
        rejected INTEGER NOT NULL,
        redacted INTEGER NOT NULL,
        client_content_version TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_diag_batch_sn_time ON device_diag_batch (sn, server_received_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_diag_batch_time ON device_diag_batch (server_received_ms);
    `);
  }

  /** 一批一个事务（20 条内，写放大可忽略；失败整批回滚 → 路由返 500 不确认任何 ID，与合同一致）。 */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  ingestEvent(sn: string, ev: DiagEventInput, meta: DiagBatchMeta): DiagEventOutcome {
    const hash = hashPayload({
      occurred_at_ms: ev.occurred_at_ms,
      level: ev.level,
      component: ev.component,
      event: ev.event,
      message: ev.message,
      trace_id: ev.trace_id,
      data: ev.data,
    });
    const existing = this.db
      .prepare(`SELECT payload_hash FROM device_diag_event WHERE sn = ? AND client_event_id = ?`)
      .get(sn, ev.client_event_id) as { payload_hash: string } | undefined;
    if (existing) return existing.payload_hash === hash ? 'duplicated' : 'conflict';
    this.db
      .prepare(
        `INSERT INTO device_diag_event
         (sn, client_event_id, level, component, event, message, trace_id, data_json, payload_hash,
          occurred_at_ms, sent_at_ms, server_received_ms, clock_skew_ms, schema_version,
          client_product, client_component, client_protocol_version, client_content_version, request_id, redacted_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sn,
        ev.client_event_id,
        ev.level,
        ev.component,
        ev.event,
        ev.message,
        ev.trace_id,
        JSON.stringify(ev.data),
        hash,
        ev.occurred_at_ms,
        meta.sentAtMs,
        meta.serverReceivedMs,
        meta.serverReceivedMs - meta.sentAtMs,
        meta.schemaVersion,
        meta.client.product,
        meta.client.component,
        meta.client.protocol_version,
        meta.client.content_version,
        meta.requestId,
        ev.redacted_count,
      );
    return 'accepted';
  }

  recordRejected(
    sn: string,
    r: { client_event_id: string; reason: string; event: string; level: string; excerpt: string },
    meta: DiagBatchMeta,
  ): void {
    this.db
      .prepare(
        `INSERT INTO device_diag_rejected (sn, client_event_id, reason, event, level, excerpt, server_received_ms, request_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(sn, r.client_event_id, r.reason, r.event, r.level, r.excerpt.slice(0, 1024), meta.serverReceivedMs, meta.requestId);
  }

  recordBatch(
    sn: string,
    s: { events_total: number; accepted: number; duplicated: number; rejected: number; redacted: number },
    meta: DiagBatchMeta,
  ): void {
    this.db
      .prepare(
        `INSERT INTO device_diag_batch (sn, request_id, server_received_ms, sent_at_ms, clock_skew_ms, events_total, accepted, duplicated, rejected, redacted, client_content_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sn,
        meta.requestId,
        meta.serverReceivedMs,
        meta.sentAtMs,
        meta.serverReceivedMs - meta.sentAtMs,
        s.events_total,
        s.accepted,
        s.duplicated,
        s.rejected,
        s.redacted,
        meta.client.content_version,
      );
  }

  /** 按 server_received_ms 清理三张表；返回各表删除行数。 */
  purge(retentionDays: number, now = Date.now()): { events: number; rejected: number; batches: number } {
    const cutoff = now - retentionDays * 86_400_000;
    const events = Number(this.db.prepare(`DELETE FROM device_diag_event WHERE server_received_ms < ?`).run(cutoff).changes);
    const rejected = Number(this.db.prepare(`DELETE FROM device_diag_rejected WHERE server_received_ms < ?`).run(cutoff).changes);
    const batches = Number(this.db.prepare(`DELETE FROM device_diag_batch WHERE server_received_ms < ?`).run(cutoff).changes);
    this.lastPurgeAt = now;
    return { events, rejected, batches };
  }

  /** 摄入路径上的节流清理：距上次 ≥1h 才真跑；跑了返回计数，没跑返回 null。 */
  maybePurge(retentionDays: number, now = Date.now()): { events: number; rejected: number; batches: number } | null {
    if (now - this.lastPurgeAt < PURGE_MIN_INTERVAL_MS) return null;
    return this.purge(retentionDays, now);
  }

  // ─────────────── 后台查询（admin 专属；SN 在 admin 台内可见，与设备接入 tab 同口径）───────────────

  listEvents(q: {
    sn?: string;
    level?: string;
    event?: string;
    sinceMs?: number;
    untilMs?: number;
    limit?: number;
  }): DiagEventRow[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (q.sn) {
      where.push('sn = ?');
      args.push(q.sn);
    }
    if (q.level) {
      where.push('level = ?');
      args.push(q.level);
    }
    if (q.event) {
      where.push('event = ?');
      args.push(q.event);
    }
    if (q.sinceMs) {
      where.push('server_received_ms >= ?');
      args.push(q.sinceMs);
    }
    if (q.untilMs) {
      where.push('server_received_ms < ?');
      args.push(q.untilMs);
    }
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
    return this.db
      .prepare(
        `SELECT * FROM device_diag_event ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY server_received_ms DESC, occurred_at_ms DESC LIMIT ?`,
      )
      .all(...args, limit) as DiagEventRow[];
  }

  /** 批次对账（admin）：按 SN / 起始时间 / request_id 过滤，最新在前。 */
  listBatches(q: { sn?: string; sinceMs?: number; limit?: number; requestId?: string }): DiagBatchRow[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (q.sn) {
      where.push('sn = ?');
      args.push(q.sn);
    }
    if (q.sinceMs) {
      where.push('server_received_ms >= ?');
      args.push(q.sinceMs);
    }
    if (q.requestId) {
      where.push('request_id = ?');
      args.push(q.requestId);
    }
    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500);
    return this.db
      .prepare(
        `SELECT * FROM device_diag_batch ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY server_received_ms DESC, id DESC LIMIT ?`,
      )
      .all(...args, limit) as DiagBatchRow[];
  }

  listRejected(q: { sn?: string; sinceMs?: number; limit?: number }): DiagRejectedRow[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (q.sn) {
      where.push('sn = ?');
      args.push(q.sn);
    }
    if (q.sinceMs) {
      where.push('server_received_ms >= ?');
      args.push(q.sinceMs);
    }
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
    return this.db
      .prepare(
        `SELECT * FROM device_diag_rejected ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY server_received_ms DESC, id DESC LIMIT ?`,
      )
      .all(...args, limit) as DiagRejectedRow[];
  }

  summary(sinceMs: number): {
    since_ms: number;
    events_total: number;
    rejected_total: number;
    batches_total: number;
    levels: Array<{ level: string; count: number }>;
    top_events: Array<{ event: string; count: number }>;
    rejected_reasons: Array<{ reason: string; count: number }>;
    devices: Array<{
      sn: string;
      batches: number;
      accepted: number;
      duplicated: number;
      rejected: number;
      redacted: number;
      last_received_ms: number;
      last_skew_ms: number;
      last_content_version: string;
    }>;
    table_rows: { events: number; rejected: number; batches: number };
  } {
    const one = (sql: string, ...a: Array<string | number>) => (this.db.prepare(sql).get(...a) as { n: number }).n;
    const levels = this.db
      .prepare(`SELECT level, COUNT(*) AS count FROM device_diag_event WHERE server_received_ms >= ? GROUP BY level ORDER BY count DESC`)
      .all(sinceMs) as Array<{ level: string; count: number }>;
    const topEvents = this.db
      .prepare(
        `SELECT event, COUNT(*) AS count FROM device_diag_event WHERE server_received_ms >= ? GROUP BY event ORDER BY count DESC LIMIT 20`,
      )
      .all(sinceMs) as Array<{ event: string; count: number }>;
    const reasons = this.db
      .prepare(
        `SELECT reason, COUNT(*) AS count FROM device_diag_rejected WHERE server_received_ms >= ? GROUP BY reason ORDER BY count DESC`,
      )
      .all(sinceMs) as Array<{ reason: string; count: number }>;
    const devices = this.db
      .prepare(
        `SELECT b.sn AS sn, COUNT(*) AS batches, SUM(b.accepted) AS accepted, SUM(b.duplicated) AS duplicated,
                SUM(b.rejected) AS rejected, SUM(b.redacted) AS redacted, MAX(b.server_received_ms) AS last_received_ms,
                (SELECT clock_skew_ms FROM device_diag_batch WHERE sn = b.sn ORDER BY server_received_ms DESC LIMIT 1) AS last_skew_ms,
                (SELECT client_content_version FROM device_diag_batch WHERE sn = b.sn ORDER BY server_received_ms DESC LIMIT 1) AS last_content_version
         FROM device_diag_batch b WHERE b.server_received_ms >= ? GROUP BY b.sn ORDER BY last_received_ms DESC`,
      )
      .all(sinceMs) as Array<{
      sn: string;
      batches: number;
      accepted: number;
      duplicated: number;
      rejected: number;
      redacted: number;
      last_received_ms: number;
      last_skew_ms: number;
      last_content_version: string;
    }>;
    return {
      since_ms: sinceMs,
      events_total: one(`SELECT COUNT(*) AS n FROM device_diag_event WHERE server_received_ms >= ?`, sinceMs),
      rejected_total: one(`SELECT COUNT(*) AS n FROM device_diag_rejected WHERE server_received_ms >= ?`, sinceMs),
      batches_total: one(`SELECT COUNT(*) AS n FROM device_diag_batch WHERE server_received_ms >= ?`, sinceMs),
      levels,
      top_events: topEvents,
      rejected_reasons: reasons,
      devices,
      table_rows: {
        events: one(`SELECT COUNT(*) AS n FROM device_diag_event`),
        rejected: one(`SELECT COUNT(*) AS n FROM device_diag_rejected`),
        batches: one(`SELECT COUNT(*) AS n FROM device_diag_batch`),
      },
    };
  }

  /** 测试/运维用：按 SN 前缀删（探针 SN 清场）。返回删除行数。 */
  deleteBySnPrefix(prefix: string): { events: number; rejected: number; batches: number } {
    const like = `${prefix}%`;
    return {
      events: Number(this.db.prepare(`DELETE FROM device_diag_event WHERE sn LIKE ?`).run(like).changes),
      rejected: Number(this.db.prepare(`DELETE FROM device_diag_rejected WHERE sn LIKE ?`).run(like).changes),
      batches: Number(this.db.prepare(`DELETE FROM device_diag_batch WHERE sn LIKE ?`).run(like).changes),
    };
  }

  /** 测试用：某 SN 某 ID 的行 */
  getEvent(sn: string, clientEventId: string): DiagEventRow | null {
    return (
      (this.db.prepare(`SELECT * FROM device_diag_event WHERE sn = ? AND client_event_id = ?`).get(sn, clientEventId) as
        | DiagEventRow
        | undefined) ?? null
    );
  }
}

export const diagnosticsStore = new DiagnosticsStore();
