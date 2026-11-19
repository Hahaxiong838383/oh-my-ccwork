import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * 本地验证码存储（Spug 自备码模式配套，2026-08-23）。
 * 阿里云 dypnsapi 是托管核验（码不落本地）；切 Spug 后码由 server 生成，本 store 负责
 * 存储与校验。安全姿势：
 *  - 新码存服务端密钥HMAC，不存明文；旧SHA码仅兼容其原5分钟有效期
 *  - TTL 5 分钟；同号新码顶旧码（与阿里云 DuplicatePolicy=1 同语义）
 *  - 尝试上限 5 次（防在线枚举 6 位码）；验证成功即删（一次性）
 *  - verify 内部区分 mismatch/expired/too_many/not_found 便于日志，路由层统一映射
 *    code_invalid 单一口径（防枚举探测，与阿里云链路口径一致）
 * 库复用 sms.db（SMS_DB_PATH，与发送流水同库不同表）。
 */

const DEFAULT_DB_PATH = './data/sms.db';
const CODE_TTL_MS = 5 * 60_000;
const MAX_ATTEMPTS = 5;

export type VerifyOutcome = 'ok' | 'mismatch' | 'expired' | 'too_many' | 'not_found';

function hashCode(phone: string, code: string): string {
  const secret = process.env.AUTH_JWT_SECRET ?? '';
  if (secret !== secret.trim() || Buffer.byteLength(secret) < 32 || secret === 'dev-secret-change-me') {
    throw new Error('auth_not_configured');
  }
  return 'h1:' + createHmac('sha256', secret).update(`p003-sms-v1\0${phone}:${code}`, 'utf8').digest('hex');
}

function resolveDbPath(): string {
  const raw = process.env.SMS_DB_PATH?.trim() || DEFAULT_DB_PATH;
  return resolve(process.cwd(), raw);
}

class VerifyCodeStore {
  private readonly db: DatabaseSync;

  constructor() {
    const dbPath = resolveDbPath();
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 1000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS verify_code (
        phone TEXT PRIMARY KEY,
        code_hash TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  /** 发送成功后落码（同号顶旧码，attempts 归零）。 */
  issue(phone: string, code: string, now = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO verify_code (phone, code_hash, expires_at, attempts) VALUES (?, ?, ?, 0)
         ON CONFLICT(phone) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0`,
      )
      .run(phone, hashCode(phone, code), now + CODE_TTL_MS);
  }

  /** 校验：成功即删（一次性）；失败累计 attempts，超限即删。 */
  verify(phone: string, code: string, now = Date.now()): VerifyOutcome {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.verifyAndConsume(phone, code, now);
      this.db.exec('COMMIT');
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  private verifyAndConsume(phone: string, code: string, now: number): VerifyOutcome {
    const row = this.db
      .prepare(`SELECT code_hash, expires_at, attempts FROM verify_code WHERE phone = ?`)
      .get(phone) as { code_hash: string; expires_at: number; attempts: number } | undefined;
    if (!row) return 'not_found';
    if (now >= row.expires_at) {
      this.db.prepare(`DELETE FROM verify_code WHERE phone = ?`).run(phone);
      return 'expired';
    }
    if (row.attempts >= MAX_ATTEMPTS) {
      this.db.prepare(`DELETE FROM verify_code WHERE phone = ?`).run(phone);
      return 'too_many';
    }
    const keyed = row.code_hash.startsWith('h1:');
    const expect = Buffer.from(keyed ? row.code_hash.slice(3) : row.code_hash, 'hex');
    const got = Buffer.from(keyed ? hashCode(phone, code).slice(3) : createHash('sha256').update(`${phone}:${code}`).digest('hex'), 'hex');
    if (expect.length === got.length && timingSafeEqual(expect, got)) {
      this.db.prepare(`DELETE FROM verify_code WHERE phone = ?`).run(phone);
      return 'ok';
    }
    this.db.prepare(`UPDATE verify_code SET attempts = attempts + 1 WHERE phone = ?`).run(phone);
    return 'mismatch';
  }
}

export const verifyCodeStore = new VerifyCodeStore();
