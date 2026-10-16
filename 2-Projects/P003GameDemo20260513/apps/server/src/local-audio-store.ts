import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync, openSync, closeSync, fsyncSync, linkSync, lstatSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * 本地人格音频 store（合同 CODEX_P003_LOCAL_AUDIO_CONTRACT_v1.1 + codex 回执四修订）。
 *
 * 持久化两张表（profile.db，与 persona 家族同库）+ 音频文件（data/local-audio/<account>/<id>.mp3）：
 *  - local_audio_state：per-account 单行（revision 单调 / 生成基准快照 / 设备触达回执）。
 *  - local_audio_item：条目（active=1 为当前套成员；替换后旧条目 active=0 保留 14 天供
 *    切换窗口期的设备继续下载，之后 cleanup 删行+删文件）。
 *
 * 旧 id = 音频 sha256 前 16 hex；所有 ID 的元信息与字节均不可变；复用语义（codex J4）：
 * 重生成时同 slot 同 text 的旧条目直接复活 active=1，不重合成（TTS 非确定性，重合成=白换 id）。
 */

export { LOCAL_AUDIO_SLOTS, DEVICE_REPLY_SLOTS, G1_SETTINGS_SLOTS, REQUIRED_SLOTS, MIN_ITEMS_PER_SLOT } from './local-audio-integrity.js';
export type { LocalAudioSlot, DeviceReplySlot, G1SettingsSlot, AnyAudioSlot, LocalAudioItem } from './local-audio-integrity.js';
import { type LocalAudioItem, type AnyAudioSlot, assertLocalAudioWritesAllowed, deriveClipId, sha256, fail, sameClipMetadata, validateClipBytes, validatePublicationItems } from './local-audio-integrity.js';
const STALE_ITEM_TTL_MS = 14 * 86_400_000;

export type LocalAudioState = {
  account_id: string;
  revision: number;
  last_generated_at: number;
  gen_tier: string;
  gen_traits: string; // 生成时特质向量 JSON（触发判断基准）
  last_applied_revision: number;
  last_applied_at: number;
  last_fetch_at: number;
};

const DEFAULT_DB_PATH = './data/profile.db';

function resolveDbPath(): string {
  const raw = process.env.PROFILE_DB_PATH?.trim() || DEFAULT_DB_PATH;
  return resolve(process.cwd(), raw);
}

function audioRoot(): string {
  const raw = process.env.LOCAL_AUDIO_DIR?.trim() || './data/local-audio';
  return resolve(process.cwd(), raw);
}

/** 目录名只放白名单字符（account 形态 device-<SN>，防路径穿越）。 */
function safeSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, '_');
}

class LocalAudioStore {
  readonly publicationGuardVersion = 1;
  private readonly db: DatabaseSync;

  constructor() {
    const dbPath = resolveDbPath();
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS local_audio_state (
        account_id            TEXT PRIMARY KEY,
        revision              INTEGER NOT NULL DEFAULT 0,
        last_generated_at     INTEGER NOT NULL DEFAULT 0,
        gen_tier              TEXT NOT NULL DEFAULT '',
        gen_traits            TEXT NOT NULL DEFAULT '',
        last_applied_revision INTEGER NOT NULL DEFAULT 0,
        last_applied_at       INTEGER NOT NULL DEFAULT 0,
        last_fetch_at         INTEGER NOT NULL DEFAULT 0
      );
      -- 端侧 manifest 触达流水（2026-09-03，codex 联调对账用）：每次 GET 一行——服务端返回了哪个 revision、
      -- 端侧报了哪个 applied；「首次发现新 revision」「首次 applied 回报」的时刻都从这里算。每账号留 300 行。
      CREATE TABLE IF NOT EXISTS local_audio_fetch_log (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id      TEXT NOT NULL,
        ts              INTEGER NOT NULL,
        served_revision INTEGER NOT NULL DEFAULT -1,
        applied         INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_la_fetch_account_ts ON local_audio_fetch_log (account_id, ts DESC);
      CREATE TABLE IF NOT EXISTS local_audio_item (
        account_id  TEXT NOT NULL,
        slot        TEXT NOT NULL,
        id          TEXT NOT NULL,
        text        TEXT NOT NULL,
        sha256      TEXT NOT NULL,
        bytes       INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        created_at  INTEGER NOT NULL,
        active      INTEGER NOT NULL DEFAULT 1,
        format      TEXT NOT NULL DEFAULT 'mp3',
        PRIMARY KEY (account_id, id)
      );
      CREATE INDEX IF NOT EXISTS idx_la_item_slot ON local_audio_item(account_id, slot, active);
    `);
    // WAV 合同增量迁移：旧库补 format 列（存量行默认 mp3=rev1 回滚锚的真实格式）
    try {
      this.db.exec(`ALTER TABLE local_audio_item ADD COLUMN format TEXT NOT NULL DEFAULT 'mp3'`);
    } catch {
      /* 列已存在 */
    }
  }

  getState(accountId: string): LocalAudioState {
    const row = this.db.prepare(`SELECT * FROM local_audio_state WHERE account_id = ?`).get(accountId) as
      | LocalAudioState
      | undefined;
    return (
      row ?? {
        account_id: accountId,
        revision: 0,
        last_generated_at: 0,
        gen_tier: '',
        gen_traits: '',
        last_applied_revision: 0,
        last_applied_at: 0,
        last_fetch_at: 0,
      }
    );
  }

  private ensureStateRow(accountId: string): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO local_audio_state (account_id) VALUES (?)`)
      .run(accountId);
  }

  listActive(accountId: string): LocalAudioItem[] {
    return this.db
      .prepare(`SELECT * FROM local_audio_item WHERE account_id = ? AND active = 1 ORDER BY slot, created_at`)
      .all(accountId) as LocalAudioItem[];
  }

  /** file 端点归属校验：该 account 名下任意未清理条目（active=0 的切换窗口期条目也可下载）。 */
  getItem(accountId: string, id: string): LocalAudioItem | null {
    if (!/^[0-9a-f]{16}$/.test(id)) return null;
    const row = this.db
      .prepare(`SELECT * FROM local_audio_item WHERE account_id = ? AND id = ?`)
      .get(accountId, id) as LocalAudioItem | undefined;
    return row ?? null;
  }

  audioPath(accountId: string, id: string, format: 'mp3' | 'wav' = 'mp3'): string {
    if (!accountId || safeSegment(accountId) !== accountId || !/^[0-9a-f]{16}$/.test(id) || !['wav', 'mp3'].includes(format)) fail('invalid_clip_path');
    return join(audioRoot(), accountId, `${id}.${format}`);
  }

  readAudio(accountId: string, id: string, format: 'mp3' | 'wav' = 'mp3'): Buffer | null {
    try {
      return readFileSync(this.audioPath(accountId, id, format));
    } catch {
      return null;
    }
  }

  writeAudio(accountId: string, id: string, audio: Buffer, format: 'mp3' | 'wav' = 'mp3'): void {
    assertLocalAudioWritesAllowed();
    const p = this.audioPath(accountId, id, format);
    mkdirSync(dirname(p), { recursive: true });
    const acceptExisting = () => {
      if (!lstatSync(p).isFile() || !readFileSync(p).equals(audio)) fail('clip_identity_conflict', id);
    };
    if (existsSync(p)) { acceptExisting(); return; }
    const temp = `${p}.${randomUUID()}.tmp`;
    const fd = openSync(temp, 'wx', 0o600);
    try { writeFileSync(fd, audio); fsyncSync(fd); } finally { closeSync(fd); }
    try {
      try { linkSync(temp, p); } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        acceptExisting();
      }
      const parent = openSync(dirname(p), 'r');
      try { fsyncSync(parent); } finally { closeSync(parent); }
    } finally { unlinkSync(temp); }
  }

  /** 该 slot 的 staging 条目（active=0，14 天窗内，新→旧，限定 format）——LLM 空手轮的补足来源。
   *  format 过滤是 WAV 迁移铁律：staging 里的 MP3 遗留绝不能补进 WAV 套（混套=违反合同 §4.5）。 */
  listStagedBySlot(accountId: string, slot: AnyAudioSlot, format: 'mp3' | 'wav' = 'wav'): LocalAudioItem[] {
    return this.db
      .prepare(
        `SELECT * FROM local_audio_item WHERE account_id = ? AND slot = ? AND active = 0 AND format = ? AND created_at >= ? ORDER BY created_at DESC`,
      )
      .all(accountId, slot, format, Date.now() - STALE_ITEM_TTL_MS) as LocalAudioItem[];
  }

  /** 体积预检用：该 slot 近期（14 天内）wav 条目字节数，新→旧，最多 limit 条（active + staging 都算，它们就是下轮会被保留的池）。 */
  listRecentBytesBySlot(accountId: string, slot: AnyAudioSlot, limit: number): number[] {
    return (
      this.db
        .prepare(
          `SELECT bytes FROM local_audio_item WHERE account_id = ? AND slot = ? AND format = 'wav' AND created_at >= ? ORDER BY created_at DESC LIMIT ?`,
        )
        .all(accountId, slot, Date.now() - STALE_ITEM_TTL_MS, limit) as Array<{ bytes: number }>
    ).map((r) => r.bytes);
  }

  /** 同 slot 同 text 同 format 的既有条目（含 active=0）——J4 复用判定。
   *  format 必须参与判定（合同 WAV 增量 §4.5：文案相同 MP3/WAV 也不得共用 id——W4 首发实测踩过：
   *  撞文案复活了 rev=1 的 MP3 条目，rev=2 成混套）。 */
  findByText(accountId: string, slot: AnyAudioSlot, text: string, format: 'mp3' | 'wav' = 'wav'): LocalAudioItem | null {
    const row = this.db
      .prepare(`SELECT * FROM local_audio_item WHERE account_id = ? AND slot = ? AND text = ? AND format = ? AND (active = 1 OR created_at >= ? OR slot LIKE 'device_reply.%' OR slot LIKE 'g1.settings.%') ORDER BY active DESC, created_at DESC LIMIT 1`)
      .get(accountId, slot, text, format, Date.now() - STALE_ITEM_TTL_MS) as LocalAudioItem | undefined;
    return row ?? null;
  }

  /** 新条目以 staging 态落库（active=0）：active 只由 commitSet 统一翻——否则 commit 前后
   *  集合恒等、changed 永假，首轮 revision 停在 0（codex 端只接受正整数 revision，整套会被拒）。
   *  发布门 abort 时已合成条目留在 staging，下轮 findByText 直接复用（省 TTS），14 天未用 cleanup 清走。 */
  insertItem(accountId: string, item: Omit<LocalAudioItem, 'active' | 'created_at'>): void {
    assertLocalAudioWritesAllowed();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.insertItemRecord(accountId, item);
      this.pinCandidate(accountId, this.getItem(accountId, item.id)!);
      this.db.exec('COMMIT');
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }

  private insertItemRecord(accountId: string, item: Omit<LocalAudioItem, 'active' | 'created_at'>): void {
      const existing = this.getItem(accountId, item.id);
      if (existing) {
        if (!sameClipMetadata(existing, item)) fail('clip_identity_conflict', item.id);
      } else {
        this.db.prepare(`INSERT INTO local_audio_item
          (account_id, slot, id, text, sha256, bytes, duration_ms, format, created_at, active)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`)
          .run(accountId, item.slot, item.id, item.text, item.sha256, item.bytes, item.duration_ms, item.format, Date.now());
      }
  }

  /** 所有新素材共用此入口；事务防 cleanup 与重复 stage 竞争，文件落地永不覆盖。 */
  stageClipImmutable(accountId: string, clip: { slot: AnyAudioSlot; text: string; audio: Buffer; format: 'wav'; durationMs: number }): LocalAudioItem {
    assertLocalAudioWritesAllowed();
    const fields = { slot: clip.slot, text: clip.text.trim().normalize('NFC'), sha256: sha256(clip.audio),
      bytes: clip.audio.length, duration_ms: clip.durationMs, format: clip.format };
    const proposed = { ...fields, id: deriveClipId(fields) };
    validateClipBytes(proposed, clip.audio);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // 合法历史 ID 不因命名空间升级而换新；明确不同字节或元信息才新建。
      const old = this.findByText(accountId, clip.slot, fields.text, clip.format);
      const item = old && sameClipMetadata(old, { ...proposed, id: old.id }) ? { ...proposed, id: old.id } : proposed;
      const collision = this.getItem(accountId, item.id);
      if (collision && !sameClipMetadata(collision, item)) fail('clip_identity_conflict', item.id);
      this.writeAudio(accountId, item.id, clip.audio, clip.format);
      this.insertItemRecord(accountId, item);
      this.pinCandidate(accountId, this.getItem(accountId, item.id)!);
      const result = this.getItem(accountId, item.id)!;
      this.db.exec('COMMIT');
      return result;
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }

  validateItem(accountId: string, id: string): LocalAudioItem {
    const item = this.getItem(accountId, id);
    if (!item) fail('clip_missing', id);
    const p = this.audioPath(accountId, id, item.format);
    if (!existsSync(p)) fail('clip_file_missing', id);
    if (!lstatSync(p).isFile()) fail('clip_file_mismatch', id);
    validateClipBytes(item, readFileSync(p));
    return item;
  }

  // 清理租约独立于created_at与manifest；正常生成在分钟内完成，24h留出进程/发布恢复余量。
  private pinCandidate(accountId: string, item: LocalAudioItem): void {
    writeFileSync(this.audioPath(accountId, item.id, item.format) + '.pin', String(Date.now() + 86400000), { mode: 0o600 });
  }

  private candidatePinned(accountId: string, id: string, format: 'mp3' | 'wav'): boolean {
    try {
      const expires = Number(readFileSync(this.audioPath(accountId, id, format) + '.pin', 'utf8'));
      return !Number.isFinite(expires) || expires > Date.now();
    } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ENOENT'; }
  }

  retainCandidate(accountId: string, id: string): LocalAudioItem {
    assertLocalAudioWritesAllowed();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const item = this.validateItem(accountId, id);
      this.pinCandidate(accountId, item);
      this.db.exec('COMMIT');
      return item;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  /** 调用者必须在候选构造之前读取 expectedRevision。最终 CAS、字节校验、激活在同一写事务内。
   * 每套最多 5MiB，选择事务内读取/散列，避免校验到提交之间的 cleanup 竞争；LLM/TTS 不在事务内。
   */
  commitSet(accountId: string, keep: Array<{ slot: AnyAudioSlot; id: string }>,
    gen: { tier: string; traits: string }, opts: { expectedRevision: number; minRevision?: number; guard?: () => void }): number | null {
    assertLocalAudioWritesAllowed();
    if (!Number.isSafeInteger(opts?.expectedRevision) || opts.expectedRevision < 0
      || (opts.minRevision !== undefined && (!Number.isSafeInteger(opts.minRevision) || opts.minRevision < 0))) fail('invalid_revision');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.getState(accountId).revision !== opts.expectedRevision) fail('revision_conflict');
      opts.guard?.();
      const ids = new Set<string>();
      const candidate = keep.map(k => {
        if (ids.has(k.id)) fail('duplicate_clip_id', k.id);
        ids.add(k.id);
        const item = this.getItem(accountId, k.id);
        if (!item) fail('clip_missing', k.id);
        if (item.slot !== k.slot) fail('clip_slot_mismatch', k.id);
        return item;
      });
      validatePublicationItems(candidate);
      for (const item of candidate) {
        const path = this.audioPath(accountId, item.id, item.format);
        if (!existsSync(path)) fail('clip_file_missing', item.id);
        if (!lstatSync(path).isFile()) fail('clip_file_mismatch', item.id);
        validateClipBytes(item, readFileSync(path));
      }
      const signature = (items: Array<{ slot: AnyAudioSlot; id: string }>) => items.map(i => `${i.slot}:${i.id}`).sort().join(',');
      const changed = signature(this.listActive(accountId)) !== signature(candidate);
      this.ensureStateRow(accountId);
      if (changed) {
        this.db.prepare('UPDATE local_audio_item SET active = 0 WHERE account_id = ?').run(accountId);
        const revive = this.db.prepare('UPDATE local_audio_item SET active = 1 WHERE account_id = ? AND id = ? AND slot = ?');
        for (const item of candidate) revive.run(accountId, item.id, item.slot);
        if (signature(this.listActive(accountId)) !== signature(candidate)) fail('publication_set_mismatch');
        this.db.prepare(`UPDATE local_audio_state SET revision = MAX(revision + 1, ?), last_generated_at = ?, gen_tier = ?, gen_traits = ? WHERE account_id = ?`)
          .run(opts.minRevision ?? 0, Date.now(), gen.tier, gen.traits, accountId);
      } else {
        this.db.prepare('UPDATE local_audio_state SET last_generated_at = ?, gen_tier = ?, gen_traits = ? WHERE account_id = ?')
          .run(Date.now(), gen.tier, gen.traits, accountId);
      }
      const revision = this.getState(accountId).revision;
      this.db.exec('COMMIT');
      return changed ? revision : null;
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }

  recordFetch(accountId: string, appliedRevision: number | null, servedRevision = -1): void {
    this.ensureStateRow(accountId);
    const now = Date.now();
    if (appliedRevision !== null && Number.isInteger(appliedRevision) && appliedRevision >= 0) {
      this.db
        .prepare(
          `UPDATE local_audio_state SET last_fetch_at = ?, last_applied_revision = ?, last_applied_at = ? WHERE account_id = ?`,
        )
        .run(now, appliedRevision, now, accountId);
    } else {
      this.db.prepare(`UPDATE local_audio_state SET last_fetch_at = ? WHERE account_id = ?`).run(now, accountId);
    }
    try {
      this.db
        .prepare(`INSERT INTO local_audio_fetch_log (account_id, ts, served_revision, applied) VALUES (?, ?, ?, ?)`)
        .run(accountId, now, servedRevision, appliedRevision);
      this.db
        .prepare(`DELETE FROM local_audio_fetch_log WHERE account_id = ? AND id NOT IN (
                    SELECT id FROM local_audio_fetch_log WHERE account_id = ? ORDER BY ts DESC LIMIT 300)`)
        .run(accountId, accountId);
    } catch (err) {
      console.log('[local-audio] fetch_log 记账失败(不影响 manifest):', String((err as Error)?.message ?? err));
    }
  }

  /** 触达流水（时间升序），sinceTs 之后的。对账脚本与单测用。 */
  listFetchLog(accountId: string, sinceTs = 0): { ts: number; served_revision: number; applied: number | null }[] {
    return this.db
      .prepare(`SELECT ts, served_revision, applied FROM local_audio_fetch_log WHERE account_id = ? AND ts >= ? ORDER BY ts ASC, id ASC`)
      .all(accountId, sinceTs) as { ts: number; served_revision: number; applied: number | null }[];
  }

  /** 清理：active=0 且超 14 天的条目，删行+删盘上文件。返回清理数。 */
  cleanup(accountId: string): number {
    assertLocalAudioWritesAllowed();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // 拿到写锁后才选行和删文件，发布拿同一把锁。固定交付物继续豁免过期清理。
      const stale = this.db.prepare(`SELECT id, format FROM local_audio_item WHERE account_id = ? AND active = 0
        AND created_at < ? AND slot NOT LIKE 'device_reply.%' AND slot NOT LIKE 'g1.settings.%'`)
        .all(accountId, Date.now() - STALE_ITEM_TTL_MS) as Array<{ id: string; format: 'mp3' | 'wav' }>;
      let removed = 0;
      for (const { id, format } of stale) {
        if (this.candidatePinned(accountId, id, format)) continue;
        const p = this.audioPath(accountId, id, format);
        try { if (existsSync(p)) unlinkSync(p); if (existsSync(p + '.pin')) unlinkSync(p + '.pin'); } catch { continue; }
        this.db.prepare('DELETE FROM local_audio_item WHERE account_id = ? AND id = ? AND active = 0').run(accountId, id);
        removed++;
      }
      this.db.exec('COMMIT');
      return removed;
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }

  /** 有内容的账号（revision>0）——冻结槽全机队发布脚本 --all 用。 */
  listAccounts(): string[] {
    return (this.db.prepare(`SELECT account_id FROM local_audio_state WHERE revision > 0 ORDER BY account_id`).all() as Array<{ account_id: string }>).map((r) => r.account_id);
  }

  /** 重置（admin DELETE relation-state 联动第六样）：删全部条目+文件+状态行。 */
  clearAccount(accountId: string): void {
    assertLocalAudioWritesAllowed();
    this.db.exec('BEGIN IMMEDIATE');
    try {
    const items = this.db
      .prepare(`SELECT id, format FROM local_audio_item WHERE account_id = ?`)
      .all(accountId) as Array<{ id: string; format: 'mp3' | 'wav' }>;
    for (const { id, format } of items) {
      try {
        const p = this.audioPath(accountId, id, format);
        if (existsSync(p)) unlinkSync(p);
        if (existsSync(p + '.pin')) unlinkSync(p + '.pin');
      } catch {
        /* 同上 */
      }
    }
    this.db.prepare(`DELETE FROM local_audio_item WHERE account_id = ?`).run(accountId);
    this.db.prepare(`DELETE FROM local_audio_state WHERE account_id = ?`).run(accountId);
    this.db.exec('COMMIT');
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }

  /** manifest 组装（路由层直接下发）。投毒开关 LOCAL_AUDIO_POISON_ID 在路由层做，store 不掺假。 */
  buildManifest(accountId: string): {
    schema_version: 1;
    enabled: true;
    delivery: 'audio';
    revision: number;
    slots: Record<string, Array<Record<string, unknown>>>;
    generated_at: string;
  } {
    const state = this.getState(accountId);
    const slots: Record<string, Array<Record<string, unknown>>> = {};
    for (const item of this.listActive(accountId)) {
      (slots[item.slot] ??= []).push({
        id: item.id,
        text: item.text,
        url: `/v1/device/local-audio/file/${item.id}`,
        sha256: item.sha256,
        bytes: item.bytes,
        duration_ms: item.duration_ms,
        format: item.format,
        ...(item.format === 'wav' ? { codec: 'pcm_s16le', bits_per_sample: 16 } : {}),
        sample_rate: 24000,
        channels: 1,
      });
    }
    return {
      schema_version: 1,
      enabled: true,
      delivery: 'audio',
      revision: state.revision,
      slots,
      generated_at: new Date(state.last_generated_at || Date.now()).toISOString(),
    };
  }

  /**
   * worker 回声对撞库（2026-09-01 招呼语回声第三次实证）：该设备全部历史文案去重
   * （含 active=0——设备夜间换新存在「server 已翻新、设备还播上一版」的交界缝，
   * 历史文案一并返回把缝焊住）。worker 侧只取 greeting.* 进对撞库，此处不过滤留扩展位。
   */
  listTextsForEcho(accountId: string): Array<{ slot: string; text: string }> {
    // 2026-09-01 收窄:只返回 active 套(003 实测 36 条历史 vs 13 条 active——历史全量把
    // 对撞面放大近 3 倍,而人格化文案与用户日常语言分布天然重叠(「有啥好玩的事儿说说」
    // 既是招呼语也是用户真话),误伤面随对撞面同步放大。revision 交界缝(设备夜间换新前
    // 播上一版)的窗口只有几小时且低频,取舍上放弃焊缝换全天误伤面收窄。
    // 2026-09-06 补兜底(0001 首日实证:新设备当天未轮到每日批 → revision 0 → 库空 → APK 内置招呼语
    // 「来啦，想聊点啥？」「哟，你来啦。」被 worker 当用户话提交,小可接着自家招呼语开讲):端侧无现役动态槽、
    // 缺槽、tombstone/rev0 都回退 APK 内置招呼语,故**恒并入**内置文案(槽名 greeting.builtin,worker 只装
    // greeting.* 进对撞库);动态在前,同文案去重。内置表是固定小集合(8-16 交付 greet_01–09),不放大误伤面。
    const active = this.db
      .prepare(`SELECT DISTINCT slot, text FROM local_audio_item WHERE account_id = ? AND active = 1 ORDER BY slot`)
      .all(accountId) as Array<{ slot: string; text: string }>;
    const seen = new Set(active.map((r) => r.text));
    const builtin = builtinGreetingTexts()
      .filter((t) => !seen.has(t))
      .map((text) => ({ slot: 'greeting.builtin', text }));
    return [...active, ...builtin];
  }
}

/**
 * APK 内置唤醒招呼语文案(2026-08-16 S2B1 交付 greet_01–09,端侧无动态套/缺槽/tombstone 时播它们)。
 * 改内置包文案时同步改这里;临时追加走 env LOCAL_AUDIO_BUILTIN_GREETING_TEXTS(逗号分隔,restart 生效)。
 */
export const BUILTIN_GREETING_TEXTS: readonly string[] = [
  '哎，你好呀。',
  '嗯呐，我在呢。',
  '来啦，想聊点啥？',
  '来啦。',
  '哎，来啦来啦。',
  '嗨，我在呢。',
  '哟，你来啦。',
  '哎哟，是你呀～',
  '嗨嗨，等你好久啦。',
];

/** 内置招呼语 ∪ env 追加(去重,保序)。 */
export function builtinGreetingTexts(): string[] {
  const raw = process.env.LOCAL_AUDIO_BUILTIN_GREETING_TEXTS?.trim();
  const extra = raw ? raw.split(',').map((x) => x.trim()).filter(Boolean) : [];
  return [...new Set([...BUILTIN_GREETING_TEXTS, ...extra])];
}

export const localAudioStore = new LocalAudioStore();
