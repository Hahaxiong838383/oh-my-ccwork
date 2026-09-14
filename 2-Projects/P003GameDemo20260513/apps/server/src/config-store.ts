import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * 设备运行配置数据层（联调合同 CC_P003_POSTURE_COOLDOWN_REMOTE_CONFIG_HANDOFF_20260821 + cc 回执）。
 * 独立库 config.db（分库哲学）。通用通道：坐姿冷却是第一个键，将来加域 = KEYS 注册表加行。
 *
 * revision 语义（回执 §2 冻结）：
 *  - config_meta.seq 单调递增，全局默认或任一 SN 覆盖的每次保存/清除都 bump；
 *  - 设备有效 revision = cfg-<max(全局各键最大 rev, 本 SN 各键最大 rev)>；
 *  - 清除覆盖写 tombstone（value_json='null'）而非删行——否则本 SN rev 材料消失，revision 会倒退。
 * 快照语义：完整快照必含全部注册键；无任何配置时给内置默认（revision cfg-0）。
 */

export type KeySpec = {
  builtinDefault: number;
  validate: (v: unknown) => boolean;
  /** admin 通用渲染用的展示元数据；min/max 只做提示与前端预校验，真门在 validate */
  label: string;
  unit: 'sec' | 'day';
  hint: string;
  min: number;
  max: number;
  /** server 自用键：不进设备快照、不参与设备 revision（设备合同键集与 revision 语义原样不动） */
  serverOnly?: boolean;
};

// 键注册表：点分路径 → 快照嵌套位置；校验规则挂键上（route 与 store 共用同一门）
// ⚠️ 顺序即 admin 展示顺序；设备合同键在前，server 自用键在后。
export const CONFIG_KEYS: Record<string, KeySpec> = {
  'posture.reminder_cooldown_sec': {
    builtinDefault: 900,
    validate: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 10 && v <= 86400,
    label: '坐姿提醒冷却时间',
    unit: 'sec',
    hint: '两次坐姿提醒的最短间隔',
    min: 10,
    max: 86400,
  },
  // 本地人格音频保底刷新（2026-09-03 川哥定）：触发式重生成之外，超过 N 天没出新套就主动重生成一次（哪怕变化很小）。
  // 只有 server 每日批读它（local-audio-generator），设备不需要 → serverOnly。
  'local_audio.refresh_days': {
    builtinDefault: 3,
    validate: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 30,
    label: '本地音频保底刷新天数',
    unit: 'day',
    hint: '超过这么多天没有新的本地音频套，每日批就主动重生成一次（触发式重生成照常）',
    min: 1,
    max: 30,
    serverOnly: true,
  },
};

/** 校验失败的统一提示文案（route 复用，随键表走，别再手写范围） */
export function invalidValueMessage(key: string): string {
  const s = CONFIG_KEYS[key];
  if (!s) return '取值不合法';
  return `取值须为 ${s.min}~${s.max} 的整数${s.unit === 'sec' ? '秒' : '天'}`;
}

export const CONFIG_SCHEMA_VERSION = 1;

const GLOBAL_SCOPE = '(global)';
const DEFAULT_DB_PATH = './data/config.db';

export type RuntimeFlag = { key: string; value: string; updated_at: number; updated_by: string; note: string };

// ── 下一版待办（2026-09-14 川哥：「版本与 One-shot」里记 v1.2 待更新内容，后续相关待办都加进来，每次版本更新有来源）──
export const RELEASE_TODO_STATUSES = ['open', 'done', 'dropped'] as const;
export type ReleaseTodoStatus = (typeof RELEASE_TODO_STATUSES)[number];
export const RELEASE_TODO_OWNERS = ['cc', 'codex', '川哥', '其它'] as const;
export type ReleaseTodoOwner = (typeof RELEASE_TODO_OWNERS)[number];
export type ReleaseTodo = {
  id: number;
  target: string; // 目标版本标签，如 v1.2
  text: string; // 要更新什么（≤300 字）
  source: string; // 来源：回执/分支/排查稿/日期（≤200 字）
  owner: ReleaseTodoOwner;
  status: ReleaseTodoStatus;
  created_by: string;
  created_at: number;
  updated_by: string;
  updated_at: number;
  done_at: number | null;
};

export type ConfigRow = {
  scope: string;
  key: string;
  value_json: string;
  rev: number;
  updated_at: number;
};

function resolveDbPath(): string {
  const raw = process.env.CONFIG_DB_PATH?.trim() || DEFAULT_DB_PATH;
  return resolve(process.cwd(), raw);
}

class ConfigStore {
  private readonly db: DatabaseSync;

  constructor() {
    const dbPath = resolveDbPath();
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS device_config (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        rev INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope, key)
      );
      CREATE TABLE IF NOT EXISTS config_meta (
        k TEXT PRIMARY KEY,
        v INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime_flag (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        updated_by TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS release_todo (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target TEXT NOT NULL DEFAULT 'v1.2',
        text TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT '',
        owner TEXT NOT NULL DEFAULT 'cc',
        status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','done','dropped')),
        created_by TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_by TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL,
        done_at INTEGER
      );
    `);
  }

  // ── 下一版待办：open 在前（按创建顺序），done/dropped 在后（按更新时间倒序）。只软删（dropped），来源永远可追。──
  listTodos(opts: { includeClosed?: boolean } = {}): ReleaseTodo[] {
    const where = opts.includeClosed ? '' : `WHERE status = 'open'`;
    return this.db
      .prepare(
        `SELECT * FROM release_todo ${where}
         ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'done' THEN 1 ELSE 2 END,
                  CASE status WHEN 'open' THEN created_at ELSE -updated_at END`,
      )
      .all() as ReleaseTodo[];
  }

  getTodo(id: number): ReleaseTodo | null {
    return (this.db.prepare(`SELECT * FROM release_todo WHERE id = ?`).get(id) as ReleaseTodo | undefined) ?? null;
  }

  addTodo(input: { target?: string; text: string; source?: string; owner?: ReleaseTodoOwner }, by: string): ReleaseTodo {
    const now = Date.now();
    const r = this.db
      .prepare(
        `INSERT INTO release_todo (target, text, source, owner, status, created_by, created_at, updated_by, updated_at)
         VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
      )
      .run(input.target?.trim() || 'v1.2', input.text.trim(), (input.source ?? '').trim(), input.owner ?? 'cc', by, now, by, now);
    return this.getTodo(Number(r.lastInsertRowid)) as ReleaseTodo;
  }

  /** 部分更新；status→done 记 done_at，→open 清 done_at。不存在返回 null。 */
  updateTodo(
    id: number,
    patch: Partial<{ target: string; text: string; source: string; owner: ReleaseTodoOwner; status: ReleaseTodoStatus }>,
    by: string,
  ): ReleaseTodo | null {
    const cur = this.getTodo(id);
    if (!cur) return null;
    const next = {
      target: patch.target !== undefined ? patch.target.trim() || cur.target : cur.target,
      text: patch.text !== undefined ? patch.text.trim() || cur.text : cur.text,
      source: patch.source !== undefined ? patch.source.trim() : cur.source,
      owner: patch.owner ?? cur.owner,
      status: patch.status ?? cur.status,
    };
    const now = Date.now();
    const doneAt = next.status === 'done' ? (cur.status === 'done' ? cur.done_at : now) : null;
    this.db
      .prepare(
        `UPDATE release_todo SET target = ?, text = ?, source = ?, owner = ?, status = ?, updated_by = ?, updated_at = ?, done_at = ?
         WHERE id = ?`,
      )
      .run(next.target, next.text, next.source, next.owner, next.status, by, now, doneAt, id);
    return this.getTodo(id);
  }

  // ── B89 运行时开关（2026-09-13 川哥：One-shot 关闭/回滚要在后台一键可点）──
  // 字符串值、带操作人/时间/备注；语义与合法值由调用方定义并校验（本层不认识 policy）。
  // 读取方每请求直查（一条主键 SELECT，WAL 下无锁争用），改后下一请求即生效，不需要重启。
  getFlag(key: string): RuntimeFlag | null {
    const row = this.db
      .prepare(`SELECT key, value, updated_at, updated_by, note FROM runtime_flag WHERE key = ?`)
      .get(key) as RuntimeFlag | undefined;
    return row ?? null;
  }

  setFlag(key: string, value: string, updatedBy: string, note = ''): RuntimeFlag {
    this.db
      .prepare(
        `INSERT INTO runtime_flag (key, value, updated_at, updated_by, note) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at,
           updated_by = excluded.updated_by, note = excluded.note`,
      )
      .run(key, value, Date.now(), updatedBy, note);
    return this.getFlag(key) as RuntimeFlag;
  }

  /** 删除覆盖，回落到调用方的下一层（env/内置）。返回是否真删了一行。 */
  clearFlag(key: string): boolean {
    const r = this.db.prepare(`DELETE FROM runtime_flag WHERE key = ?`).run(key);
    return Number(r.changes) > 0;
  }

  private nextSeq(): number {
    this.db
      .prepare(
        `INSERT INTO config_meta (k, v) VALUES ('seq', 1)
         ON CONFLICT(k) DO UPDATE SET v = v + 1`,
      )
      .run();
    const row = this.db.prepare(`SELECT v FROM config_meta WHERE k = 'seq'`).get() as { v: number };
    return row.v;
  }

  /** 保存值（scope=(global) 或 SN）。校验失败返回 null，成功返回新 rev。 */
  setValue(scope: string, key: string, value: unknown): number | null {
    const spec = CONFIG_KEYS[key];
    if (!spec || !spec.validate(value)) return null;
    const rev = this.nextSeq();
    this.db
      .prepare(
        `INSERT INTO device_config (scope, key, value_json, rev, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(scope, key) DO UPDATE SET value_json = excluded.value_json,
           rev = excluded.rev, updated_at = excluded.updated_at`,
      )
      .run(scope === GLOBAL_SCOPE ? GLOBAL_SCOPE : scope, key, JSON.stringify(value), rev, Date.now());
    return rev;
  }

  setGlobal(key: string, value: unknown): number | null {
    return this.setValue(GLOBAL_SCOPE, key, value);
  }

  /** 清除 SN 覆盖：写 tombstone（保 revision 单调），回落全局/内置。键未注册返回 null。 */
  clearForSn(sn: string, key: string): number | null {
    if (!CONFIG_KEYS[key]) return null;
    const rev = this.nextSeq();
    this.db
      .prepare(
        `INSERT INTO device_config (scope, key, value_json, rev, updated_at)
         VALUES (?, ?, 'null', ?, ?)
         ON CONFLICT(scope, key) DO UPDATE SET value_json = 'null',
           rev = excluded.rev, updated_at = excluded.updated_at`,
      )
      .run(sn, key, rev, Date.now());
    return rev;
  }

  private rowsFor(scope: string): ConfigRow[] {
    return this.db
      .prepare(`SELECT scope, key, value_json, rev, updated_at FROM device_config WHERE scope = ?`)
      .all(scope) as ConfigRow[];
  }

  /**
   * 设备有效快照（合同响应本体）。合成优先级：SN 覆盖 > 全局 > 内置默认；
   * tombstone（value_json='null'）视为无覆盖但 rev 参与 revision 计算。
   */
  effectiveSnapshot(sn: string): Record<string, unknown> {
    // server 自用键的行不参与设备 revision（否则改一个 server 键会让全部设备白重应用一次快照）
    const isDeviceRow = (r: ConfigRow) => !CONFIG_KEYS[r.key]?.serverOnly;
    const globalRows = this.rowsFor(GLOBAL_SCOPE).filter(isDeviceRow);
    const snRows = this.rowsFor(sn).filter(isDeviceRow);
    let maxRev = 0;
    for (const r of [...globalRows, ...snRows]) if (r.rev > maxRev) maxRev = r.rev;

    const globalByKey = new Map(globalRows.map((r) => [r.key, r]));
    const snByKey = new Map(snRows.map((r) => [r.key, r]));

    const snapshot: Record<string, unknown> = {
      schema_version: CONFIG_SCHEMA_VERSION,
      revision: `cfg-${maxRev}`,
    };
    for (const [key, spec] of Object.entries(CONFIG_KEYS)) {
      if (spec.serverOnly) continue; // 设备快照只含设备合同键
      let value: unknown = spec.builtinDefault;
      const g = globalByKey.get(key);
      if (g) {
        const parsed = JSON.parse(g.value_json);
        if (parsed !== null) value = parsed;
      }
      const s = snByKey.get(key);
      if (s) {
        const parsed = JSON.parse(s.value_json);
        if (parsed !== null) value = parsed;
      }
      // 点分路径 → 嵌套对象（posture.reminder_cooldown_sec → {posture:{reminder_cooldown_sec}}）
      const parts = key.split('.');
      let node = snapshot;
      for (const p of parts.slice(0, -1)) {
        if (typeof node[p] !== 'object' || node[p] === null) node[p] = {};
        node = node[p] as Record<string, unknown>;
      }
      node[parts.at(-1)!] = value;
    }
    return snapshot;
  }

  /** admin 总览：全局值（null=未配置走内置）+ 全部有效覆盖（tombstone 不列）。 */
  adminOverview(): {
    keys: Array<{
      key: string;
      builtin_default: number;
      global: unknown;
      global_updated_at: number | null;
      label: string;
      unit: string;
      hint: string;
      min: number;
      max: number;
      server_only: boolean;
    }>;
    overrides: Array<{ sn: string; key: string; value: unknown; updated_at: number }>;
  } {
    const globalByKey = new Map(this.rowsFor(GLOBAL_SCOPE).map((r) => [r.key, r]));
    const keys = Object.entries(CONFIG_KEYS).map(([key, spec]) => {
      const g = globalByKey.get(key);
      const parsed = g ? JSON.parse(g.value_json) : null;
      return {
        key,
        builtin_default: spec.builtinDefault,
        global: parsed,
        global_updated_at: g && parsed !== null ? g.updated_at : null,
        label: spec.label,
        unit: spec.unit,
        hint: spec.hint,
        min: spec.min,
        max: spec.max,
        server_only: spec.serverOnly === true,
      };
    });
    const overrides = (
      this.db
        .prepare(
          `SELECT scope, key, value_json, rev, updated_at FROM device_config
           WHERE scope != ? AND value_json != 'null' ORDER BY scope, key`,
        )
        .all(GLOBAL_SCOPE) as ConfigRow[]
    ).map((r) => ({ sn: r.scope, key: r.key, value: JSON.parse(r.value_json), updated_at: r.updated_at }));
    return { keys, overrides };
  }

  /** server 内部读有效值（SN 覆盖 > 全局 > 内置；tombstone 视为无覆盖）。scope 传 SN 原文（不带 device- 前缀）。 */
  getEffective(scope: string, key: string): number {
    const spec = CONFIG_KEYS[key];
    if (!spec) throw new Error(`unknown config key: ${key}`);
    let value: number = spec.builtinDefault;
    for (const s of [GLOBAL_SCOPE, scope]) {
      const row = this.db
        .prepare(`SELECT value_json FROM device_config WHERE scope = ? AND key = ?`)
        .get(s, key) as { value_json: string } | undefined;
      if (!row) continue;
      const parsed = JSON.parse(row.value_json);
      if (typeof parsed === 'number') value = parsed;
    }
    return value;
  }
}

export const configStore = new ConfigStore();
