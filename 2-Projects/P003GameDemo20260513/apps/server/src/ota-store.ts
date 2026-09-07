import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * OTA 数据层（联调合同 CC_P003_OTA_JOINT_CONTRACT_20260820 + 冻结回执）。
 * 独立库 ota.db（分库哲学）。两表：
 *  - ota_release：版本发布记录（APK 实测元数据 + 灰度规则 + enabled）
 *  - ota_device_status：设备版本/回报台账（check 上报白送的全量版本分布）
 *
 * 灰度语义：enabled=1 且（rollout_sns 空 = 全量放量；否则名单命中）。
 * 空名单=全量是显式发布动作的结果（admin publish 必须传 rollout:'all' 才落空名单），
 * 不存在「忘了填名单误全量」路径。
 * 防降级铁律：resolveUpdate 只返回 version_code 严格大于设备上报值的 release。
 */

export type OtaRelease = {
  version_code: number;
  version_name: string;
  package_name: string;
  apk_path: string;
  url_path: string;
  sha256: string;
  size_bytes: number;
  cert_sha256: string;
  force_install: number;
  install_hint: string;
  notes: string;
  channel: string;
  enabled: number;
  rollout_sns: string;
  created_at: number;
  updated_at: number;
};

export type OtaDeviceStatus = {
  sn: string;
  version_code: number;
  version_name: string;
  last_check_at: number;
  last_result_json: string;
  updated_at: number;
};

const DEFAULT_DB_PATH = './data/ota.db';

function resolveDbPath(): string {
  const raw = process.env.OTA_DB_PATH?.trim() || DEFAULT_DB_PATH;
  return resolve(process.cwd(), raw);
}

class OtaStore {
  private readonly db: DatabaseSync;

  constructor() {
    const dbPath = resolveDbPath();
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ota_release (
        version_code INTEGER PRIMARY KEY,
        version_name TEXT NOT NULL,
        package_name TEXT NOT NULL,
        apk_path TEXT NOT NULL,
        url_path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        cert_sha256 TEXT NOT NULL,
        force_install INTEGER NOT NULL DEFAULT 0,
        install_hint TEXT NOT NULL DEFAULT 'idle_only',
        notes TEXT NOT NULL DEFAULT '',
        channel TEXT NOT NULL DEFAULT 'stable',
        enabled INTEGER NOT NULL DEFAULT 0,
        rollout_sns TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ota_device_status (
        sn TEXT PRIMARY KEY,
        version_code INTEGER NOT NULL,
        version_name TEXT NOT NULL DEFAULT '',
        last_check_at INTEGER NOT NULL,
        last_result_json TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ota_status_version ON ota_device_status (version_code);
    `);
  }

  insertRelease(r: Omit<OtaRelease, 'created_at' | 'updated_at'>): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO ota_release (version_code, version_name, package_name, apk_path, url_path, sha256,
         size_bytes, cert_sha256, force_install, install_hint, notes, channel, enabled, rollout_sns, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.version_code, r.version_name, r.package_name, r.apk_path, r.url_path, r.sha256,
        r.size_bytes, r.cert_sha256, r.force_install, r.install_hint, r.notes, r.channel,
        r.enabled, r.rollout_sns, now, now,
      );
  }

  getRelease(versionCode: number): OtaRelease | null {
    const row = this.db.prepare(`SELECT * FROM ota_release WHERE version_code = ?`).get(versionCode) as
      | OtaRelease
      | undefined;
    return row ?? null;
  }

  listReleases(): OtaRelease[] {
    return this.db.prepare(`SELECT * FROM ota_release ORDER BY version_code DESC`).all() as OtaRelease[];
  }

  maxVersionCode(): number {
    const row = this.db.prepare(`SELECT MAX(version_code) AS m FROM ota_release`).get() as { m: number | null };
    return row?.m ?? 0;
  }

  /** 发布/调整灰度。rolloutSns=''（配合显式 rollout:'all'）= 全量。 */
  publish(versionCode: number, rolloutSns: string, force: boolean, installHint: string): boolean {
    const r = this.db
      .prepare(`UPDATE ota_release SET enabled = 1, rollout_sns = ?, force_install = ?, install_hint = ?, updated_at = ? WHERE version_code = ?`)
      .run(rolloutSns, force ? 1 : 0, installHint, Date.now(), versionCode);
    return Number(r.changes) > 0;
  }

  /** 更新说明可在任何状态改（文档不是字节/策略）。2026-09-07 川哥：后台每版要能看到更新了什么、解决了什么。 */
  updateNotes(versionCode: number, notes: string): boolean {
    const r = this.db
      .prepare(`UPDATE ota_release SET notes = ?, updated_at = ? WHERE version_code = ?`)
      .run(notes, Date.now(), versionCode);
    return Number(r.changes) > 0;
  }

  pause(versionCode: number): boolean {
    const r = this.db
      .prepare(`UPDATE ota_release SET enabled = 0, updated_at = ? WHERE version_code = ?`)
      .run(Date.now(), versionCode);
    return Number(r.changes) > 0;
  }

  /** 删除记录（仅草稿/已暂停；文件删除由调用方负责）。 */
  deleteRelease(versionCode: number): boolean {
    const r = this.db.prepare(`DELETE FROM ota_release WHERE version_code = ? AND enabled = 0`).run(versionCode);
    return Number(r.changes) > 0;
  }

  /**
   * 升级裁决（设备 check 核心）：enabled=1、version_code 严格大于设备当前值、灰度命中，
   * 多个命中取最大 version_code。无命中 → null。
   */
  resolveUpdate(sn: string, currentVersionCode: number): OtaRelease | null {
    const rows = this.db
      .prepare(`SELECT * FROM ota_release WHERE enabled = 1 AND version_code > ? ORDER BY version_code DESC`)
      .all(currentVersionCode) as OtaRelease[];
    for (const r of rows) {
      const sns = r.rollout_sns
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (sns.length === 0 || sns.includes(sn)) return r;
    }
    return null;
  }

  /** check 上报落库：版本无条件 upsert；lastResultJson 传 null 保留旧值。 */
  reportCheck(sn: string, versionCode: number, versionName: string, lastResultJson: string | null): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO ota_device_status (sn, version_code, version_name, last_check_at, last_result_json, updated_at)
         VALUES (?, ?, ?, ?, COALESCE(?, ''), ?)
         ON CONFLICT(sn) DO UPDATE SET
           version_code = excluded.version_code,
           version_name = excluded.version_name,
           last_check_at = excluded.last_check_at,
           last_result_json = COALESCE(?, ota_device_status.last_result_json),
           updated_at = excluded.updated_at`,
      )
      .run(sn, versionCode, versionName, now, lastResultJson, now, lastResultJson);
  }

  listDeviceStatus(): OtaDeviceStatus[] {
    return this.db.prepare(`SELECT * FROM ota_device_status ORDER BY updated_at DESC`).all() as OtaDeviceStatus[];
  }
}

export const otaStore = new OtaStore();
