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

type KeySpec = {
  builtinDefault: number;
  validate: (v: unknown) => boolean;
};

// 键注册表：点分路径 → 快照嵌套位置；校验规则挂键上（route 与 store 共用同一门）
export const CONFIG_KEYS: Record<string, KeySpec> = {
  'posture.reminder_cooldown_sec': {
    builtinDefault: 900,
    validate: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 10 && v <= 86400,
  },
};

export const CONFIG_SCHEMA_VERSION = 1;

const GLOBAL_SCOPE = '(global)';
const DEFAULT_DB_PATH = './data/config.db';

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
    `);
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
    const globalRows = this.rowsFor(GLOBAL_SCOPE);
    const snRows = this.rowsFor(sn);
    let maxRev = 0;
    for (const r of [...globalRows, ...snRows]) if (r.rev > maxRev) maxRev = r.rev;

    const globalByKey = new Map(globalRows.map((r) => [r.key, r]));
    const snByKey = new Map(snRows.map((r) => [r.key, r]));

    const snapshot: Record<string, unknown> = {
      schema_version: CONFIG_SCHEMA_VERSION,
      revision: `cfg-${maxRev}`,
    };
    for (const [key, spec] of Object.entries(CONFIG_KEYS)) {
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
    keys: Array<{ key: string; builtin_default: number; global: unknown; global_updated_at: number | null }>;
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
}

export const configStore = new ConfigStore();
