import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const FEEDBACK_STATUSES = ['已收到', '评估中', '已采纳', '金点子库'] as const;

export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

/**
 * 主题词表（预设 + 「其他」兜底）。
 * 来源：mock khThemes 4 项 + 业务高频补 6 项，覆盖 8 张场景卡 + KidsHub 反馈典型分类。
 * 「未分类」是出厂默认（旧数据 + 新 add 都进它，等人工归类，前端不让选）。
 * 「其他」是预设外兜底（admin 选了它就放弃归类，下个版本看要不要扩词表）。
 */
export const FEEDBACK_THEMES = [
  '未分类',
  '夜航·内容',
  '专注·交互',
  '皮肤·养成',
  '周报·可读性',
  '登舰·体验',
  '生态·养成',
  '记忆·联动',
  'KidsHub·建议',
  '设备·设置',
  '其他',
] as const;

export type FeedbackTheme = (typeof FEEDBACK_THEMES)[number];

/** 情绪极性枚举（mock 4 项 + 中性默认） */
export const FEEDBACK_EMOTIONS = ['中性', '期待', '吐槽', '愿望', '困惑'] as const;

export type FeedbackEmotion = (typeof FEEDBACK_EMOTIONS)[number];

/** 采纳子状态：status='已采纳' 时生效；其他 status 下为 null。 */
export const FEEDBACK_ADOPTION_KINDS = ['普通', '重点'] as const;

export type FeedbackAdoptionKind = (typeof FEEDBACK_ADOPTION_KINDS)[number];

export type FeedbackItem = {
  id: string;
  session_id: string;
  turn_id: number;
  source: string;
  ts: number;
  nickname: string;
  // 设备信息（登录页收集，随 session.meta 落库）：性别 / 年龄，后台按孩子画像分析反馈用
  gender: string;
  age: string;
  scene_id: string | null;
  text: string;
  status: FeedbackStatus;
  note: string;
  updated_at: number;
  updated_by: string;
  ip_hash: string;
  // Step 3：归属账号（邀请码登录后写入；匿名/旧数据为 null）。用于 parent 视角按账号隔离查询。
  account_id: string | null;
  // 2026-06-30 双标签 + 采纳子状态（admin 手工标，无 LLM）
  /** 主题 chip（预设枚举，新行/旧行默认「未分类」） */
  theme: FeedbackTheme;
  /** 情绪极性 chip（默认「中性」） */
  emotion: FeedbackEmotion;
  /** 采纳子类（仅 status='已采纳' 时生效；其他 status 为 null；前端用下拉） */
  adoption_kind: FeedbackAdoptionKind | null;
};

export type FeedbackAddInput = {
  session_id: string;
  turn_id: number;
  source: string;
  nickname: string;
  gender: string;
  age: string;
  scene_id: string | null;
  text: string;
  ip_hash: string;
  // Step 3：可选。鉴权后的 WS 会带；现有匿名调用不传 → 落 null（向后兼容）。
  account_id?: string | null;
};

type FeedbackRow = {
  id: string;
  session_id: string;
  turn_id: number;
  source: string;
  ts: number;
  nickname: string;
  gender: string;
  age: string;
  scene_id: string | null;
  text: string;
  status: string;
  note: string;
  updated_at: number;
  updated_by: string;
  ip_hash: string;
  account_id: string | null;
  theme: string;
  emotion: string;
  adoption_kind: string | null;
};

type FeedbackUpdateInput = {
  status?: FeedbackStatus;
  note?: string;
  updatedBy?: string;
  /** 主题改写（admin 手动归类）。传入字符串非枚举值 → 兜底「其他」。 */
  theme?: FeedbackTheme;
  /** 情绪改写（admin 手动）。非枚举 → 兜底「中性」。 */
  emotion?: FeedbackEmotion;
  /**
   * 采纳子类。规则：
   * - 传 '普通' / '重点' → 写入（无论当前 status；UI 应在 status='已采纳' 时才暴露下拉）
   * - 传 null → 显式清空（admin 切回非采纳时 UI 清掉）
   * - 不传（undefined）→ 保持原值
   */
  adoptionKind?: FeedbackAdoptionKind | null;
};

const DEFAULT_DB_PATH = './data/feedback.db';
const DEDUPE_WINDOW_MS = 30_000;

// 列清单单一真相：建表 / SELECT / INSERT 共用，加字段只改这里（防多处 SQL 漏列）
const FEEDBACK_COLUMNS = [
  'id',
  'session_id',
  'turn_id',
  'source',
  'ts',
  'nickname',
  'gender',
  'age',
  'scene_id',
  'text',
  'status',
  'note',
  'updated_at',
  'updated_by',
  'ip_hash',
  'account_id',
  'theme',
  'emotion',
  'adoption_kind',
] as const;

const SELECT_COLS = FEEDBACK_COLUMNS.join(', ');

function resolveDbPath(): string {
  const rawPath = process.env.FEEDBACK_DB_PATH?.trim() || DEFAULT_DB_PATH;
  return resolve(process.cwd(), rawPath);
}

function toFeedbackItem(row: FeedbackRow | null | undefined): FeedbackItem | null {
  if (!row) return null;
  if (!isFeedbackStatus(row.status)) return null;
  return {
    id: row.id,
    session_id: row.session_id,
    turn_id: row.turn_id,
    source: row.source,
    ts: row.ts,
    nickname: row.nickname,
    gender: row.gender,
    age: row.age,
    scene_id: row.scene_id,
    text: row.text,
    status: row.status,
    note: row.note,
    updated_at: row.updated_at,
    updated_by: row.updated_by,
    ip_hash: row.ip_hash,
    account_id: row.account_id ?? null,
    theme: normalizeTheme(row.theme),
    emotion: normalizeEmotion(row.emotion),
    adoption_kind: normalizeAdoptionKind(row.adoption_kind),
  };
}

function isFeedbackStatus(value: string): value is FeedbackStatus {
  return FEEDBACK_STATUSES.includes(value as FeedbackStatus);
}

/** 主题归一：未知 / 空 → 「未分类」（向后兼容旧数据 + 容错） */
function normalizeTheme(value: string | null | undefined): FeedbackTheme {
  const v = (value ?? '').trim();
  return (FEEDBACK_THEMES as readonly string[]).includes(v) ? (v as FeedbackTheme) : '未分类';
}

/** 情绪归一：未知 / 空 → 「中性」 */
function normalizeEmotion(value: string | null | undefined): FeedbackEmotion {
  const v = (value ?? '').trim();
  return (FEEDBACK_EMOTIONS as readonly string[]).includes(v) ? (v as FeedbackEmotion) : '中性';
}

/** 采纳子类归一：未知 / 空 → null（status≠已采纳 时本就该 null） */
function normalizeAdoptionKind(value: string | null | undefined): FeedbackAdoptionKind | null {
  const v = (value ?? '').trim();
  if (!v) return null;
  return (FEEDBACK_ADOPTION_KINDS as readonly string[]).includes(v) ? (v as FeedbackAdoptionKind) : null;
}

class FeedbackStore {
  private readonly db: DatabaseSync;

  constructor() {
    const dbPath = resolveDbPath();
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS feedback_items (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn_id INTEGER NOT NULL,
        source TEXT NOT NULL,
        ts INTEGER NOT NULL,
        nickname TEXT NOT NULL,
        gender TEXT NOT NULL DEFAULT '',
        age TEXT NOT NULL DEFAULT '',
        scene_id TEXT,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        note TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        updated_by TEXT NOT NULL,
        ip_hash TEXT NOT NULL,
        account_id TEXT,
        theme TEXT NOT NULL DEFAULT '未分类',
        emotion TEXT NOT NULL DEFAULT '中性',
        adoption_kind TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_feedback_items_ts
      ON feedback_items (ts DESC);
      CREATE INDEX IF NOT EXISTS idx_feedback_items_session_text_ts
      ON feedback_items (session_id, text, ts DESC);
    `);
    // 生产已有 feedback_items 表（建于无 gender/age/account_id 的版本）→ 补列保留旧数据
    // （CREATE TABLE IF NOT EXISTS 不会改已存在表，必须显式 ALTER）
    this.migrateAddColumn('gender', "TEXT NOT NULL DEFAULT ''");
    this.migrateAddColumn('age', "TEXT NOT NULL DEFAULT ''");
    // Step 3：account_id 可空，旧行/匿名为 NULL（不破坏现有数据，向后兼容）
    this.migrateAddColumn('account_id', 'TEXT');
    // 2026-06-30：双标签 + 采纳子状态。旧行 theme/emotion 走 DEFAULT，adoption_kind 为 NULL
    this.migrateAddColumn('theme', "TEXT NOT NULL DEFAULT '未分类'");
    this.migrateAddColumn('emotion', "TEXT NOT NULL DEFAULT '中性'");
    this.migrateAddColumn('adoption_kind', 'TEXT');
    // 账号维度查询索引（parent 视角隔离用）；列存在才建
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_feedback_items_account ON feedback_items (account_id, ts DESC);');
    // 主题维度聚合用索引（按 theme 分组 count，主题池实时统计）
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_feedback_items_theme ON feedback_items (theme);');
  }

  /** 幂等加列：列已存在则跳过，否则 ALTER TABLE ADD COLUMN（旧行用 DEFAULT 填充） */
  private migrateAddColumn(col: string, def: string): void {
    const cols = this.db.prepare('PRAGMA table_info(feedback_items)').all() as { name: string }[];
    if (cols.some((c) => c.name === col)) return;
    this.db.exec(`ALTER TABLE feedback_items ADD COLUMN ${col} ${def}`);
  }

  add(input: FeedbackAddInput): FeedbackItem {
    const sessionId = input.session_id.trim();
    const text = input.text.trim();
    const source = input.source.trim();
    const nickname = input.nickname.trim();
    const gender = input.gender.trim();
    const age = input.age.trim();
    const sceneId = typeof input.scene_id === 'string' && input.scene_id.trim() ? input.scene_id.trim() : null;
    const ipHash = input.ip_hash.trim();
    const accountId =
      typeof input.account_id === 'string' && input.account_id.trim() ? input.account_id.trim() : null;
    const now = Date.now();

    const existing = this.findDuplicate(sessionId, text, now - DEDUPE_WINDOW_MS);
    if (existing) {
      return existing;
    }

    const item: FeedbackItem = {
      id: randomUUID(),
      session_id: sessionId,
      turn_id: input.turn_id,
      source,
      ts: now,
      nickname,
      gender,
      age,
      scene_id: sceneId,
      text,
      status: '已收到',
      note: '',
      updated_at: now,
      updated_by: 'system',
      ip_hash: ipHash,
      account_id: accountId,
      theme: '未分类',
      emotion: '中性',
      adoption_kind: null,
    };

    this.db
      .prepare(`
        INSERT INTO feedback_items (
          id, session_id, turn_id, source, ts, nickname, gender, age, scene_id,
          text, status, note, updated_at, updated_by, ip_hash, account_id,
          theme, emotion, adoption_kind
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        item.id,
        item.session_id,
        item.turn_id,
        item.source,
        item.ts,
        item.nickname,
        item.gender,
        item.age,
        item.scene_id,
        item.text,
        item.status,
        item.note,
        item.updated_at,
        item.updated_by,
        item.ip_hash,
        item.account_id,
        item.theme,
        item.emotion,
        item.adoption_kind,
      );

    return item;
  }

  /**
   * 列出反馈。
   * - 不传 accountId（现有 admin 调用）→ 全量（向后兼容，行为不变）。
   * - 传 accountId（Step 3 parent 视角）→ 仅该账号的反馈。
   */
  list(accountId?: string | null): FeedbackItem[] {
    const base = `SELECT ${SELECT_COLS} FROM feedback_items`;
    const rows = (
      accountId
        ? this.db.prepare(`${base} WHERE account_id = ? ORDER BY ts DESC`).all(accountId)
        : this.db.prepare(`${base} ORDER BY ts DESC`).all()
    ) as FeedbackRow[];

    return rows
      .map((row) => toFeedbackItem(row))
      .filter((item): item is FeedbackItem => item !== null);
  }

  updateStatus(id: string, input: FeedbackUpdateInput): FeedbackItem | null {
    const current = this.getById(id);
    if (!current) return null;

    const nextStatus = input.status ?? current.status;
    const nextNote = typeof input.note === 'string' ? input.note : current.note;
    const nextUpdatedBy = input.updatedBy?.trim() || current.updated_by;
    const nextTheme: FeedbackTheme = input.theme !== undefined ? normalizeTheme(input.theme) : current.theme;
    const nextEmotion: FeedbackEmotion =
      input.emotion !== undefined ? normalizeEmotion(input.emotion) : current.emotion;
    // adoption_kind 三态：undefined=保持原值；null=显式清空；'普通'/'重点'=写入
    let nextAdoptionKind: FeedbackAdoptionKind | null;
    if (input.adoptionKind === undefined) {
      nextAdoptionKind = current.adoption_kind;
    } else if (input.adoptionKind === null) {
      nextAdoptionKind = null;
    } else {
      nextAdoptionKind = normalizeAdoptionKind(input.adoptionKind);
    }
    // 一致性兜底：status≠已采纳 时强制清空 adoption_kind（防止前端漏清）
    if (nextStatus !== '已采纳') {
      nextAdoptionKind = null;
    }
    const nextUpdatedAt = Date.now();

    this.db
      .prepare(`
        UPDATE feedback_items
        SET status = ?, note = ?, theme = ?, emotion = ?, adoption_kind = ?,
            updated_at = ?, updated_by = ?
        WHERE id = ?
      `)
      .run(
        nextStatus,
        nextNote,
        nextTheme,
        nextEmotion,
        nextAdoptionKind,
        nextUpdatedAt,
        nextUpdatedBy,
        id,
      );

    return this.getById(id);
  }

  private getById(id: string): FeedbackItem | null {
    const row = this.db
      .prepare(`SELECT ${SELECT_COLS} FROM feedback_items WHERE id = ?`)
      .get(id) as FeedbackRow | undefined;

    return toFeedbackItem(row);
  }

  private findDuplicate(sessionId: string, text: string, minTs: number): FeedbackItem | null {
    const row = this.db
      .prepare(`
        SELECT ${SELECT_COLS}
        FROM feedback_items
        WHERE session_id = ? AND text = ? AND ts >= ?
        ORDER BY ts DESC
        LIMIT 1
      `)
      .get(sessionId, text, minTs) as FeedbackRow | undefined;

    return toFeedbackItem(row);
  }
}

export const feedbackStore = new FeedbackStore();
