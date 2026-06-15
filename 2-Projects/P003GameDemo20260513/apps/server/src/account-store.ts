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

  listCodes(): InviteCode[] {
    return this.db
      .prepare(`SELECT code, account_id, used_at, created_at FROM invite_code ORDER BY code`)
      .all() as InviteCode[];
  }
}

export const accountStore = new AccountStore();
