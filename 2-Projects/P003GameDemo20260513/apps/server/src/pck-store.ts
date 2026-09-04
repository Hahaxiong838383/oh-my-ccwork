import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * PCK（Godot 非执行内容包）OTA 数据层——双 OTA 合同 §7「四类独立实体」，与 APK 表完全分账，
 * 同库 ota.db 不同表；PCK 不借用 APK 的 version_code / ota_device_status / 安装成功字段。
 *
 *  - pck_release        不可变发布记录（content_id+content_version 唯一；字节按 sha256 内容寻址；
 *                       同版本不同 SHA 在入口拒绝；修复=新 revision，回滚=用旧字节建新 revision）
 *  - pck_rollout        可变发布策略（none / sns / all + 名单 + 发布/暂停/撤回时刻）
 *  - pck_device_status  每台设备当前投影（active/pending/stage/last_* / 冻结）
 *  - pck_report_log     append-only 事件流水（设备时间 + 服务端时间双钟；success 永不覆盖失败/回滚证据）
 *
 * 成功终态只有 confirmed+success（Godot ready 后）；staged/activated 都不算成功（合同 §3.5 / §4.1）。
 */

export type PckStatus = 'draft' | 'published' | 'paused' | 'revoked';
export type RolloutPolicy = 'none' | 'sns' | 'all';
export const PCK_STAGES = ['offered', 'downloading', 'downloaded', 'verified', 'staged', 'waiting_reboot', 'activated', 'confirmed', 'rolled_back', 'failed'] as const;
export type PckStage = (typeof PCK_STAGES)[number];

export type PckRelease = {
  id: number;
  content_id: string;
  content_version: string;
  product_models: string; // JSON string[]
  min_launcher_version_code: number;
  length: number;
  sha256: string;
  file_path: string;
  required_resources: string; // JSON string[]
  release_notes: string; // JSON string[]
  force: number;
  status: PckStatus;
  rollback_of: number | null;
  /** 发布身份序号（2026-09-04 codex §8 纵深防御）：每次 publish 分配严格递增，含回滚 revision；草稿为 null。
   *  设备/服务端一律拒绝 sequence ≤ 现役 sequence 的不同版本——降级只能走「更高 sequence 的 rollback revision」。 */
  release_sequence: number | null;
  godot_version: string;
  file_count: number;
  created_at: number;
  updated_at: number;
};

export type TransitionKind = 'upgrade' | 'rollback';
/** rollback_of 只作审计来源；transition_kind 由它派生，不授权直接下发旧 sequence。 */
export function transitionKind(r: Pick<PckRelease, 'rollback_of'>): TransitionKind {
  return r.rollback_of !== null && r.rollback_of !== undefined ? 'rollback' : 'upgrade';
}

export type PckRollout = {
  release_id: number;
  policy: RolloutPolicy;
  sns: string;
  published_at: number | null;
  paused_at: number | null;
  revoked_at: number | null;
  updated_at: number;
};

export type PckDeviceStatus = {
  sn: string;
  content_id: string;
  product_model: string;
  launcher_version_code: number;
  active_content_version: string | null;
  active_sha256: string | null;
  pending_content_version: string | null;
  activation_state: string;
  last_check_at: number;
  last_offer_release_id: number | null;
  last_offer_at: number | null;
  last_decision: string;
  last_result_json: string;
  last_failure_json: string;
  last_rollback_json: string;
  frozen: number;
  updated_at: number;
};

export type PckReportRow = {
  id: number;
  sn: string;
  ts_server: number;
  source: 'device' | 'server';
  content_id: string;
  from_version: string;
  to_version: string;
  stage: string;
  status: string;
  error_code: string;
  result_ts_ms: number | null;
  note: string;
};

const DEFAULT_DB_PATH = './data/ota.db';

function resolveDbPath(): string {
  const raw = process.env.OTA_DB_PATH?.trim() || DEFAULT_DB_PATH;
  return resolve(process.cwd(), raw);
}

export function parseSns(csv: string): string[] {
  return csv.split(',').map((s) => s.trim()).filter(Boolean);
}

class PckStore {
  private readonly db: DatabaseSync;

  constructor() {
    const dbPath = resolveDbPath();
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pck_release (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_id TEXT NOT NULL,
        content_version TEXT NOT NULL,
        product_models TEXT NOT NULL DEFAULT '[]',
        min_launcher_version_code INTEGER NOT NULL DEFAULT 0,
        length INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        file_path TEXT NOT NULL,
        required_resources TEXT NOT NULL DEFAULT '[]',
        release_notes TEXT NOT NULL DEFAULT '[]',
        force INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'draft',
        rollback_of INTEGER,
        godot_version TEXT NOT NULL DEFAULT '',
        file_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (content_id, content_version)
      );
      CREATE INDEX IF NOT EXISTS idx_pck_release_sha ON pck_release (sha256);
      CREATE TABLE IF NOT EXISTS pck_rollout (
        release_id INTEGER PRIMARY KEY,
        policy TEXT NOT NULL DEFAULT 'none',
        sns TEXT NOT NULL DEFAULT '',
        published_at INTEGER,
        paused_at INTEGER,
        revoked_at INTEGER,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pck_device_status (
        sn TEXT PRIMARY KEY,
        content_id TEXT NOT NULL DEFAULT '',
        product_model TEXT NOT NULL DEFAULT '',
        launcher_version_code INTEGER NOT NULL DEFAULT 0,
        active_content_version TEXT,
        active_sha256 TEXT,
        pending_content_version TEXT,
        activation_state TEXT NOT NULL DEFAULT '',
        last_check_at INTEGER NOT NULL DEFAULT 0,
        last_offer_release_id INTEGER,
        last_offer_at INTEGER,
        last_decision TEXT NOT NULL DEFAULT '',
        last_result_json TEXT NOT NULL DEFAULT '',
        last_failure_json TEXT NOT NULL DEFAULT '',
        last_rollback_json TEXT NOT NULL DEFAULT '',
        frozen INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pck_report_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sn TEXT NOT NULL,
        ts_server INTEGER NOT NULL,
        source TEXT NOT NULL,
        content_id TEXT NOT NULL DEFAULT '',
        from_version TEXT NOT NULL DEFAULT '',
        to_version TEXT NOT NULL DEFAULT '',
        stage TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT '',
        error_code TEXT NOT NULL DEFAULT '',
        result_ts_ms INTEGER,
        note TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_pck_report_sn ON pck_report_log (sn, id);
    `);
    this.migrateReleaseSequence();
  }

  /** 加列 release_sequence（幂等）+ 回填：历史上发布过的（published_at 非空）按发布时间升序编号，草稿保持 null。 */
  private migrateReleaseSequence(): void {
    const cols = this.db.prepare(`PRAGMA table_info(pck_release)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'release_sequence')) {
      this.db.exec(`ALTER TABLE pck_release ADD COLUMN release_sequence INTEGER`);
    }
    const pending = this.db
      .prepare(
        `SELECT r.id FROM pck_release r JOIN pck_rollout o ON o.release_id = r.id
         WHERE r.release_sequence IS NULL AND o.published_at IS NOT NULL ORDER BY o.published_at ASC, r.id ASC`,
      )
      .all() as Array<{ id: number }>;
    for (const row of pending) {
      const seq = this.nextSequence();
      this.db.prepare(`UPDATE pck_release SET release_sequence = ? WHERE id = ? AND release_sequence IS NULL`).run(seq, row.id);
      console.log(`[pck] backfill release_sequence release#${row.id} seq=${seq}`);
    }
  }

  private nextSequence(): number {
    const row = this.db.prepare(`SELECT COALESCE(MAX(release_sequence), 0) AS m FROM pck_release`).get() as { m: number };
    return (row?.m ?? 0) + 1;
  }

  // ── release ──
  /** 入库恒为草稿、无序号（release_sequence 只在 publish 时分配）。 */
  insertRelease(r: Omit<PckRelease, 'id' | 'created_at' | 'updated_at' | 'release_sequence'> & { release_sequence?: null }): PckRelease {
    const now = Date.now();
    const res = this.db
      .prepare(
        `INSERT INTO pck_release (content_id, content_version, product_models, min_launcher_version_code, length, sha256, file_path,
         required_resources, release_notes, force, status, rollback_of, godot_version, file_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.content_id, r.content_version, r.product_models, r.min_launcher_version_code, r.length, r.sha256, r.file_path,
        r.required_resources, r.release_notes, r.force, r.status, r.rollback_of, r.godot_version, r.file_count, now, now,
      );
    const id = Number(res.lastInsertRowid);
    this.db.prepare(`INSERT INTO pck_rollout (release_id, policy, sns, updated_at) VALUES (?, 'none', '', ?)`).run(id, now);
    return this.getRelease(id)!;
  }

  getRelease(id: number): PckRelease | null {
    return (this.db.prepare(`SELECT * FROM pck_release WHERE id = ?`).get(id) as PckRelease | undefined) ?? null;
  }

  getByVersion(contentId: string, version: string): PckRelease | null {
    return (this.db.prepare(`SELECT * FROM pck_release WHERE content_id = ? AND content_version = ?`).get(contentId, version) as PckRelease | undefined) ?? null;
  }

  listReleases(): Array<PckRelease & { rollout: PckRollout }> {
    const rows = this.db.prepare(`SELECT * FROM pck_release ORDER BY id DESC`).all() as unknown as PckRelease[];
    return rows.map((r) => ({ ...r, rollout: this.getRollout(r.id)! }));
  }

  listBySha(sha256: string): PckRelease[] {
    return this.db.prepare(`SELECT * FROM pck_release WHERE sha256 = ?`).all(sha256) as unknown as PckRelease[];
  }

  /** 草稿期元数据可改（字节不可改）。 */
  updateMeta(id: number, m: Partial<Pick<PckRelease, 'product_models' | 'min_launcher_version_code' | 'required_resources' | 'release_notes' | 'force'>>): boolean {
    const cur = this.getRelease(id);
    if (!cur || cur.status !== 'draft') return false;
    const next = { ...cur, ...m };
    const r = this.db
      .prepare(`UPDATE pck_release SET product_models = ?, min_launcher_version_code = ?, required_resources = ?, release_notes = ?, force = ?, updated_at = ? WHERE id = ? AND status = 'draft'`)
      .run(next.product_models, next.min_launcher_version_code, next.required_resources, next.release_notes, next.force, Date.now(), id);
    return Number(r.changes) > 0;
  }

  setStatus(id: number, status: PckStatus): void {
    this.db.prepare(`UPDATE pck_release SET status = ?, updated_at = ? WHERE id = ?`).run(status, Date.now(), id);
  }

  /** 只删草稿或已撤回（撤回版对设备已是 410，删记录不改变任何设备可见状态；流水按版本串保留审计）。 */
  deleteDraft(id: number): boolean {
    const r = this.db.prepare(`DELETE FROM pck_release WHERE id = ? AND status IN ('draft', 'revoked')`).run(id);
    if (Number(r.changes) > 0) this.db.prepare(`DELETE FROM pck_rollout WHERE release_id = ?`).run(id);
    return Number(r.changes) > 0;
  }

  // ── rollout ──
  getRollout(id: number): PckRollout | null {
    return (this.db.prepare(`SELECT * FROM pck_rollout WHERE release_id = ?`).get(id) as PckRollout | undefined) ?? null;
  }

  /** 发布：首次发布分配 release_sequence（严格递增、全表唯一）；同一 release 再次 publish（改名单）不换号。 */
  publish(id: number, policy: 'sns' | 'all', sns: string[]): number {
    const now = Date.now();
    this.db
      .prepare(`UPDATE pck_rollout SET policy = ?, sns = ?, published_at = COALESCE(published_at, ?), paused_at = NULL, updated_at = ? WHERE release_id = ?`)
      .run(policy, policy === 'all' ? '' : sns.join(','), now, now, id);
    const cur = this.getRelease(id);
    let seq = cur?.release_sequence ?? null;
    if (seq === null) {
      seq = this.nextSequence();
      this.db.prepare(`UPDATE pck_release SET release_sequence = ? WHERE id = ? AND release_sequence IS NULL`).run(seq, id);
    }
    this.setStatus(id, 'published');
    return seq;
  }

  pause(id: number): void {
    const now = Date.now();
    this.db.prepare(`UPDATE pck_rollout SET paused_at = ?, updated_at = ? WHERE release_id = ?`).run(now, now, id);
    this.setStatus(id, 'paused');
  }

  resume(id: number): void {
    const now = Date.now();
    this.db.prepare(`UPDATE pck_rollout SET paused_at = NULL, updated_at = ? WHERE release_id = ?`).run(now, id);
    this.setStatus(id, 'published');
  }

  revoke(id: number): void {
    const now = Date.now();
    this.db.prepare(`UPDATE pck_rollout SET policy = 'none', sns = '', revoked_at = ?, updated_at = ? WHERE release_id = ?`).run(now, now, id);
    this.setStatus(id, 'revoked');
  }

  /** 已发布且未暂停/撤回的候选，按 release_sequence 倒序（最新发布身份优先；旧库无号的按发布时间兜底）。 */
  publishedCandidates(contentId: string): Array<PckRelease & { rollout: PckRollout }> {
    const rows = this.db
      .prepare(
        `SELECT r.* FROM pck_release r JOIN pck_rollout o ON o.release_id = r.id
         WHERE r.content_id = ? AND r.status = 'published' AND o.policy != 'none' AND o.paused_at IS NULL AND o.revoked_at IS NULL
         ORDER BY r.release_sequence DESC, o.published_at DESC, r.id DESC`,
      )
      .all(contentId) as unknown as PckRelease[];
    return rows.map((r) => ({ ...r, rollout: this.getRollout(r.id)! }));
  }

  // ── device status projection ──
  getDevice(sn: string): PckDeviceStatus | null {
    return (this.db.prepare(`SELECT * FROM pck_device_status WHERE sn = ?`).get(sn) as PckDeviceStatus | undefined) ?? null;
  }

  listDevices(): PckDeviceStatus[] {
    return this.db.prepare(`SELECT * FROM pck_device_status ORDER BY updated_at DESC`).all() as unknown as PckDeviceStatus[];
  }

  /** 每次 check 的快照落投影（不碰 last_* 证据字段）。 */
  reportState(sn: string, s: { content_id: string; product_model: string; launcher_version_code: number; active_content_version: string | null; active_sha256: string | null; pending_content_version: string | null; activation_state: string }): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO pck_device_status (sn, content_id, product_model, launcher_version_code, active_content_version, active_sha256, pending_content_version, activation_state, last_check_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(sn) DO UPDATE SET content_id = excluded.content_id, product_model = excluded.product_model, launcher_version_code = excluded.launcher_version_code,
           active_content_version = excluded.active_content_version, active_sha256 = excluded.active_sha256, pending_content_version = excluded.pending_content_version,
           activation_state = excluded.activation_state, last_check_at = excluded.last_check_at, updated_at = excluded.updated_at`,
      )
      .run(sn, s.content_id, s.product_model, s.launcher_version_code, s.active_content_version, s.active_sha256, s.pending_content_version, s.activation_state, now, now);
  }

  /** 无 content_state 的旧客户端也留一行（只记 check 时刻与 launcher 版本），便于后台看「谁还没上新客户端」。 */
  touchLegacy(sn: string, launcherVersionCode: number): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO pck_device_status (sn, launcher_version_code, last_check_at, last_decision, updated_at) VALUES (?, ?, ?, 'legacy_client', ?)
         ON CONFLICT(sn) DO UPDATE SET launcher_version_code = excluded.launcher_version_code, last_check_at = excluded.last_check_at, last_decision = 'legacy_client', updated_at = excluded.updated_at`,
      )
      .run(sn, launcherVersionCode, now, now);
  }

  recordDecision(sn: string, decision: string, offerReleaseId: number | null): void {
    const now = Date.now();
    if (offerReleaseId !== null) {
      this.db.prepare(`UPDATE pck_device_status SET last_decision = ?, last_offer_release_id = ?, last_offer_at = ?, updated_at = ? WHERE sn = ?`).run(decision, offerReleaseId, now, now, sn);
    } else {
      this.db.prepare(`UPDATE pck_device_status SET last_decision = ?, updated_at = ? WHERE sn = ?`).run(decision, now, sn);
    }
  }

  /** 设备回报：流水 append-only；投影 last_result 覆盖式，但失败/回滚证据各自单独保留（success 不覆盖它们）。 */
  recordResult(sn: string, r: { content_id: string; from_version: string; to_version: string; stage: string; status: string; error_code: string; result_ts_ms: number | null }): number {
    const now = Date.now();
    const res = this.db
      .prepare(`INSERT INTO pck_report_log (sn, ts_server, source, content_id, from_version, to_version, stage, status, error_code, result_ts_ms, note) VALUES (?, ?, 'device', ?, ?, ?, ?, ?, ?, ?, '')`)
      .run(sn, now, r.content_id, r.from_version, r.to_version, r.stage, r.status, r.error_code, r.result_ts_ms);
    const json = JSON.stringify({ ...r, server_received_ms: now });
    this.db.prepare(`INSERT OR IGNORE INTO pck_device_status (sn, updated_at) VALUES (?, ?)`).run(sn, now);
    this.db.prepare(`UPDATE pck_device_status SET last_result_json = ?, updated_at = ? WHERE sn = ?`).run(json, now, sn);
    if (r.stage === 'failed' || r.status === 'failed') this.db.prepare(`UPDATE pck_device_status SET last_failure_json = ? WHERE sn = ?`).run(json, sn);
    if (r.stage === 'rolled_back') this.db.prepare(`UPDATE pck_device_status SET last_rollback_json = ? WHERE sn = ?`).run(json, sn);
    return Number(res.lastInsertRowid);
  }

  logServer(sn: string, contentId: string, stage: string, status: string, note: string, toVersion = ''): void {
    this.db
      .prepare(`INSERT INTO pck_report_log (sn, ts_server, source, content_id, from_version, to_version, stage, status, error_code, result_ts_ms, note) VALUES (?, ?, 'server', ?, '', ?, ?, ?, '', NULL, ?)`)
      .run(sn, Date.now(), contentId, toVersion, stage, status, note.slice(0, 200));
  }

  setFrozen(sn: string, frozen: boolean): void {
    const now = Date.now();
    this.db.prepare(`INSERT OR IGNORE INTO pck_device_status (sn, updated_at) VALUES (?, ?)`).run(sn, now);
    this.db.prepare(`UPDATE pck_device_status SET frozen = ?, updated_at = ? WHERE sn = ?`).run(frozen ? 1 : 0, now, sn);
  }

  listLog(sn: string, limit = 50): PckReportRow[] {
    return this.db.prepare(`SELECT * FROM pck_report_log WHERE sn = ? ORDER BY id DESC LIMIT ?`).all(sn, limit) as unknown as PckReportRow[];
  }

  countDevicesOnVersion(version: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM pck_device_status WHERE active_content_version = ?`).get(version) as { n: number };
    return row?.n ?? 0;
  }
}

export const pckStore = new PckStore();
