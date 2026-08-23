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
};

const DEFAULT_DB_PATH = './data/pairing.db';

function resolveDbPath(): string {
  const raw = process.env.PAIRING_DB_PATH?.trim() || DEFAULT_DB_PATH;
  return resolve(process.cwd(), raw);
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
    `);
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
    this.db.prepare(`DELETE FROM pairing_session WHERE sn = ? AND claimed_at IS NULL`).run(sn);
    const sessionId = randomBytes(9).toString('base64url');
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO pairing_session (nonce_hash, session_id, sn, account_id, device_pk, confirmed_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(hashToken(nonceString), sessionId, sn, accountId, devicePkB64, now, now + TOKEN_TTL_S * 1000);
    return { sessionId };
  }

  findSessionByNonce(nonceString: string): PairingSessionRow | null {
    return (this.db.prepare(`SELECT * FROM pairing_session WHERE nonce_hash = ?`).get(hashToken(nonceString)) as PairingSessionRow) ?? null;
  }

  findSessionById(sessionId: string): PairingSessionRow | null {
    return (this.db.prepare(`SELECT * FROM pairing_session WHERE session_id = ?`).get(sessionId) as PairingSessionRow) ?? null;
  }

  markSessionClaimed(nonceString: string, brainState: 'ready' | 'initializing'): void {
    this.db
      .prepare(`UPDATE pairing_session SET claimed_at = ?, brain_state = ? WHERE nonce_hash = ?`)
      .run(Date.now(), brainState, hashToken(nonceString));
  }
}

export const pairingStore = new PairingStore();
