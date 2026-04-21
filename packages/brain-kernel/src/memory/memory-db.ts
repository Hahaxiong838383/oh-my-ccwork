import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { MemCell, CompiledTruth, TimelineEntry, TaskRecord, DegradationMetrics, Session, ChatMessage } from '@evodesk/shared';
import { reindexTruthAsync } from '../lib/sidecar-client.js';
import { runEpisodicMigrations } from './episodic-migrations.js';

const HALF_LIFE_DAYS = 30;
const HALF_LIFE_MS = HALF_LIFE_DAYS * 24 * 3600 * 1000;

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

export function initDb(dbPath: string): Database.Database {
  if (db) {
    db.close();
    db = null;
  }
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS mem_cells (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      content_hash TEXT NOT NULL UNIQUE,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS compiled_truths (
      id TEXT PRIMARY KEY,
      domain TEXT NOT NULL,
      statement TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.5,
      valid_at INTEGER NOT NULL,
      invalid_at INTEGER,
      source_ids TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS timeline (
      id TEXT PRIMARY KEY,
      event TEXT NOT NULL,
      source TEXT NOT NULL,
      first_seen INTEGER NOT NULL,
      occurrences INTEGER NOT NULL DEFAULT 1,
      related_ids TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS task_log (
      id TEXT PRIMARY KEY,
      domain TEXT NOT NULL,
      data TEXT NOT NULL,
      completed_at INTEGER NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS truths_fts USING fts5(
      domain, statement,
      content='compiled_truths',
      content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS truths_ai AFTER INSERT ON compiled_truths BEGIN
      INSERT INTO truths_fts(rowid, domain, statement) VALUES (new.rowid, new.domain, new.statement);
    END;

    CREATE TRIGGER IF NOT EXISTS truths_ad AFTER DELETE ON compiled_truths BEGIN
      INSERT INTO truths_fts(truths_fts, rowid, domain, statement) VALUES('delete', old.rowid, old.domain, old.statement);
    END;

    CREATE TRIGGER IF NOT EXISTS truths_au AFTER UPDATE ON compiled_truths BEGIN
      INSERT INTO truths_fts(truths_fts, rowid, domain, statement) VALUES('delete', old.rowid, old.domain, old.statement);
      INSERT INTO truths_fts(rowid, domain, statement) VALUES (new.rowid, new.domain, new.statement);
    END;

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_accessed_at INTEGER NOT NULL,
      closed_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(closed_at, last_accessed_at DESC);

    CREATE TABLE IF NOT EXISTS query_log (
      id TEXT PRIMARY KEY,
      query_hash TEXT NOT NULL,
      domains_hit TEXT NOT NULL DEFAULT '[]',
      retrieval_paths TEXT NOT NULL DEFAULT '[]',
      item_count INTEGER NOT NULL DEFAULT 0,
      timestamp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_query_log_ts ON query_log(timestamp DESC);

    -- V1.3.12（P0-2 Gemini 评审修复）：episodic_traces 独立表
    -- 配合 M16 元认知 spec v1.0.2 的 verification_status 三态契约。
    -- 下游（M4 extractor / M13 knowledge_expansion / M3 retrieval）必须识别该状态。
    -- 表结构参考 M16-spec §【架构】核心数据结构，独立于 timeline（事件 vs 聚合计数）。
    CREATE TABLE IF NOT EXISTS episodic_traces (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      user_id TEXT NOT NULL DEFAULT 'default',
      event TEXT NOT NULL,
      context TEXT NOT NULL DEFAULT '',
      timestamp INTEGER NOT NULL,
      mem_cell_id TEXT,
      verification_status TEXT NOT NULL DEFAULT 'verified'
        CHECK(verification_status IN ('verified','unverified','verified_by_m16'))
    );
    CREATE INDEX IF NOT EXISTS idx_episodic_verification
      ON episodic_traces(verification_status, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_episodic_user_ts
      ON episodic_traces(user_id, timestamp DESC);
  `);

  runEpisodicMigrations(db);

  return db;
}

export function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function sanitizeFtsQuery(query: string): string {
  // 截断过长查询，防 DoS
  const truncated = query.length > 500 ? query.slice(0, 500) : query;
  const cleaned = truncated.replace(/[.*+\-"'(){}[\]^~:@#$%&\\|<>=!?;,/]/g, ' ');
  const tokens = cleaned
    .split(/\s+/)
    .filter(t => t.length > 0)
    .slice(0, 50) // 最多 50 个 token
    .map(t => `"${t}"`);
  return tokens.join(' OR ') || '""';
}

export function insertMemCell(cell: MemCell): { written: boolean; reason?: string } {
  const d = getDb();
  const hash = contentHash(JSON.stringify({
    episodicTraces: cell.episodicTraces,
    atomicFacts: cell.atomicFacts,
  }));

  const cellWithHash: MemCell = { ...cell, contentHash: hash };
  const result = d.prepare(
    'INSERT INTO mem_cells (id, session_id, content_hash, data, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(content_hash) DO NOTHING'
  ).run(cell.id, cell.sessionId, hash, JSON.stringify(cellWithHash), cell.createdAt);

  return result.changes > 0 ? { written: true } : { written: false, reason: 'duplicate' };
}

export function insertCompiledTruth(truth: CompiledTruth): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO compiled_truths (id, domain, statement, confidence, valid_at, invalid_at, source_ids)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    truth.id, truth.domain, truth.statement, truth.confidence,
    truth.validAt, truth.invalidAt ?? null, JSON.stringify(truth.sourceMemCellIds),
  );
}

export function appendTimeline(entry: TimelineEntry): void {
  getDb().prepare(`
    INSERT INTO timeline (id, event, source, first_seen, occurrences, related_ids)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET occurrences = occurrences + 1
  `).run(entry.id, entry.event, entry.source, entry.firstSeen, entry.occurrences, JSON.stringify(entry.relatedMemCellIds));
}

export function searchTruths(query: string, limit = 10): readonly CompiledTruth[] {
  const ftsQuery = sanitizeFtsQuery(query);
  const rows = getDb().prepare(`
    SELECT ct.* FROM compiled_truths ct
    JOIN truths_fts ON truths_fts.rowid = ct.rowid
    WHERE truths_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `).all(ftsQuery, limit) as Array<{
    id: string; domain: string; statement: string; confidence: number;
    valid_at: number; invalid_at: number | null; source_ids: string;
  }>;

  return rows.flatMap(r => {
    try {
      return [{
        id: r.id, domain: r.domain, statement: r.statement, confidence: r.confidence,
        validAt: r.valid_at, invalidAt: r.invalid_at ?? undefined,
        sourceMemCellIds: JSON.parse(r.source_ids) as string[],
      }];
    } catch { return []; }
  });
}

export function getTruthById(id: string): CompiledTruth | null {
  const row = getDb().prepare('SELECT * FROM compiled_truths WHERE id = ? AND invalid_at IS NULL')
    .get(id) as {
    id: string; domain: string; statement: string; confidence: number;
    valid_at: number; invalid_at: number | null; source_ids: string;
  } | undefined;
  if (!row) return null;
  try {
    return {
      id: row.id, domain: row.domain, statement: row.statement, confidence: row.confidence,
      validAt: row.valid_at, invalidAt: row.invalid_at ?? undefined,
      sourceMemCellIds: JSON.parse(row.source_ids) as string[],
    };
  } catch {
    return null;
  }
}

export function listTruths(limit = 50): readonly CompiledTruth[] {
  const rows = getDb().prepare('SELECT * FROM compiled_truths WHERE invalid_at IS NULL ORDER BY valid_at DESC LIMIT ?')
    .all(limit) as Array<{
    id: string; domain: string; statement: string; confidence: number;
    valid_at: number; invalid_at: number | null; source_ids: string;
  }>;

  return rows.flatMap(r => {
    try {
      return [{
        id: r.id, domain: r.domain, statement: r.statement, confidence: r.confidence,
        validAt: r.valid_at, invalidAt: r.invalid_at ?? undefined,
        sourceMemCellIds: JSON.parse(r.source_ids) as string[],
      }];
    } catch { return []; }
  });
}

export function listTimeline(limit = 50): readonly TimelineEntry[] {
  const rows = getDb().prepare('SELECT * FROM timeline ORDER BY first_seen DESC LIMIT ?')
    .all(limit) as Array<{
    id: string; event: string; source: string; first_seen: number;
    occurrences: number; related_ids: string;
  }>;

  return rows.flatMap(r => {
    try {
      return [{
        id: r.id, event: r.event, source: r.source, firstSeen: r.first_seen,
        occurrences: r.occurrences, relatedMemCellIds: JSON.parse(r.related_ids) as string[],
      }];
    } catch { return []; }
  });
}

// ============================================================
// Episodic Traces — V1.3.12（P0-2 Gemini 评审修复）
// M16 spec v1.0.2: verification_status 三态契约
// ============================================================

export const EPISODIC_VERIFICATION_STATUS = {
  VERIFIED: 'verified',
  UNVERIFIED: 'unverified',
  VERIFIED_BY_M16: 'verified_by_m16',
} as const;

export type EpisodicVerificationStatus =
  (typeof EPISODIC_VERIFICATION_STATUS)[keyof typeof EPISODIC_VERIFICATION_STATUS];

export const EPISODIC_VERIFICATION_STATUS_VALUES = Object.freeze(
  Object.values(EPISODIC_VERIFICATION_STATUS),
) as readonly EpisodicVerificationStatus[];

export type EpisodicVerificationSource =
  | 'insert'
  | 'flag_unverified'
  | 'unflag_verified'
  | 'sweeper';

export interface EpisodicTraceRow {
  readonly id: string;
  readonly sessionId?: string;
  readonly userId: string;
  readonly event: string;
  readonly context: string;
  readonly timestamp: number;
  readonly memCellId?: string;
  readonly verificationStatus: EpisodicVerificationStatus;
}

export interface EpisodicVerificationAuditRow {
  readonly id: string;
  readonly traceId: string;
  readonly fromStatus?: EpisodicVerificationStatus;
  readonly requestedStatus: EpisodicVerificationStatus;
  readonly appliedStatus: EpisodicVerificationStatus;
  readonly source: EpisodicVerificationSource;
  readonly reason: string;
  readonly occurredAt: number;
}

type EpisodicTraceDbRow = {
  id: string;
  session_id: string | null;
  user_id: string;
  event: string;
  context: string;
  timestamp: number;
  mem_cell_id: string | null;
  verification_status: EpisodicVerificationStatus;
};

function mapEpisodicTraceRow(row: EpisodicTraceDbRow): EpisodicTraceRow {
  return {
    id: row.id,
    sessionId: row.session_id ?? undefined,
    userId: row.user_id,
    event: row.event,
    context: row.context,
    timestamp: row.timestamp,
    memCellId: row.mem_cell_id ?? undefined,
    verificationStatus: row.verification_status,
  };
}

function resolveVerificationStatus(
  currentStatus: EpisodicVerificationStatus | undefined,
  requestedStatus: EpisodicVerificationStatus,
): { readonly appliedStatus: EpisodicVerificationStatus; readonly reason: string } {
  if (!currentStatus) {
    return { appliedStatus: requestedStatus, reason: 'new_trace' };
  }

  if (currentStatus === requestedStatus) {
    return { appliedStatus: currentStatus, reason: 'status_unchanged' };
  }

  if (
    requestedStatus === EPISODIC_VERIFICATION_STATUS.UNVERIFIED
    && (currentStatus === EPISODIC_VERIFICATION_STATUS.VERIFIED
      || currentStatus === EPISODIC_VERIFICATION_STATUS.VERIFIED_BY_M16)
  ) {
    return { appliedStatus: currentStatus, reason: 'rollback_to_unverified_blocked' };
  }

  if (
    currentStatus === EPISODIC_VERIFICATION_STATUS.VERIFIED_BY_M16
    && requestedStatus === EPISODIC_VERIFICATION_STATUS.VERIFIED
  ) {
    return { appliedStatus: currentStatus, reason: 'keep_verified_by_m16' };
  }

  return { appliedStatus: requestedStatus, reason: 'status_transition_applied' };
}

function appendEpisodicVerificationAudit(record: {
  readonly traceId: string;
  readonly fromStatus?: EpisodicVerificationStatus;
  readonly requestedStatus: EpisodicVerificationStatus;
  readonly appliedStatus: EpisodicVerificationStatus;
  readonly source: EpisodicVerificationSource;
  readonly reason: string;
  readonly occurredAt: number;
}): void {
  getDb().prepare(
    `INSERT INTO episodic_verification_audit
     (id, trace_id, from_status, requested_status, applied_status, source, reason, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    crypto.randomUUID(),
    record.traceId,
    record.fromStatus ?? null,
    record.requestedStatus,
    record.appliedStatus,
    record.source,
    record.reason,
    record.occurredAt,
  );
}

function transitionEpisodicVerificationStatus(input: {
  readonly traceId: string;
  readonly requestedStatus: EpisodicVerificationStatus;
  readonly source: EpisodicVerificationSource;
  readonly onlyFrom?: EpisodicVerificationStatus;
}): boolean {
  const database = getDb();
  const existing = database.prepare(
    `SELECT verification_status FROM episodic_traces WHERE id = ?`,
  ).get(input.traceId) as { verification_status: EpisodicVerificationStatus } | undefined;

  if (!existing) return false;

  let nextReason = 'status_transition_applied';
  let nextStatus = existing.verification_status;

  if (input.onlyFrom && existing.verification_status !== input.onlyFrom) {
    nextReason = 'source_state_mismatch';
  } else {
    const transition = resolveVerificationStatus(existing.verification_status, input.requestedStatus);
    nextStatus = transition.appliedStatus;
    nextReason = transition.reason;
  }

  if (nextStatus !== existing.verification_status) {
    database.prepare(
      `UPDATE episodic_traces SET verification_status = ? WHERE id = ?`,
    ).run(nextStatus, input.traceId);
  }

  appendEpisodicVerificationAudit({
    traceId: input.traceId,
    fromStatus: existing.verification_status,
    requestedStatus: input.requestedStatus,
    appliedStatus: nextStatus,
    source: input.source,
    reason: nextReason,
    occurredAt: Date.now(),
  });

  return true;
}

/**
 * 插入 episodic trace（V1.3.12）。
 * M16 在线时默认 'verified'；M16 offline 时调用方需传 'unverified'。
 */
export function insertEpisodicTrace(trace: {
  readonly id: string;
  readonly sessionId?: string;
  readonly userId?: string;
  readonly event: string;
  readonly context?: string;
  readonly timestamp: number;
  readonly memCellId?: string;
  readonly verificationStatus?: EpisodicVerificationStatus;
  readonly source?: EpisodicVerificationSource;
}): void {
  const database = getDb();
  const runInsert = database.transaction(() => {
    const requestedStatus = trace.verificationStatus ?? EPISODIC_VERIFICATION_STATUS.VERIFIED;
    const existing = database.prepare(
      `SELECT verification_status FROM episodic_traces WHERE id = ?`,
    ).get(trace.id) as { verification_status: EpisodicVerificationStatus } | undefined;
    const transition = resolveVerificationStatus(existing?.verification_status, requestedStatus);
    const occurredAt = Date.now();

    database.prepare(
      `INSERT INTO episodic_traces
       (id, session_id, user_id, event, context, timestamp, mem_cell_id, verification_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         session_id = excluded.session_id,
         user_id = excluded.user_id,
         event = excluded.event,
         context = excluded.context,
         timestamp = excluded.timestamp,
         mem_cell_id = excluded.mem_cell_id,
         verification_status = CASE
           WHEN excluded.verification_status = 'unverified'
             AND episodic_traces.verification_status IN ('verified', 'verified_by_m16')
             THEN episodic_traces.verification_status
           WHEN episodic_traces.verification_status = 'verified_by_m16'
             AND excluded.verification_status = 'verified'
             THEN episodic_traces.verification_status
           ELSE excluded.verification_status
         END`,
    ).run(
      trace.id,
      trace.sessionId ?? null,
      trace.userId ?? 'default',
      trace.event,
      trace.context ?? '',
      trace.timestamp,
      trace.memCellId ?? null,
      transition.appliedStatus,
    );

    appendEpisodicVerificationAudit({
      traceId: trace.id,
      fromStatus: existing?.verification_status,
      requestedStatus,
      appliedStatus: transition.appliedStatus,
      source: trace.source ?? 'insert',
      reason: transition.reason,
      occurredAt,
    });
  });

  // BEGIN IMMEDIATE 确保 read-compute-write 原子，避免并发写入导致的 TOCTOU 回滚。
  runInsert.immediate();
}

/**
 * 查单条 episodic trace，不存在返回 null。
 */
export function getEpisodicTrace(traceId: string): EpisodicTraceRow | null {
  const row = getDb().prepare('SELECT * FROM episodic_traces WHERE id = ?').get(traceId) as EpisodicTraceDbRow | undefined;
  if (!row) return null;
  return mapEpisodicTraceRow(row);
}

/**
 * 把 trace 标为 unverified（M16 offline 场景应急 hook）。
 * 返回 true 表示更新成功，false 表示 trace 不存在。
 */
export function flagEpisodicUnverified(traceId: string): boolean {
  return transitionEpisodicVerificationStatus({
    traceId,
    requestedStatus: EPISODIC_VERIFICATION_STATUS.UNVERIFIED,
    source: 'flag_unverified',
  });
}

/**
 * 把 trace 从 unverified 标回 verified_by_m16（M16 恢复后补验通过）。
 * 返回 true 表示更新成功。
 */
export function unflagEpisodicVerified(
  traceId: string,
  source: EpisodicVerificationSource = 'unflag_verified',
): boolean {
  return transitionEpisodicVerificationStatus({
    traceId,
    requestedStatus: EPISODIC_VERIFICATION_STATUS.VERIFIED_BY_M16,
    source,
    onlyFrom: EPISODIC_VERIFICATION_STATUS.UNVERIFIED,
  });
}

/**
 * 列出所有 unverified 的 traces（M16 恢复后批量补验用）。
 */
export function listUnverifiedEpisodics(limit = 100): readonly EpisodicTraceRow[] {
  const rows = getDb().prepare(
    `SELECT * FROM episodic_traces WHERE verification_status = ? ORDER BY timestamp ASC LIMIT ?`,
  ).all(EPISODIC_VERIFICATION_STATUS.UNVERIFIED, limit) as EpisodicTraceDbRow[];
  return rows.map(mapEpisodicTraceRow);
}

export function listUnverifiedEpisodicsBefore(
  beforeTimestamp: number,
  limit = 100,
): readonly EpisodicTraceRow[] {
  const rows = getDb().prepare(
    `SELECT * FROM episodic_traces
     WHERE verification_status = ? AND timestamp <= ?
     ORDER BY timestamp ASC
     LIMIT ?`,
  ).all(EPISODIC_VERIFICATION_STATUS.UNVERIFIED, beforeTimestamp, limit) as EpisodicTraceDbRow[];
  return rows.map(mapEpisodicTraceRow);
}

export function listEpisodicVerificationAudit(traceId: string): readonly EpisodicVerificationAuditRow[] {
  const rows = getDb().prepare(
    `SELECT * FROM episodic_verification_audit WHERE trace_id = ? ORDER BY occurred_at ASC`,
  ).all(traceId) as Array<{
    id: string;
    trace_id: string;
    from_status: EpisodicVerificationStatus | null;
    requested_status: EpisodicVerificationStatus;
    applied_status: EpisodicVerificationStatus;
    source: EpisodicVerificationSource;
    reason: string;
    occurred_at: number;
  }>;

  return rows.map(row => ({
    id: row.id,
    traceId: row.trace_id,
    fromStatus: row.from_status ?? undefined,
    requestedStatus: row.requested_status,
    appliedStatus: row.applied_status,
    source: row.source,
    reason: row.reason,
    occurredAt: row.occurred_at,
  }));
}

export function promoteMemCell(cell: MemCell): { truthsCreated: number; timelineAdded: number } {
  let truthsCreated = 0;
  let timelineAdded = 0;

  for (const fact of cell.atomicFacts) {
    const existing = getDb().prepare(
      'SELECT id, confidence FROM compiled_truths WHERE domain = ? AND statement = ? AND invalid_at IS NULL'
    ).get(fact.domain, fact.statement) as { id: string; confidence: number } | undefined;

    if (existing) {
      if (fact.confidence > existing.confidence) {
        getDb().prepare('UPDATE compiled_truths SET confidence = ?, source_ids = json_insert(source_ids, "$[#]", ?) WHERE id = ?')
          .run(fact.confidence, cell.id, existing.id);
      }
    } else {
      const truthId = crypto.randomUUID();
      insertCompiledTruth({
        id: truthId,
        domain: fact.domain,
        statement: fact.statement,
        confidence: fact.confidence,
        validAt: cell.createdAt,
        sourceMemCellIds: [cell.id],
      });
      // 异步索引到 Sidecar 向量库，失败不阻塞 truth 入库
      reindexTruthAsync(truthId, `${fact.domain} ${fact.statement}`);
      truthsCreated++;
    }
  }

  for (const trace of cell.episodicTraces) {
    const entryId = contentHash(trace.event);
    appendTimeline({
      id: entryId,
      event: trace.event,
      source: 'auto-extract',
      firstSeen: trace.timestamp,
      occurrences: 1,
      relatedMemCellIds: [cell.id],
    });
    timelineAdded++;
  }

  return { truthsCreated, timelineAdded };
}

export function shouldPromote(event: string, occurrences: number, firstSeen: number, hasContradiction: boolean): boolean {
  const age = Date.now() - firstSeen;
  const decayWeight = Math.exp(-age / HALF_LIFE_MS);
  return occurrences >= 3 && !hasContradiction && decayWeight > 0.3;
}

export function countMemCells(): number {
  const row = getDb().prepare('SELECT COUNT(*) as count FROM mem_cells').get() as { count: number };
  return row.count;
}

export function insertTaskRecord(task: TaskRecord): void {
  getDb().prepare(
    'INSERT OR REPLACE INTO task_log (id, domain, data, completed_at) VALUES (?, ?, ?, ?)'
  ).run(task.id, task.domain, JSON.stringify(task), task.completedAt);
}

export function recentTasks(limit = 20): readonly TaskRecord[] {
  const rows = getDb().prepare('SELECT data FROM task_log ORDER BY completed_at DESC LIMIT ?')
    .all(limit) as Array<{ data: string }>;
  return rows.flatMap(r => { try { return [JSON.parse(r.data) as TaskRecord]; } catch { return []; } });
}

type DegradationMetricsWithUnknownThinking = Readonly<
  Omit<DegradationMetrics, 'thinkingRatio'> & {
    thinkingRatio: number | null;
  }
>;

type TaskRecordExtended = TaskRecord & {
  readonly extended?: {
    readonly thinkingRatio?: number;
    readonly thinkingTokens?: number;
    readonly totalTokens?: number;
  };
};

function hasExtendedField(task: TaskRecord): task is TaskRecordExtended {
  return Object.prototype.hasOwnProperty.call(task, 'extended');
}

function extractThinkingRatio(task: TaskRecordExtended): number | null {
  if (!task.extended) return null;

  const direct = task.extended.thinkingRatio;
  if (typeof direct === 'number' && Number.isFinite(direct)) {
    return direct;
  }

  const thinkingTokens = task.extended.thinkingTokens;
  const totalTokens = task.extended.totalTokens;
  if (
    typeof thinkingTokens === 'number'
    && Number.isFinite(thinkingTokens)
    && typeof totalTokens === 'number'
    && Number.isFinite(totalTokens)
    && totalTokens > 0
  ) {
    return thinkingTokens / totalTokens;
  }

  return null;
}

function acceptedOnFirstDraft(task: TaskRecord): boolean {
  return task.success === true && task.retryCount === 0;
}

// ============================================================
// templateSimilarity — 真实计算（替代 TODO 硬编码 0.3）
// 对比最近 N 条 assistant 回答的 TF-IDF 余弦相似度平均值
// ============================================================

function tokenizeForSimilarity(text: string): ReadonlyMap<string, number> {
  const freq = new Map<string, number>();
  const tokens = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(t => t.length > 1);
  for (const t of tokens) {
    freq.set(t, (freq.get(t) ?? 0) + 1);
  }
  return freq;
}

function cosineSimilarity(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  const allKeys = new Set([...a.keys(), ...b.keys()]);
  for (const k of allKeys) {
    const va = a.get(k) ?? 0;
    const vb = b.get(k) ?? 0;
    dot += va * vb;
    magA += va * va;
    magB += vb * vb;
  }
  const mag = Math.sqrt(magA) * Math.sqrt(magB);
  return mag > 0 ? dot / mag : 0;
}

function computeTemplateSimilarity(): number {
  try {
    const rows = getDb().prepare(
      "SELECT content FROM messages WHERE role = 'assistant' ORDER BY timestamp DESC LIMIT 5"
    ).all() as Array<{ content: string }>;

    if (rows.length < 2) return 0.3; // 数据不足时保守默认

    const vectors = rows.map(r => tokenizeForSimilarity(r.content));
    let totalSim = 0;
    let pairs = 0;
    for (let i = 0; i < vectors.length; i++) {
      for (let j = i + 1; j < vectors.length; j++) {
        totalSim += cosineSimilarity(vectors[i], vectors[j]);
        pairs++;
      }
    }
    return pairs > 0 ? totalSim / pairs : 0.3;
  } catch {
    return 0.3;
  }
}

// ============================================================
// toolSkipRate — 真实计算（替代 TODO 硬编码 0.1）
// 需要工具但未使用就成功的比例
// ============================================================

/**
 * toolSkipRate — 需要工具但未调用就成功的比例。
 *
 * ⚠️ 当前限制（P2 B13-pre Codex 审查确认）：
 * chat 场景下 fireRecordTask 将 toolCallsRequired 硬编码为 0，
 * 导致此函数在 Agent Loop 上线前始终返回默认值 0.1。
 * Agent Loop（P2 B15）实现后将传入真实 toolCallsRequired。
 */
function computeToolSkipRate(): number {
  try {
    const rows = getDb().prepare('SELECT data FROM task_log ORDER BY completed_at DESC LIMIT 20')
      .all() as Array<{ data: string }>;

    const tasks = rows.flatMap((r): TaskRecord[] => {
      try { return [JSON.parse(r.data) as TaskRecord]; } catch { return []; }
    });

    if (tasks.length === 0) return 0.1;

    const needsTool = tasks.filter(t => t.toolCallsRequired > 0);
    if (needsTool.length === 0) return 0.1; // chat 场景下始终走这里

    const skipped = needsTool.filter(t => t.success && t.retryCount === 0);
    return skipped.length / needsTool.length;
  } catch {
    return 0.1;
  }
}

export function getLatestDegradationMetrics(): DegradationMetricsWithUnknownThinking | null {
  const rows = getDb().prepare('SELECT data FROM task_log ORDER BY completed_at DESC LIMIT 5')
    .all() as Array<{ data: string }>;

  const tasks = rows.flatMap((row): TaskRecord[] => {
    try {
      return [JSON.parse(row.data) as TaskRecord];
    } catch {
      return [];
    }
  });

  if (tasks.length === 0) {
    return null;
  }

  const tasksWithExtended = tasks.filter(hasExtendedField);
  const thinkingSamples = tasksWithExtended
    .map(extractThinkingRatio)
    .filter((ratio): ratio is number => typeof ratio === 'number' && Number.isFinite(ratio));

  const thinkingRatio = tasksWithExtended.length === 0 || thinkingSamples.length === 0
    ? null
    : thinkingSamples.reduce((sum, ratio) => sum + ratio, 0) / thinkingSamples.length;

  const latest = tasks[0];
  const firstDraftAccepted = acceptedOnFirstDraft(latest);
  const verificationSkipped = firstDraftAccepted;

  return {
    thinkingRatio,
    templateSimilarity: computeTemplateSimilarity(),
    toolSkipRate: computeToolSkipRate(),
    verificationSkipped,
    firstDraftAccepted,
    taskComplexity: 0,
  };
}

// ============================================================
// Sessions & Messages
// ============================================================

export function createSession(id: string, name: string): Session {
  const now = Date.now();
  getDb().prepare(
    'INSERT OR IGNORE INTO sessions (id, name, created_at, last_accessed_at) VALUES (?, ?, ?, ?)'
  ).run(id, name, now, now);
  // 如果已存在（并发竞态），返回现有 session
  return getSession(id) ?? { id, name, createdAt: now, lastAccessedAt: now };
}

export function getSession(id: string): Session | null {
  const row = getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(id) as {
    id: string; name: string; created_at: number; last_accessed_at: number; closed_at: number | null;
  } | undefined;
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    lastAccessedAt: row.last_accessed_at,
    closedAt: row.closed_at ?? undefined,
  };
}

export function listSessions(limit = 50): readonly Session[] {
  const rows = getDb().prepare(
    'SELECT * FROM sessions WHERE closed_at IS NULL ORDER BY last_accessed_at DESC LIMIT ?'
  ).all(limit) as Array<{
    id: string; name: string; created_at: number; last_accessed_at: number; closed_at: number | null;
  }>;
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    lastAccessedAt: r.last_accessed_at,
    closedAt: r.closed_at ?? undefined,
  }));
}

export function updateSessionAccess(id: string): void {
  getDb().prepare('UPDATE sessions SET last_accessed_at = ? WHERE id = ?').run(Date.now(), id);
}

export function insertMessage(msg: { id: string; sessionId: string; role: string; content: string; timestamp: number }): void {
  getDb().prepare(
    'INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)'
  ).run(msg.id, msg.sessionId, msg.role, msg.content, msg.timestamp);
}

export function getSessionMessages(sessionId: string, limit = 100): readonly ChatMessage[] {
  // 取最新 N 条再按时间正序，确保长会话不丢最新上下文
  const rows = getDb().prepare(
    'SELECT * FROM (SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp DESC LIMIT ?) ORDER BY timestamp ASC'
  ).all(sessionId, limit) as Array<{
    id: string; session_id: string; role: string; content: string; timestamp: number;
  }>;
  return rows.map(r => ({
    id: r.id,
    sessionId: r.session_id,
    role: r.role as 'user' | 'assistant' | 'system',
    content: r.content,
    timestamp: r.timestamp,
  }));
}

export function renameSession(id: string, name: string): void {
  getDb().prepare('UPDATE sessions SET name = ?, last_accessed_at = ? WHERE id = ?').run(name, Date.now(), id);
}

export function deleteSession(id: string): void {
  const d = getDb();
  const deleteTransaction = d.transaction(() => {
    d.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
    d.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  });
  deleteTransaction();
}

export function deleteTruth(id: string): void {
  getDb().prepare('DELETE FROM compiled_truths WHERE id = ?').run(id);
}

export function updateTruth(id: string, fields: { statement?: string; domain?: string; confidence?: number }): CompiledTruth | null {
  const d = getDb();
  const existing = d.prepare('SELECT * FROM compiled_truths WHERE id = ?').get(id) as {
    id: string; domain: string; statement: string; confidence: number;
    valid_at: number; invalid_at: number | null; source_ids: string;
  } | undefined;
  if (!existing) return null;

  const newDomain = fields.domain ?? existing.domain;
  const newStatement = fields.statement ?? existing.statement;
  const newConfidence = fields.confidence ?? existing.confidence;

  d.prepare('UPDATE compiled_truths SET domain = ?, statement = ?, confidence = ? WHERE id = ?')
    .run(newDomain, newStatement, newConfidence, id);

  // 向量索引同步（异步 fire-and-forget，Sidecar 离线时静默跳过）
  if (fields.statement || fields.domain) {
    reindexTruthAsync(id, `${newDomain} ${newStatement}`);
  }

  return {
    id: existing.id,
    domain: newDomain,
    statement: newStatement,
    confidence: newConfidence,
    validAt: existing.valid_at,
    invalidAt: existing.invalid_at ?? undefined,
    sourceMemCellIds: JSON.parse(existing.source_ids) as string[],
  };
}

// ============================================================
// Query Log + Domain Boosts（experience-stream 等价）
// ============================================================

export function logQueryExperience(
  queryHash: string,
  domainsHit: readonly string[],
  retrievalPaths: readonly string[],
  itemCount: number,
): void {
  try {
    getDb().prepare(
      'INSERT INTO query_log (id, query_hash, domains_hit, retrieval_paths, item_count, timestamp) VALUES (?,?,?,?,?,?)'
    ).run(crypto.randomUUID(), queryHash, JSON.stringify(domainsHit), JSON.stringify(retrievalPaths), itemCount, Date.now());

    // 清理 30 天前的旧记录
    const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
    getDb().prepare('DELETE FROM query_log WHERE timestamp < ?').run(cutoff);
  } catch { /* 静默 */ }
}

export function getDomainBoosts(): ReadonlyMap<string, number> {
  const boosts = new Map<string, number>();
  try {
    const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
    const rows = getDb().prepare(
      'SELECT domains_hit FROM query_log WHERE timestamp > ?'
    ).all(weekAgo) as Array<{ domains_hit: string }>;

    const counts = new Map<string, number>();
    let total = 0;
    for (const row of rows) {
      try {
        const domains = JSON.parse(row.domains_hit) as string[];
        for (const d of domains) {
          counts.set(d, (counts.get(d) ?? 0) + 1);
          total++;
        }
      } catch { /* skip */ }
    }

    if (total > 0) {
      for (const [domain, count] of counts) {
        // 乘法系数而非加法，避免 boost 主导 RRF 排名
        // boost=0.001*log(1+count)，domain 命中 10 次 → 0.0024，与 RRF ~0.05 量级匹配
        boosts.set(domain, Math.log(1 + count) * 0.001);
      }
    }
  } catch { /* 静默 */ }
  return boosts;
}

// ============================================================
// 最近 assistant 回答（templateSimilarity 用）
// ============================================================

export function getRecentAssistantMessages(limit = 5): readonly string[] {
  try {
    const rows = getDb().prepare(
      "SELECT content FROM messages WHERE role = 'assistant' ORDER BY timestamp DESC LIMIT ?"
    ).all(limit) as Array<{ content: string }>;
    return rows.map(r => r.content);
  } catch {
    return [];
  }
}

// ============================================================
// 按时间衰减获取 truths（Path 3 用）
// ============================================================

const HALF_LIFE_MS_RECALL = 30 * 24 * 3600 * 1000;

export function listTruthsByRecency(limit = 20): readonly (CompiledTruth & { decayScore: number })[] {
  const rows = getDb().prepare(
    'SELECT * FROM compiled_truths WHERE invalid_at IS NULL ORDER BY valid_at DESC LIMIT ?'
  ).all(limit) as Array<{
    id: string; domain: string; statement: string; confidence: number;
    valid_at: number; invalid_at: number | null; source_ids: string;
  }>;

  const now = Date.now();
  return rows.flatMap(r => {
    try {
      const age = now - r.valid_at;
      const decayScore = Math.exp(-age / HALF_LIFE_MS_RECALL);
      return [{
        id: r.id, domain: r.domain, statement: r.statement, confidence: r.confidence,
        validAt: r.valid_at, invalidAt: r.invalid_at ?? undefined,
        sourceMemCellIds: JSON.parse(r.source_ids) as string[],
        decayScore,
      }];
    } catch { return []; }
  });
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
