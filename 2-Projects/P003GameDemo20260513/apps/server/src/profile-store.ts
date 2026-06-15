import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// 打通建档+配网链路：孩子档案(family_member) + 设备绑定(device)，按 account_id 隔离。
// 独立库 profile.db（与 accounts.db / feedback.db 物理隔离，同现有 store 模式）。
// 原型阶段：一个账号一个孩子档案 + 一台设备（upsert）。后续 PG 迁移时扩多孩子/多设备。

export type FamilyMember = {
  id: string;
  account_id: string;
  nickname: string;
  birthday: string; // "2018-08"，可空
  gender: string; // "男孩" / "女孩"，可空
  created_at: number;
  updated_at: number;
};

export type Device = {
  id: string;
  account_id: string;
  model: string;
  name: string;
  bound_at: number;
};

export type ProfileInput = {
  nickname: string;
  birthday: string;
  gender: string;
};

export type DeviceInput = {
  model: string;
  name: string;
};

const DEFAULT_DB_PATH = './data/profile.db';

function resolveDbPath(): string {
  const raw = process.env.PROFILE_DB_PATH?.trim() || DEFAULT_DB_PATH;
  return resolve(process.cwd(), raw);
}

class ProfileStore {
  private readonly db: DatabaseSync;

  constructor() {
    const dbPath = resolveDbPath();
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS family_member (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        nickname TEXT NOT NULL,
        birthday TEXT NOT NULL DEFAULT '',
        gender TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_family_member_account ON family_member (account_id);
      CREATE TABLE IF NOT EXISTS device (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL DEFAULT '',
        bound_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_device_account ON device (account_id);
    `);
  }

  /** 原型：一个账号一个孩子档案。已存在则更新，不存在则插入。 */
  upsertProfile(accountId: string, input: ProfileInput): FamilyMember {
    const now = Date.now();
    const existing = this.getProfile(accountId);
    if (existing) {
      this.db
        .prepare(`UPDATE family_member SET nickname = ?, birthday = ?, gender = ?, updated_at = ? WHERE id = ?`)
        .run(input.nickname, input.birthday, input.gender, now, existing.id);
      return { ...existing, ...input, updated_at: now };
    }
    const member: FamilyMember = {
      id: randomUUID(),
      account_id: accountId,
      nickname: input.nickname,
      birthday: input.birthday,
      gender: input.gender,
      created_at: now,
      updated_at: now,
    };
    this.db
      .prepare(`
        INSERT INTO family_member (id, account_id, nickname, birthday, gender, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(member.id, member.account_id, member.nickname, member.birthday, member.gender, member.created_at, member.updated_at);
    return member;
  }

  getProfile(accountId: string): FamilyMember | null {
    const row = this.db
      .prepare(`
        SELECT id, account_id, nickname, birthday, gender, created_at, updated_at
        FROM family_member WHERE account_id = ? ORDER BY created_at LIMIT 1
      `)
      .get(accountId) as FamilyMember | undefined;
    return row ?? null;
  }

  /** 原型：一个账号一台设备。已存在则更新绑定信息，不存在则插入。 */
  bindDevice(accountId: string, input: DeviceInput): Device {
    const now = Date.now();
    const existing = this.getDevice(accountId);
    if (existing) {
      this.db
        .prepare(`UPDATE device SET model = ?, name = ?, bound_at = ? WHERE id = ?`)
        .run(input.model, input.name, now, existing.id);
      return { ...existing, ...input, bound_at: now };
    }
    const device: Device = {
      id: randomUUID(),
      account_id: accountId,
      model: input.model,
      name: input.name,
      bound_at: now,
    };
    this.db
      .prepare(`INSERT INTO device (id, account_id, model, name, bound_at) VALUES (?, ?, ?, ?, ?)`)
      .run(device.id, device.account_id, device.model, device.name, device.bound_at);
    return device;
  }

  getDevice(accountId: string): Device | null {
    const row = this.db
      .prepare(`SELECT id, account_id, model, name, bound_at FROM device WHERE account_id = ? ORDER BY bound_at DESC LIMIT 1`)
      .get(accountId) as Device | undefined;
    return row ?? null;
  }

  deleteByAccountId(accountId: string): void {
    try {
      this.db.exec('BEGIN');
      this.db.prepare(`DELETE FROM family_member WHERE account_id = ?`).run(accountId);
      this.db.prepare(`DELETE FROM device WHERE account_id = ?`).run(accountId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** hub 看板：列所有孩子档案（admin 视角，按建档时间倒序）。 */
  listAllProfiles(): FamilyMember[] {
    return this.db
      .prepare(`SELECT id, account_id, nickname, birthday, gender, created_at, updated_at FROM family_member ORDER BY created_at DESC`)
      .all() as FamilyMember[];
  }

  /** hub 看板：列所有已绑定设备（admin 视角）。 */
  listAllDevices(): Device[] {
    return this.db
      .prepare(`SELECT id, account_id, model, name, bound_at FROM device ORDER BY bound_at DESC`)
      .all() as Device[];
  }
}

export const profileStore = new ProfileStore();
