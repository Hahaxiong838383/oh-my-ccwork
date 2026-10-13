import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

/**
 * 配网 bind_token 数据层（联调合同 v3 §3 + 三项口径确认回执 2026-08-22）。
 * 独立库 pairing.db（分库哲学）。红线：库中只存 token 的 sha256，绝不存明文。
 *
 * 生命周期：create（同家长旧未用作废）→ claim（markClaimed 落 claimed_at/claimed_sn）
 * → 幂等恢复窗 = claimed_at + 15min（回执 2.2 冻结：覆盖「响应丢失后重试」，
 *   超窗走「同家长新 token + 已绑同 SN」路径，无死局）。
 */

export const TOKEN_TTL_S = 600; // 10 分钟
export const IDEMPOTENT_WINDOW_MS = 15 * 60_000; // 幂等恢复窗 15 分钟

export type PairingTokenRow = {
  token_hash: string;
  token_id: string;
  account_id: string;
  created_at: number;
  expires_at: number;
  claimed_at: number | null;
  claimed_sn: string | null;
  brain_state: string | null; // 'ready' | 'initializing'（claim 后有值）
};

export type PairingSessionSource = 'parent' | 'preauth' | 'admin';

export type PairingSessionRow = {
  nonce_hash: string;
  session_id: string;
  sn: string;
  account_id: string;
  device_pk: string;
  confirmed_at: number;
  expires_at: number;
  claimed_at: number | null;
  brain_state: string | null;
  /** v3：会话来源——parent 家长扫码 / preauth 后台预授权代确认 / admin 后台一键确认（老行默认 parent） */
  source: PairingSessionSource;
  /** v3：代确认所用预授权的 created_at（真实 claim 成功时按它精确消费，幂等恢复/新预授权不误消费） */
  preauth_created_at: number | null;
  /** 恢复合同（2026-09-17）：本会话真实 claim 的绑定结局 new / existing_binding_recovery；幂等恢复原样回显；老行 null */
  binding_outcome: BindingOutcome | null;
};

/** 恢复合同：existing_binding_recovery = 同家长重绑且该 SN 此前签过凭据（设备曾持有凭据，本次是恢复）；其余 new */
export type BindingOutcome = 'new' | 'existing_binding_recovery';

/** v3（2026-09-06）：设备自报二维码三元组——只存 nonce hash + 已校验 pk，与 nonce 同寿命 */
export type PairingAnnounceRow = {
  sn: string;
  nonce_hash: string;
  device_pk: string;
  announced_at: number;
  expires_at: number;
};

/** v3：后台预授权（SN + 家长手机号 → 家长账号），一次性、限时；used_at 在真实 claim 成功时落 */
export type DevicePreauthRow = {
  sn: string;
  parent_account_id: string;
  phone: string;
  until_at: number;
  created_by: string;
  created_at: number;
  used_at: number | null;
};

const DEFAULT_DB_PATH = './data/pairing.db';

function resolveDbPath(): string {
  const raw = process.env.PAIRING_DB_PATH?.trim() || DEFAULT_DB_PATH;
  return resolve(process.cwd(), raw);
}

/** 设备凭据 TTL：与 routes/pairing.ts CREDENTIAL_TTL_MS 同值（pairing.test cred-2 用 claim 响应 credential_expires_at_ms 对撞守护，双载体必须相等）。 */
export const DEVICE_CREDENTIAL_TTL_MS = 365 * 86_400_000;

/** 由 claim 时刻推导凭据窗口：signDeviceCredential 先把签发时刻取整到秒再派生 exp，claimed_at 晚于签发仅数 ms，
 *  故按秒取整后与真实 exp 至多差 1 s。只用于台账展示，必须带 credential_source 标记，不进任何鉴权判定。 */
export function credentialWindowFromClaim(claimedAtMs: number): { issued_at: number; expires_at: number } {
  const issued = Math.floor(claimedAtMs / 1000) * 1000;
  return { issued_at: issued, expires_at: issued + DEVICE_CREDENTIAL_TTL_MS };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

class PairingStore {
  private readonly db: DatabaseSync;

  constructor() {
    const dbPath = resolveDbPath();
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pairing_token (
        token_hash TEXT PRIMARY KEY,
        token_id TEXT NOT NULL UNIQUE,
        account_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        claimed_at INTEGER,
        claimed_sn TEXT,
        brain_state TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pairing_account ON pairing_token (account_id);
      -- v2（nonce 桥，codex 开工 prompt 2026-08-22）：nonce 原文不落库只存 hash；pk 原文落库；
      -- 三元组 SN+nonce_hash+pk 在 confirm 时一次性固定；同一设备同时只允许一个有效会话。
      CREATE TABLE IF NOT EXISTS pairing_session (
        nonce_hash TEXT PRIMARY KEY,
        session_id TEXT NOT NULL UNIQUE,
        sn TEXT NOT NULL,
        account_id TEXT NOT NULL,
        device_pk TEXT NOT NULL,
        confirmed_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        claimed_at INTEGER,
        brain_state TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_session_sn ON pairing_session (sn);
      -- v3（后台预授权自动认领，合同 v1 2026-09-06）：设备自报三元组 + 后台预授权
      CREATE TABLE IF NOT EXISTS pairing_announce (
        sn TEXT PRIMARY KEY,
        nonce_hash TEXT NOT NULL,
        device_pk TEXT NOT NULL,
        announced_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS device_preauth (
        sn TEXT PRIMARY KEY,
        parent_account_id TEXT NOT NULL,
        phone TEXT NOT NULL DEFAULT '',
        until_at INTEGER NOT NULL,
        created_by TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        used_at INTEGER
      );
    `);
    // v3 会话来源列（老库幂等补列，失败记日志不阻断启动）
    try {
      const cols = this.db.prepare(`PRAGMA table_info(pairing_session)`).all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'source')) {
        this.db.exec(`ALTER TABLE pairing_session ADD COLUMN source TEXT NOT NULL DEFAULT 'parent'`);
      }
      if (!cols.some((c) => c.name === 'preauth_created_at')) {
        this.db.exec(`ALTER TABLE pairing_session ADD COLUMN preauth_created_at INTEGER`);
      }
      if (!cols.some((c) => c.name === 'binding_outcome')) {
        this.db.exec(`ALTER TABLE pairing_session ADD COLUMN binding_outcome TEXT`);
      }
    } catch (err) {
      console.error(`[pairing-store] v3 列迁移失败(不阻断): ${(err as Error).message}`);
    }
  }

  /** 签发新 token：同家长「未 claim」的旧 token 全部作废（删行）。返回明文 token（唯一一次出现）。 */
  create(accountId: string): { token: string; tokenId: string; expiresInS: number } {
    this.db.prepare(`DELETE FROM pairing_token WHERE account_id = ? AND claimed_at IS NULL`).run(accountId);
    const token = randomBytes(24).toString('base64url'); // 32 字符紧凑串（codex §6：控制二维码密度）
    const tokenId = randomBytes(9).toString('base64url');
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO pairing_token (token_hash, token_id, account_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(hashToken(token), tokenId, accountId, now, now + TOKEN_TTL_S * 1000);
    return { token, tokenId, expiresInS: TOKEN_TTL_S };
  }

  findByHash(tokenHash: string): PairingTokenRow | null {
    return (this.db.prepare(`SELECT * FROM pairing_token WHERE token_hash = ?`).get(tokenHash) as PairingTokenRow) ?? null;
  }

  findByTokenId(tokenId: string): PairingTokenRow | null {
    return (this.db.prepare(`SELECT * FROM pairing_token WHERE token_id = ?`).get(tokenId) as PairingTokenRow) ?? null;
  }

  markClaimed(tokenHash: string, sn: string, brainState: 'ready' | 'initializing'): void {
    this.db
      .prepare(`UPDATE pairing_token SET claimed_at = ?, claimed_sn = ?, brain_state = ? WHERE token_hash = ?`)
      .run(Date.now(), sn, brainState, tokenHash);
  }

  // ───────── v2：nonce 会话（SoftAP 两阶段 + ECIES）─────────

  /** 家长 confirm：固定三元组。同 SN 未 claim 的旧会话作废（一台设备一个有效会话）。 */
  confirmSession(accountId: string, sn: string, nonceString: string, devicePkB64: string): { sessionId: string } {
    return this.confirmSessionByHash(accountId, sn, hashToken(nonceString), devicePkB64, 'parent');
  }

  /**
   * 确认核心（v3，codex 开工回执 §2.2）：接收**规范化 nonce hash + 已校验公钥**。家长扫码 / 后台预授权代确认 /
   * 后台一键确认三个入口共用同一事务；晚到的预授权只有 announce 存下的 hash，不需要也不能要 nonce 原文。
   * claim 的 HKDF 盐仍用设备在 claim 时送来的 nonce 原文（不变）。
   */
  confirmSessionByHash(
    accountId: string,
    sn: string,
    nonceHash: string,
    devicePkB64: string,
    source: PairingSessionSource,
    preauthCreatedAt: number | null = null,
  ): { sessionId: string } {
    const sessionId = randomBytes(9).toString('base64url');
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`DELETE FROM pairing_session WHERE sn = ? AND claimed_at IS NULL`).run(sn);
      this.db
        .prepare(
          `INSERT INTO pairing_session (nonce_hash, session_id, sn, account_id, device_pk, confirmed_at, expires_at, source, preauth_created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(nonceHash, sessionId, sn, accountId, devicePkB64, now, now + TOKEN_TTL_S * 1000, source, preauthCreatedAt);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return { sessionId };
  }

  findSessionByHash(nonceHash: string): PairingSessionRow | null {
    return (this.db.prepare(`SELECT * FROM pairing_session WHERE nonce_hash = ?`).get(nonceHash) as PairingSessionRow) ?? null;
  }

  /** 同 SN 最近一次真实 claim 成功的会话——admin 台账「凭据」列读侧回填用：配网 claim 签发的凭据
   *  不写 device_registry.credential_*（只有后台手工签发写），否则台账显示「未签发」而设备已在用。 */
  lastClaimedSessionBySn(sn: string): PairingSessionRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM pairing_session WHERE sn = ? AND claimed_at IS NOT NULL ORDER BY claimed_at DESC LIMIT 1`)
        .get(sn) as PairingSessionRow) ?? null
    );
  }

  /** 同 SN 当前有效且未 claim 的会话（家长优先判定：存在即不代确认）。 */
  findUnclaimedSessionBySn(sn: string, now = Date.now()): PairingSessionRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM pairing_session WHERE sn = ? AND claimed_at IS NULL AND expires_at > ? ORDER BY confirmed_at DESC LIMIT 1`)
        .get(sn, now) as PairingSessionRow) ?? null
    );
  }

  findSessionByNonce(nonceString: string): PairingSessionRow | null {
    return (this.db.prepare(`SELECT * FROM pairing_session WHERE nonce_hash = ?`).get(hashToken(nonceString)) as PairingSessionRow) ?? null;
  }

  findSessionById(sessionId: string): PairingSessionRow | null {
    return (this.db.prepare(`SELECT * FROM pairing_session WHERE session_id = ?`).get(sessionId) as PairingSessionRow) ?? null;
  }

  markSessionClaimed(nonceString: string, brainState: 'ready' | 'initializing', bindingOutcome: BindingOutcome | null = null): void {
    this.db
      .prepare(`UPDATE pairing_session SET claimed_at = ?, brain_state = ?, binding_outcome = ? WHERE nonce_hash = ?`)
      .run(Date.now(), brainState, bindingOutcome, hashToken(nonceString));
  }

  // ───────── v3：announce（设备自报三元组）+ 后台预授权 ─────────

  /**
   * 设备自报。同 SN 新 nonce 覆盖旧记录（旧代收束）；同 nonce 重发不续命（announced_at / expires_at 不变，含已过期）；
   * 同 nonce 异 pk → pk_mismatch（announce 后换钥的口子不存在）。
   */
  upsertAnnounce(
    sn: string,
    nonceHash: string,
    devicePkB64: string,
    now = Date.now(),
  ): { outcome: 'new' | 'same' | 'replaced' | 'pk_mismatch'; row: PairingAnnounceRow } {
    const existing = this.findAnnounce(sn);
    if (existing && existing.nonce_hash === nonceHash) {
      if (existing.device_pk !== devicePkB64) return { outcome: 'pk_mismatch', row: existing };
      return { outcome: 'same', row: existing };
    }
    const row: PairingAnnounceRow = { sn, nonce_hash: nonceHash, device_pk: devicePkB64, announced_at: now, expires_at: now + TOKEN_TTL_S * 1000 };
    this.db
      .prepare(`INSERT OR REPLACE INTO pairing_announce (sn, nonce_hash, device_pk, announced_at, expires_at) VALUES (?, ?, ?, ?, ?)`)
      .run(sn, nonceHash, devicePkB64, row.announced_at, row.expires_at);
    return { outcome: existing ? 'replaced' : 'new', row };
  }

  findAnnounce(sn: string): PairingAnnounceRow | null {
    return (this.db.prepare(`SELECT * FROM pairing_announce WHERE sn = ?`).get(sn) as PairingAnnounceRow) ?? null;
  }

  listAnnounces(now = Date.now()): PairingAnnounceRow[] {
    return this.db.prepare(`SELECT * FROM pairing_announce WHERE expires_at > ? ORDER BY announced_at DESC`).all(now) as PairingAnnounceRow[];
  }

  purgeExpiredAnnounces(now = Date.now()): number {
    return Number(this.db.prepare(`DELETE FROM pairing_announce WHERE expires_at <= ?`).run(now).changes);
  }

  /** 写/覆盖预授权（同 SN 一条；覆盖即重新计时、清 used_at）。 */
  setPreauth(sn: string, parentAccountId: string, phone: string, untilAt: number, createdBy: string, now = Date.now()): DevicePreauthRow {
    const row: DevicePreauthRow = { sn, parent_account_id: parentAccountId, phone, until_at: untilAt, created_by: createdBy, created_at: now, used_at: null };
    this.db
      .prepare(
        `INSERT OR REPLACE INTO device_preauth (sn, parent_account_id, phone, until_at, created_by, created_at, used_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(sn, parentAccountId, phone, untilAt, createdBy, now);
    return row;
  }

  getPreauth(sn: string): DevicePreauthRow | null {
    return (this.db.prepare(`SELECT * FROM device_preauth WHERE sn = ?`).get(sn) as DevicePreauthRow) ?? null;
  }

  /** 有效预授权 = 未过期且未消费。 */
  activePreauth(sn: string, now = Date.now()): DevicePreauthRow | null {
    const p = this.getPreauth(sn);
    return p && p.until_at > now && p.used_at === null ? p : null;
  }

  deletePreauth(sn: string): boolean {
    return Number(this.db.prepare(`DELETE FROM device_preauth WHERE sn = ?`).run(sn).changes) > 0;
  }

  listPreauths(): DevicePreauthRow[] {
    return this.db.prepare(`SELECT * FROM device_preauth ORDER BY created_at DESC`).all() as DevicePreauthRow[];
  }

  /** 真实 claim 成功时消费：按 created_at 精确匹配（幂等恢复不再进这里；覆盖后的新预授权 created_at 不同，不会被旧会话误消费）。 */
  consumePreauth(sn: string, createdAt: number, now = Date.now()): boolean {
    return Number(
      this.db.prepare(`UPDATE device_preauth SET used_at = ? WHERE sn = ? AND created_at = ? AND used_at IS NULL`).run(now, sn, createdAt).changes,
    ) > 0;
  }
}

export const pairingStore = new PairingStore();
