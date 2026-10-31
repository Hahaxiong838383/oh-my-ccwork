import { readArkIdentity, installArkIdentityEpoch } from './ark/identity.js';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * 设备接入台账 + Session 签发流水（运营台「设备接入」tab 的数据层）。
 *
 * 独立库 devices.db（与 accounts.db / feedback.db 物理隔离）。
 * 白名单语义（与 device-session.ts 约定）：
 *   - DB 有记录 → 以 DB status 为准（active 放行 / disabled 拒绝），可压制 env 存量；
 *   - DB 无记录 → 回落 env DEVICE_SN_ALLOW（存量真机的兜底路径，保证 DB 逻辑异常时真机不断线）。
 * 流水纪律：只记凭据验证通过后的事件（sn 可信、无公网扫描噪音）；token 原文绝不入库。
 */

export type DeviceStatus = 'active' | 'disabled';

export type DeviceRecord = {
  sn: string;
  note: string;
  status: DeviceStatus;
  account_id: string | null; // brain 账号关联（Worker Brain tab）
  parent_account_id: string | null; // 家长账号关联（小程序绑定/admin 手工；建档下发链的取数源）
  public_id: string | null; // 对外不透 SN 的稳定 id（dev_<16hex>，telemetry 合同 §9：H5 路由/前端日志零 SN）
  worldview_override: string; // per-device 世界观人设（空 = 默认 ARK_WORLDVIEW_BASE）
  prompt_addendum: string; // per-device 附加规则（空 = 关闭；拼接在 systemPrompt 最末）
  credential_issued_at: number | null;
  credential_expires_at: number | null;
  created_at: number;
  updated_at: number;
};

export type DeviceWithActivity = DeviceRecord & {
  last_active_at: number | null;
  session_count: number;
};

export type SessionLogStatus = 'ok' | 'rejected_403' | 'rejected_429' | 'prefetch';

export type SessionLogEntry = {
  sn: string;
  room: string;
  session_id: string;
  trace_id: string;
  status: SessionLogStatus;
  ttl_s: number;
  ms: number;
};

export type SessionLogRow = SessionLogEntry & { id: number; created_at: number; note: string };

const DEFAULT_DB_PATH = './data/devices.db';

function resolveDbPath(): string {
  const raw = process.env.DEVICES_DB_PATH?.trim() || DEFAULT_DB_PATH;
  return resolve(process.cwd(), raw);
}

class DeviceRegistryStore {
  private readonly db: DatabaseSync;
  private arkEpochReady = false;

  arkIdentity(sn: string) { return this.arkEpochReady ? readArkIdentity(this.db, sn) : null; }

  constructor() {
    const dbPath = resolveDbPath();
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS device_registry (
        sn TEXT PRIMARY KEY,
        note TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        account_id TEXT,
        parent_account_id TEXT,
        worldview_override TEXT NOT NULL DEFAULT '',
        prompt_addendum TEXT NOT NULL DEFAULT '',
        credential_issued_at INTEGER,
        credential_expires_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_registry_account ON device_registry (account_id);
      CREATE TABLE IF NOT EXISTS device_session_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sn TEXT NOT NULL,
        room TEXT NOT NULL DEFAULT '',
        session_id TEXT NOT NULL DEFAULT '',
        trace_id TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        ttl_s INTEGER NOT NULL DEFAULT 0,
        ms INTEGER NOT NULL DEFAULT 0,
        note TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_session_log_sn_time
      ON device_session_log (sn, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_session_log_time
      ON device_session_log (created_at DESC);
      CREATE TABLE IF NOT EXISTS device_credential_revocation (
        sn TEXT PRIMARY KEY,
        not_before_sec INTEGER NOT NULL,
        revoked_by TEXT NOT NULL DEFAULT '',
        reason TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.migrate();
    try { installArkIdentityEpoch(this.db); this.arkEpochReady = true; } catch { console.error('[ark] identity_epoch_unavailable'); }
  }

  /**
   * 作废该 SN 在此刻之前签发的全部设备凭据（2026-09-16 川哥：后台删除设备 = 变回新设备，必须重新签发/认领）。
   * 只记秒级水位 = 删除发生的那一秒：verifyDeviceCredential 拿 JWT iat 对撞，iat ≤ 水位即拒（iat 只有秒精度，
   * 删除当秒签的一律算旧）；无 iat 的老 token 视为 0 → 一并作废。水位单调不回退；台账行删了也不影响
   * （独立表，重加设备不清）。返回生效的秒级水位。
   * 恢复换钥（2026-09-17）：调用方可显式给水位 = 新凭据 iat − 1，让刚签的这份（iat）恰好通过、更早的全部作废。
   */
  revokeCredentials(sn: string, by: string, reason: string, notBeforeSec?: number): number {
    const nowMs = Date.now();
    const nowSec = typeof notBeforeSec === 'number' && Number.isFinite(notBeforeSec) ? Math.floor(notBeforeSec) : Math.floor(nowMs / 1000);
    this.db
      .prepare(
        `INSERT INTO device_credential_revocation (sn, not_before_sec, revoked_by, reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(sn) DO UPDATE SET
           not_before_sec = MAX(not_before_sec, excluded.not_before_sec),
           revoked_by = excluded.revoked_by, reason = excluded.reason, updated_at = excluded.updated_at`,
      )
      .run(sn, nowSec, by, reason, nowMs, nowMs);
    return this.credentialNotBeforeSec(sn) ?? nowSec;
  }

  /** 该 SN 的凭据「不早于」秒级水位；从未作废过 → null。 */
  credentialNotBeforeSec(sn: string): number | null {
    const row = this.db
      .prepare(`SELECT not_before_sec FROM device_credential_revocation WHERE sn = ?`)
      .get(sn) as { not_before_sec: number } | undefined;
    return row ? Number(row.not_before_sec) : null;
  }

  /** 老库迁移：幂等补列（生产 devices.db 建于各列之前）。失败记日志不阻断启动。 */
  private migrate(): void {
    try {
      const logCols = this.db.prepare('PRAGMA table_info(device_session_log)').all() as { name: string }[];
      if (!logCols.some((c) => c.name === 'note')) {
        this.db.exec(`ALTER TABLE device_session_log ADD COLUMN note TEXT NOT NULL DEFAULT ''`);
      }
      const regCols = this.db.prepare('PRAGMA table_info(device_registry)').all() as { name: string }[];
      const hasReg = (n: string) => regCols.some((c) => c.name === n);
      if (!hasReg('worldview_override')) {
        this.db.exec(`ALTER TABLE device_registry ADD COLUMN worldview_override TEXT NOT NULL DEFAULT ''`);
      }
      if (!hasReg('prompt_addendum')) {
        this.db.exec(`ALTER TABLE device_registry ADD COLUMN prompt_addendum TEXT NOT NULL DEFAULT ''`);
      }
      if (!hasReg('parent_account_id')) {
        this.db.exec(`ALTER TABLE device_registry ADD COLUMN parent_account_id TEXT`);
      }
      if (!hasReg('public_id')) {
        this.db.exec(`ALTER TABLE device_registry ADD COLUMN public_id TEXT`);
        this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_registry_public_id ON device_registry (public_id) WHERE public_id IS NOT NULL`);
      }
      // 存量回填：无 public_id 的行统一生成（新增设备在 add() 时生成）
      const missing = this.db.prepare(`SELECT sn FROM device_registry WHERE public_id IS NULL`).all() as { sn: string }[];
      for (const row of missing) {
        this.db
          .prepare(`UPDATE device_registry SET public_id = ? WHERE sn = ?`)
          .run(`dev_${randomBytes(8).toString('hex')}`, row.sn);
      }
    } catch (err) {
      console.error(`[device-registry] 列迁移失败(不阻断): ${(err as Error).message}`);
    }
  }

  /** 按对外 public_id 反查（parent telemetry API 用；H5 不见 SN）。 */
  getByPublicId(publicId: string): DeviceRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM device_registry WHERE public_id = ?`)
      .get(publicId) as DeviceRecord | undefined;
    return row ?? null;
  }

  // ── 台账 ──

  get(sn: string): DeviceRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM device_registry WHERE sn = ?`)
      .get(sn) as DeviceRecord | undefined;
    return row ?? null;
  }

  /**
   * 热路径查询（device-session.ts 每请求调）：DB 有记录返回其 status，无记录返回 null（→回落 env）。
   */
  statusOf(sn: string): DeviceStatus | null {
    const row = this.db
      .prepare(`SELECT status FROM device_registry WHERE sn = ?`)
      .get(sn) as { status: DeviceStatus } | undefined;
    return row?.status ?? null;
  }

  add(sn: string, note: string): DeviceRecord {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO device_registry (sn, note, status, public_id, created_at, updated_at)
         VALUES (?, ?, 'active', ?, ?, ?)`,
      )
      .run(sn, note, `dev_${randomBytes(8).toString('hex')}`, now, now);
    return this.get(sn)!;
  }

  setStatus(sn: string, status: DeviceStatus): boolean {
    const r = this.db
      .prepare(`UPDATE device_registry SET status = ?, updated_at = ? WHERE sn = ?`)
      .run(status, Date.now(), sn);
    return Number(r.changes) > 0;
  }

  setNote(sn: string, note: string): boolean {
    const r = this.db
      .prepare(`UPDATE device_registry SET note = ?, updated_at = ? WHERE sn = ?`)
      .run(note, Date.now(), sn);
    return Number(r.changes) > 0;
  }

  /** 删除台账记录（流水保留）。删除后该 SN 回落 env 语义。 */
  remove(sn: string): boolean {
    const r = this.db.prepare(`DELETE FROM device_registry WHERE sn = ?`).run(sn);
    return Number(r.changes) > 0;
  }

  /** brain 账号 → 设备反查（custom-llm 热路径用，有 idx_registry_account 索引）。 */
  findByAccountId(accountId: string): DeviceRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM device_registry WHERE account_id = ? LIMIT 1`)
      .get(accountId) as DeviceRecord | undefined;
    return row ?? null;
  }

  /** per-device prompt 配置（Worker Brain 编辑 tab）。 */
  setPromptConfig(sn: string, cfg: { worldview_override?: string; prompt_addendum?: string }): boolean {
    const cur = this.get(sn);
    if (!cur) return false;
    const r = this.db
      .prepare(
        `UPDATE device_registry SET worldview_override = ?, prompt_addendum = ?, updated_at = ? WHERE sn = ?`,
      )
      .run(
        cfg.worldview_override !== undefined ? cfg.worldview_override : cur.worldview_override,
        cfg.prompt_addendum !== undefined ? cfg.prompt_addendum : cur.prompt_addendum,
        Date.now(),
        sn,
      );
    return Number(r.changes) > 0;
  }

  /** 设备 ↔ brain 账号关联（worker brain tab）。accountId=null 即解绑。 */
  setAccountId(sn: string, accountId: string | null): boolean {
    const r = this.db
      .prepare(`UPDATE device_registry SET account_id = ?, updated_at = ? WHERE sn = ?`)
      .run(accountId, Date.now(), sn);
    return Number(r.changes) > 0;
  }

  /** 设备 ↔ 家长账号关联（小程序绑定/admin 手工）。accountId=null 即解绑。 */
  setParentAccountId(sn: string, accountId: string | null): boolean {
    const r = this.db
      .prepare(`UPDATE device_registry SET parent_account_id = ?, updated_at = ? WHERE sn = ?`)
      .run(accountId, Date.now(), sn);
    return Number(r.changes) > 0;
  }

  /** 按家长账号反查其绑定的全部设备（小程序「我的设备」列表）。 */
  listByParentAccountId(parentAccountId: string): DeviceRecord[] {
    return this.db
      .prepare(`SELECT * FROM device_registry WHERE parent_account_id = ? ORDER BY created_at ASC`)
      .all(parentAccountId) as DeviceRecord[];
  }

  /** 记录一次凭据签发（仅时间元数据；token 原文绝不入库）。 */
  recordCredential(sn: string, issuedAt: number, expiresAt: number): boolean {
    const r = this.db
      .prepare(
        `UPDATE device_registry
         SET credential_issued_at = ?, credential_expires_at = ?, updated_at = ?
         WHERE sn = ?`,
      )
      .run(issuedAt, expiresAt, Date.now(), sn);
    return Number(r.changes) > 0;
  }

  /** 台账列表 + 每台的最近活跃/累计 session 数（流水聚合，含 env 兜底设备的活跃——按 sn 关联即可）。 */
  list(): DeviceWithActivity[] {
    return this.db
      .prepare(
        `SELECT d.*,
                (SELECT MAX(created_at) FROM device_session_log l WHERE l.sn = d.sn) AS last_active_at,
                (SELECT COUNT(*) FROM device_session_log l WHERE l.sn = d.sn AND l.status = 'ok') AS session_count
         FROM device_registry d
         ORDER BY d.created_at DESC`,
      )
      .all() as DeviceWithActivity[];
  }

  // ── 流水 ──

  logSession(entry: SessionLogEntry): void {
    this.db
      .prepare(
        `INSERT INTO device_session_log (sn, room, session_id, trace_id, status, ttl_s, ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(entry.sn, entry.room, entry.session_id, entry.trace_id, entry.status, entry.ttl_s, entry.ms, Date.now());
  }

  listSessions(sn: string | undefined, limit: number, offset = 0): SessionLogRow[] {
    if (sn) {
      return this.db
        .prepare(
          `SELECT * FROM device_session_log WHERE sn = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        )
        .all(sn, limit, offset) as SessionLogRow[];
    }
    return this.db
      .prepare(`SELECT * FROM device_session_log ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(limit, offset) as SessionLogRow[];
  }

  countSessions(sn: string | undefined): number {
    const row = (
      sn
        ? this.db.prepare(`SELECT COUNT(*) AS n FROM device_session_log WHERE sn = ?`).get(sn)
        : this.db.prepare(`SELECT COUNT(*) AS n FROM device_session_log`).get()
    ) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /** 流水行级备注（运营/测试标注「这轮是谁/哪次测试」）。 */
  setSessionNote(id: number, note: string): boolean {
    const r = this.db.prepare(`UPDATE device_session_log SET note = ? WHERE id = ?`).run(note, id);
    return Number(r.changes) > 0;
  }

  /** 时间窗内按状态分组的签发统计（全局隔离总览可靠性区）。 */
  statsSince(t0: number): { ok: number; rejected_403: number; rejected_429: number; prefetch: number; total: number } {
    const rows = this.db
      .prepare(`SELECT status, COUNT(*) AS n FROM device_session_log WHERE created_at >= ? GROUP BY status`)
      .all(t0) as Array<{ status: string; n: number }>;
    const out = { ok: 0, rejected_403: 0, rejected_429: 0, prefetch: 0, total: 0 };
    for (const r of rows) {
      const n = Number(r.n);
      out.total += n;
      if (r.status === 'ok') out.ok += n;
      else if (r.status === 'rejected_403') out.rejected_403 += n;
      else if (r.status === 'rejected_429') out.rejected_429 += n;
      else if (r.status === 'prefetch') out.prefetch += n;
    }
    return out;
  }

  /** 顶部状态卡：今日（本机时区零点起）ok / 拒绝计数。 */
  todayStats(): { today_ok: number; today_rejected: number } {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const t0 = midnight.getTime();
    const row = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok_n,
           SUM(CASE WHEN status LIKE 'rejected_%' THEN 1 ELSE 0 END) AS rej_n
         FROM device_session_log WHERE created_at >= ?`,
      )
      .get(t0) as { ok_n: number | null; rej_n: number | null } | undefined;
    return { today_ok: row?.ok_n ?? 0, today_rejected: row?.rej_n ?? 0 };
  }
}

export const deviceRegistryStore = new DeviceRegistryStore();
