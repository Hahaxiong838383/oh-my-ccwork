import { randomInt } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Step 0：账号数据层（10 固定账号 + 邀请码，原型 mock 登录用）。
// 独立库 accounts.db，与现有 feedback.db 物理隔离；本文件不接入任何运行路由，
// 仅供 scripts/seed-accounts.ts 灌数据 + 后续 Step 1 的登录路由查询。见 docs/15 §2.4 / §6 Step 0。

export type Account = {
  id: string;
  nickname: string;
  role: string;
  created_at: number;
  /** 手机号（短信验证码注册的账号才有；邀请码/设备账号为 null）。 */
  phone?: string | null;
};

export type InviteCode = {
  code: string;
  account_id: string;
  used_at: number | null;
  created_at: number;
};

export type AccountSeed = {
  id: string;
  nickname: string;
  code: string;
};

const DEFAULT_DB_PATH = './data/accounts.db';
const INVITE_LIMIT = 15;
const INVITE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateInviteCode(): string {
  let suffix = '';
  for (let i = 0; i < 4; i += 1) {
    suffix += INVITE_CHARS[randomInt(INVITE_CHARS.length)];
  }
  return `KH-${suffix}`;
}

function nextAccountNumber(accounts: Account[]): number {
  let max = 0;
  for (const account of accounts) {
    const matched = /^acct-(\d+)$/.exec(account.id);
    if (!matched) continue;
    const n = Number.parseInt(matched[1], 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

function formatAccountId(n: number): string {
  return `acct-${String(n).padStart(2, '0')}`;
}

function normalizeNickname(input: string | undefined, accountNo: number): string {
  const trimmed = input?.trim();
  return trimmed || `测试家长${String(accountNo).padStart(2, '0')}`;
}

function resolveDbPath(): string {
  const raw = process.env.ACCOUNTS_DB_PATH?.trim() || DEFAULT_DB_PATH;
  return resolve(process.cwd(), raw);
}

class AccountStore {
  private readonly db: DatabaseSync;

  constructor() {
    const dbPath = resolveDbPath();
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS account (
        id TEXT PRIMARY KEY,
        nickname TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'parent',
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS invite_code (
        code TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        used_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_invite_code_account
      ON invite_code (account_id);
    `);
    this.migrate();
  }

  /** 老库迁移：幂等补列（生产 accounts.db 建于 phone 列之前）。失败记日志不阻断启动。 */
  private migrate(): void {
    try {
      const cols = this.db.prepare('PRAGMA table_info(account)').all() as { name: string }[];
      if (!cols.some((c) => c.name === 'phone')) {
        this.db.exec(`ALTER TABLE account ADD COLUMN phone TEXT`);
      }
      // 部分唯一索引：phone 非空才参与唯一约束（存量邀请码/设备账号 phone=NULL 互不冲突）
      this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_account_phone ON account (phone) WHERE phone IS NOT NULL`);
    } catch (err) {
      console.error(`[account-store] phone 列迁移失败(不阻断): ${(err as Error).message}`);
    }
  }

  /** 幂等 seed：account 与 invite_code 均用 INSERT OR IGNORE，已存在则跳过、不覆盖。可重复跑。 */
  seed(items: AccountSeed[]): void {
    const now = Date.now();
    const insAccount = this.db.prepare(
      `INSERT OR IGNORE INTO account (id, nickname, role, created_at) VALUES (?, ?, 'parent', ?)`,
    );
    const insCode = this.db.prepare(
      `INSERT OR IGNORE INTO invite_code (code, account_id, used_at, created_at) VALUES (?, ?, NULL, ?)`,
    );
    for (const it of items) {
      insAccount.run(it.id, it.nickname, now);
      insCode.run(it.code, it.id, now);
    }
  }

  /** 按邀请码查（Step 1 登录路由用）。 */
  findByCode(code: string): InviteCode | null {
    const row = this.db
      .prepare(`SELECT code, account_id, used_at, created_at FROM invite_code WHERE code = ?`)
      .get(code.trim()) as InviteCode | undefined;
    return row ?? null;
  }

  findAccount(id: string): Account | null {
    const row = this.db
      .prepare(`SELECT id, nickname, role, created_at FROM account WHERE id = ?`)
      .get(id) as Account | undefined;
    return row ?? null;
  }

  listAccounts(): Account[] {
    return this.db
      .prepare(`SELECT id, nickname, role, created_at FROM account ORDER BY id`)
      .all() as Account[];
  }

  countCodes(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM invite_code`).get() as { count: number } | undefined;
    return row?.count ?? 0;
  }

  createInvite(nickname?: string): { code: string; account_id: string; nickname: string } {
    if (this.countCodes() >= INVITE_LIMIT) throw new Error('invite_limit');

    let code = '';
    for (let i = 0; i < 20; i += 1) {
      const candidate = generateInviteCode();
      if (!this.findByCode(candidate)) {
        code = candidate;
        break;
      }
    }
    if (!code) throw new Error('invite_code_collision');

    const accountNo = nextAccountNumber(this.listAccounts());
    const accountId = formatAccountId(accountNo);
    const accountNickname = normalizeNickname(nickname, accountNo);
    const now = Date.now();

    try {
      this.db.exec('BEGIN');
      this.db
        .prepare(`INSERT INTO account (id, nickname, role, created_at) VALUES (?, ?, 'parent', ?)`)
        .run(accountId, accountNickname, now);
      this.db
        .prepare(`INSERT INTO invite_code (code, account_id, used_at, created_at) VALUES (?, ?, NULL, ?)`)
        .run(code, accountId, now);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    return { code, account_id: accountId, nickname: accountNickname };
  }

  /** 按手机号查账号（短信验证码登录用）。 */
  findByPhone(phone: string): Account | null {
    const row = this.db
      .prepare(`SELECT id, nickname, role, created_at, phone FROM account WHERE phone = ?`)
      .get(phone.trim()) as Account | undefined;
    return row ?? null;
  }

  /**
   * 手机号账号 upsert（短信验证码注册/登录）：已存在直接返回；不存在则建
   * acct-NN 家长账号（沿用邀请码账号编号序列），nickname 默认「家长+尾4位」。
   * 并发双请求由 phone 唯一索引兜底：插入冲突后重查返回。
   */
  upsertPhoneAccount(phone: string): Account {
    const normalized = phone.trim();
    const existing = this.findByPhone(normalized);
    if (existing) return existing;
    const accountNo = nextAccountNumber(this.listAccounts());
    const accountId = formatAccountId(accountNo);
    const nickname = `家长${normalized.slice(-4)}`;
    try {
      this.db
        .prepare(`INSERT INTO account (id, nickname, role, created_at, phone) VALUES (?, ?, 'parent', ?, ?)`)
        .run(accountId, nickname, Date.now(), normalized);
    } catch {
      const raced = this.findByPhone(normalized);
      if (raced) return raced;
      throw new Error('phone_account_create_failed');
    }
    return this.findByPhone(normalized)!;
  }

  /**
   * 设备 brain 专属账号（运营台 worker brain tab）：id=device-<SN>，role='device'，无邀请码。
   * 幂等：已存在则直接返回现有账号（重复开通不重建）。
   */
  createDeviceAccount(sn: string, nickname: string): Account {
    const id = `device-${sn}`;
    const existing = this.findAccount(id);
    if (existing) return existing;
    this.db
      .prepare(`INSERT INTO account (id, nickname, role, created_at) VALUES (?, ?, 'device', ?)`)
      .run(id, nickname || `设备${sn.slice(-4)}`, Date.now());
    return this.findAccount(id)!;
  }

  markUsed(code: string): void {
    this.db.prepare(`UPDATE invite_code SET used_at = ? WHERE code = ? AND used_at IS NULL`).run(Date.now(), code.trim());
  }

  deleteInvite(code: string): boolean {
    const invite = this.findByCode(code);
    if (!invite) return false;

    try {
      this.db.exec('BEGIN');
      this.db.prepare(`DELETE FROM invite_code WHERE code = ?`).run(invite.code);
      this.db.prepare(`DELETE FROM account WHERE id = ?`).run(invite.account_id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    return true;
  }

  /** 更新家长昵称（admin 用来备注邀请码发给谁）。 */
  updateNickname(accountId: string, nickname: string): boolean {
    const r = this.db.prepare(`UPDATE account SET nickname = ? WHERE id = ?`).run(nickname, accountId);
    return Number(r.changes) > 0;
  }

  listCodes(): InviteCode[] {
    return this.db
      .prepare(`SELECT code, account_id, used_at, created_at FROM invite_code ORDER BY code`)
      .all() as InviteCode[];
  }
}

export const accountStore = new AccountStore();
