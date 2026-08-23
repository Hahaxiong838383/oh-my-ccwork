import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// 打通建档+配网链路：孩子档案(family_member) + 设备绑定(device)，按 account_id 隔离。
// 独立库 profile.db（与 accounts.db / feedback.db 物理隔离，同现有 store 模式）。
// 原型阶段：一个账号一个孩子档案 + 一台设备（upsert）。后续 PG 迁移时扩多孩子/多设备。
//
// P1（2026-06-18）：family_member 扩展画像字段（interests/preferred_address/personality_notes/
// recent_emotion），供语音对话异步抽取写入（updateMemoryFields），实现"懂孩子"的长期画像。
// profile-store 是孩子画像的【唯一真相源】，多端（体验台/admin/家长端）都读它 → 多端打通。

export type InterestItem = { value: string; confidence: number; last_updated: number; source: string };

// 方舟冒险事件记忆（game_progress）：孩子明确表达的方舟游戏进展/冒险经历（"通关了恐龙星域"…）。
// 轻量扩展，持久化同 interests（family_member.game_progress JSON TEXT 列），写时只留最近 5 条。
export type GameEvent = { value: string; last_updated: number; source: string };

const GAME_PROGRESS_MAX = 5; // 只留最近 5 条方舟冒险事件（按 last_updated）。

export type FamilyMember = {
  id: string;
  account_id: string;
  nickname: string;
  birthday: string; // "2018-08"，可空
  gender: string; // "男孩" / "女孩"，可空
  // P1 画像字段（语音抽取写入）
  interests: InterestItem[]; // 兴趣（恐龙/奥特曼…）
  preferred_address: string; // 喜欢被叫什么（昵称偏好）
  personality_notes: string; // 性格观察
  recent_emotion: string; // 近期情绪锚点（JSON {emotion,topic,ts} 或文本）
  game_progress: GameEvent[]; // 方舟冒险事件记忆（最近 5 条，语音抽取写入）
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

// P1 语音抽取写入的画像增量（部分更新，只覆盖提供的字段）。
export type MemoryPatch = Partial<{
  nickname: string;
  preferred_address: string;
  personality_notes: string;
  recent_emotion: string;
  interests: InterestItem[];
  game_progress: GameEvent[]; // 只新增项（合并下沉到 updateMemoryFields 写时，防并发 lost update）
}>;

// DB 原始行（interests / game_progress 是 TEXT，读出后 parse 成数组）。
type FamilyRow = Omit<FamilyMember, 'interests' | 'game_progress'> & {
  interests: string;
  game_progress: string;
};

const DEFAULT_DB_PATH = './data/profile.db';

function resolveDbPath(): string {
  const raw = process.env.PROFILE_DB_PATH?.trim() || DEFAULT_DB_PATH;
  return resolve(process.cwd(), raw);
}

const FAMILY_COLUMNS =
  'id, account_id, nickname, birthday, gender, interests, preferred_address, personality_notes, recent_emotion, game_progress, created_at, updated_at';

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
        interests TEXT NOT NULL DEFAULT '[]',
        preferred_address TEXT NOT NULL DEFAULT '',
        personality_notes TEXT NOT NULL DEFAULT '',
        recent_emotion TEXT NOT NULL DEFAULT '',
        game_progress TEXT NOT NULL DEFAULT '[]',
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
    this.migrate();
  }

  /** P1 老库迁移：幂等补画像列（已有 family_member 库不含新列时 ALTER）。失败不阻断启动（team#5）。 */
  private migrate(): void {
    try {
      const cols = this.db.prepare('PRAGMA table_info(family_member)').all() as { name: string }[];
      const has = (n: string) => cols.some((c) => c.name === n);
      const add = (col: string, def: string) => {
        if (!has(col)) this.db.exec(`ALTER TABLE family_member ADD COLUMN ${col} TEXT NOT NULL DEFAULT '${def}'`);
      };
      add('interests', '[]');
      add('preferred_address', '');
      add('personality_notes', '');
      add('recent_emotion', '');
      add('game_progress', '[]');
    } catch (err) {
      // CREATE TABLE 已含新列（新库无碍）；老库迁移失败记日志、不阻断启动，后续人工处理。
      console.error('[profile-store] migrate 失败(不阻断启动):', String((err as Error)?.message ?? err));
    }
  }

  // 解析 interests / game_progress JSON，并校验元素结构（损坏/异常对象不进入 prompt 注入路径 — team#7）。
  // 旧库（无 game_progress 列时 row.game_progress 为 undefined）默认 []，向后兼容。
  private rowToMember(row: FamilyRow): FamilyMember {
    const interests = parseJsonArray(
      row.interests,
      (i): i is InterestItem => Boolean(i) && typeof i.value === 'string' && typeof i.confidence === 'number',
    );
    const game_progress = parseJsonArray(
      row.game_progress,
      (g): g is GameEvent => Boolean(g) && typeof g.value === 'string' && typeof g.last_updated === 'number',
    );
    return { ...row, interests, game_progress };
  }

  /**
   * 家长档 → 设备账号档同步（建档下发链）：只 copy 基础三字段（nickname/birthday/gender）。
   * 画像 12 类与情景记忆不 copy——设备侧对话自己积累。from 无档返回 null（调用方决定兜底）。
   */
  copyProfile(fromAccountId: string, toAccountId: string): FamilyMember | null {
    const src = this.getProfile(fromAccountId);
    if (!src) return null;
    return this.upsertProfile(toAccountId, {
      nickname: src.nickname,
      birthday: src.birthday,
      gender: src.gender,
    });
  }

  /** 原型：一个账号一个孩子档案。已存在则更新基础信息，不存在则插入。 */
  upsertProfile(accountId: string, input: ProfileInput): FamilyMember {
    const now = Date.now();
    const existing = this.getProfile(accountId);
    if (existing) {
      this.db
        .prepare(`UPDATE family_member SET nickname = ?, birthday = ?, gender = ?, updated_at = ? WHERE id = ?`)
        .run(input.nickname, input.birthday, input.gender, now, existing.id);
      return { ...existing, ...input, updated_at: now };
    }
    const id = randomUUID();
    this.db
      .prepare(`
        INSERT INTO family_member (${FAMILY_COLUMNS})
        VALUES (?, ?, ?, ?, ?, '[]', '', '', '', '[]', ?, ?)
      `)
      .run(id, accountId, input.nickname, input.birthday, input.gender, now, now);
    return {
      id,
      account_id: accountId,
      nickname: input.nickname,
      birthday: input.birthday,
      gender: input.gender,
      interests: [],
      preferred_address: '',
      personality_notes: '',
      recent_emotion: '',
      game_progress: [],
      created_at: now,
      updated_at: now,
    };
  }

  /**
   * onboarding 增量建档：逐字段补齐基础档案（只覆盖 patch 里提供的，其余保持）。
   * 无档案时创建基础档案，画像列使用默认值（upsertProfile 只写 nickname/birthday/gender，不动画像字段）。
   * 并发安全：getProfile→upsertProfile 全程同步（DatabaseSync 无 await），且抽取写回回调在事件循环里
   * 串行执行、每次读最新 existing 合并 → 不会 lost update（对齐 updateMemoryFields 的同步原子策略）。
   */
  upsertBasics(accountId: string, patch: Partial<ProfileInput>): FamilyMember {
    const existing = this.getProfile(accountId);
    const input: ProfileInput = {
      nickname: patch.nickname !== undefined ? patch.nickname : existing?.nickname ?? '',
      birthday: patch.birthday !== undefined ? patch.birthday : existing?.birthday ?? '',
      gender: patch.gender !== undefined ? patch.gender : existing?.gender ?? '',
    };
    return this.upsertProfile(accountId, input);
  }

  /**
   * P1 语音抽取写入：部分更新画像字段（只覆盖 patch 里提供的，其余保持）。
   * 无档案时返回 null（不凭空建档——建档是家长端的事，抽取只在已有档案上补画像）。
   */
  updateMemoryFields(accountId: string, patch: MemoryPatch): FamilyMember | null {
    const existing = this.getProfile(accountId);
    if (!existing) return null;
    const merged: FamilyMember = {
      ...existing,
      nickname: patch.nickname ?? existing.nickname,
      preferred_address: patch.preferred_address ?? existing.preferred_address,
      personality_notes: patch.personality_notes ?? existing.personality_notes,
      recent_emotion: patch.recent_emotion ?? existing.recent_emotion,
      // team#1: patch.interests 是「新增项」，基于此刻最新 existing 合并（本方法 getProfile→UPDATE 间
      // 无 await=同步原子执行），杜绝基于抽取时旧快照覆盖导致的并发 lost update。
      interests: patch.interests ? appendInterests(existing.interests, patch.interests) : existing.interests,
      // game_progress 同 interests 防并发：基于最新 existing 追加新增 + 去重 + 只留最近 5 条。
      game_progress: patch.game_progress
        ? appendGameEvents(existing.game_progress, patch.game_progress)
        : existing.game_progress,
      updated_at: Date.now(),
    };
    this.db
      .prepare(`
        UPDATE family_member
        SET nickname = ?, preferred_address = ?, personality_notes = ?, recent_emotion = ?, interests = ?, game_progress = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        merged.nickname,
        merged.preferred_address,
        merged.personality_notes,
        merged.recent_emotion,
        JSON.stringify(merged.interests),
        JSON.stringify(merged.game_progress),
        merged.updated_at,
        existing.id,
      );
    return merged;
  }

  /**
   * Phase 1(docs/43):孩子明确说"不喜欢X了" → 从 interests 删除该项(dislike 联动撤销)。
   * 同 updateMemoryFields 的同步原子策略:读最新→过滤→写回,无 await 间隙,防并发 lost update。
   */
  removeInterest(accountId: string, value: string): boolean {
    const existing = this.getProfile(accountId);
    if (!existing) return false;
    // 归一互含匹配（旧为字面全等——retract 词「不想聊冷光」删不掉兴趣「冷光」）
    const next = existing.interests.filter((i) => !isSameInterest(i.value, value));
    if (next.length === existing.interests.length) return false;
    this.db
      .prepare('UPDATE family_member SET interests = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(next), Date.now(), existing.id);
    return true;
  }

  getProfile(accountId: string): FamilyMember | null {
    const row = this.db
      .prepare(`SELECT ${FAMILY_COLUMNS} FROM family_member WHERE account_id = ? ORDER BY created_at LIMIT 1`)
      .get(accountId) as FamilyRow | undefined;
    return row ? this.rowToMember(row) : null;
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
    const rows = this.db
      .prepare(`SELECT ${FAMILY_COLUMNS} FROM family_member ORDER BY created_at DESC`)
      .all() as FamilyRow[];
    return rows.map((r) => this.rowToMember(r));
  }

  /** hub 看板：列所有已绑定设备（admin 视角）。 */
  listAllDevices(): Device[] {
    return this.db
      .prepare(`SELECT id, account_id, model, name, bound_at FROM device ORDER BY bound_at DESC`)
      .all() as Device[];
  }
}

// team#1: 兴趣合并去重（基于最新 existing append 新增项，写时执行保证原子）。
/**
 * 兴趣同义归一（2026-08-23 兴趣污染治理，川哥拍板方案 B）：
 * 去分隔符/标点/空白 + 小写化——「KET/PET考试」与「KETPET」归一后互含即同义。
 * 供写时判重、retract 匹配、dislike 对撞、存量清洗脚本共用（单一真源）。
 */
export function normalizeInterestValue(s: string): string {
  return s.toLowerCase().replace(/[\s\/\\、，,。.·\-_()（）:：!！?？"'「」『』]/g, '');
}

/** 同义判定：归一后互含（含全等）。空串永不匹配（归一后为空的垃圾值不参与判重）。 */
export function isSameInterest(a: string, b: string): boolean {
  const na = normalizeInterestValue(a);
  const nb = normalizeInterestValue(b);
  if (!na || !nb) return false;
  return na.includes(nb) || nb.includes(na);
}

function appendInterests(existing: InterestItem[], added: InterestItem[]): InterestItem[] {
  const merged = [...existing];
  for (const item of added) {
    if (!item || typeof item.value !== 'string') continue;
    // 归一互含判重（旧为字面全等——「KETPET」与「KET/PET考试」当作两项，是污染根因）
    if (merged.some((i) => isSameInterest(i.value, item.value))) continue;
    merged.push(item);
  }
  return merged;
}

// 方舟冒险事件合并：基于最新 existing 追加新增项（按 value 去重），按 last_updated 只留最近 GAME_PROGRESS_MAX 条。
// 不可变：返回新数组，不原地改入参。
function appendGameEvents(existing: GameEvent[], added: GameEvent[]): GameEvent[] {
  const seen = new Set(existing.map((g) => g.value));
  const merged = [...existing];
  for (const ev of added) {
    if (ev && typeof ev.value === 'string' && !seen.has(ev.value)) {
      seen.add(ev.value);
      merged.push(ev);
    }
  }
  // 只留最近 N 条：按 last_updated 降序取前 N，再按时间升序还原存储顺序（旧→新，稳定可读）。
  if (merged.length <= GAME_PROGRESS_MAX) return merged;
  return [...merged]
    .sort((a, b) => b.last_updated - a.last_updated)
    .slice(0, GAME_PROGRESS_MAX)
    .sort((a, b) => a.last_updated - b.last_updated);
}

// 解析 JSON 数组列（损坏容错为 []；旧库列 undefined 也容错），按 guard 过滤异常元素。
function parseJsonArray<T>(raw: string | undefined, guard: (v: any) => v is T): T[] {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed.filter(guard) : [];
  } catch {
    return [];
  }
}

export const profileStore = new ProfileStore();

// 无档案/缺昵称/缺性别 → 需 onboarding；生日不计入退出判定，走家长兜底。
// 字段防御：历史/异常数据可能非字符串，用 ?? '' 兜底避免 .trim() 抛错阻断主链路（failsafe）。
export function needsOnboarding(p: FamilyMember | null): boolean {
  return !p || !(p.nickname ?? '').trim() || !(p.gender ?? '').trim();
}
