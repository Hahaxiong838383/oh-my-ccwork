import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
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
 * id = 音频 sha256 前 16 hex（内容寻址，同 id 永远同字节）；复用语义（codex J4）：
 * 重生成时同 slot 同 text 的旧条目直接复活 active=1，不重合成（TTS 非确定性，重合成=白换 id）。
 */

export const LOCAL_AUDIO_SLOTS = [
  'greeting.normal',
  'greeting.cover_open',
  'greeting.presence_return',
  'farewell.general',
  'farewell.goodbye',
  'farewell.night',
  'posture.adjust',
  'posture.no_face',
  // v133 G1 奖励线（optional，合同 CODEX_CC_P003_G1_LOCAL_AUDIO_V133_JOINT_20260828 §2）：
  // 进度段完成（*.earned）与领取事务成功（*.claimed）各三档，缺失=合法（端侧只记 state=missing）
  'g1.progress.coin_earned',
  'g1.progress.chest_earned',
  'g1.progress.final_earned',
  'g1.reward.coin_claimed',
  'g1.reward.chest_claimed',
  'g1.reward.final_claimed',
] as const;
export type LocalAudioSlot = (typeof LOCAL_AUDIO_SLOTS)[number];

/**
 * 必选六 slot（v107 合同 §1：required 缺任一即整套 abort）。
 * posture.* 为 optional：缺失=合法（v107 端侧回退 APK 内置），但一旦出现必须 2..5 条——
 * 单条不成套（发布门会弃 1 条的 optional slot，条目留 staging 下轮补足后再进）。
 */
export const REQUIRED_SLOTS: readonly LocalAudioSlot[] = [
  'greeting.normal',
  'greeting.cover_open',
  'greeting.presence_return',
  'farewell.general',
  'farewell.goodbye',
  'farewell.night',
] as const;

export const MIN_ITEMS_PER_SLOT = 2;
const STALE_ITEM_TTL_MS = 14 * 86_400_000;

export type LocalAudioItem = {
  slot: LocalAudioSlot;
  id: string;
  text: string;
  sha256: string;
  bytes: number;
  duration_ms: number;
  format: 'mp3' | 'wav'; // WAV 合同增量：rev=1 存量=mp3（冻结回滚锚），rev≥2 新发布=wav
  created_at: number;
  active: number;
};

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
  private readonly db: DatabaseSync;

  constructor() {
    const dbPath = resolveDbPath();
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
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
    return join(audioRoot(), safeSegment(accountId), `${id}.${format}`);
  }

  readAudio(accountId: string, id: string, format: 'mp3' | 'wav' = 'mp3'): Buffer | null {
    try {
      return readFileSync(this.audioPath(accountId, id, format));
    } catch {
      return null;
    }
  }

  writeAudio(accountId: string, id: string, audio: Buffer, format: 'mp3' | 'wav' = 'mp3'): void {
    const p = this.audioPath(accountId, id, format);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, audio);
  }

  /** 该 slot 的 staging 条目（active=0，14 天窗内，新→旧，限定 format）——LLM 空手轮的补足来源。
   *  format 过滤是 WAV 迁移铁律：staging 里的 MP3 遗留绝不能补进 WAV 套（混套=违反合同 §4.5）。 */
  listStagedBySlot(accountId: string, slot: LocalAudioSlot, format: 'mp3' | 'wav' = 'wav'): LocalAudioItem[] {
    return this.db
      .prepare(
        `SELECT * FROM local_audio_item WHERE account_id = ? AND slot = ? AND active = 0 AND format = ? AND created_at >= ? ORDER BY created_at DESC`,
      )
      .all(accountId, slot, format, Date.now() - STALE_ITEM_TTL_MS) as LocalAudioItem[];
  }

  /** 同 slot 同 text 同 format 的既有条目（含 active=0）——J4 复用判定。
   *  format 必须参与判定（合同 WAV 增量 §4.5：文案相同 MP3/WAV 也不得共用 id——W4 首发实测踩过：
   *  撞文案复活了 rev=1 的 MP3 条目，rev=2 成混套）。 */
  findByText(accountId: string, slot: LocalAudioSlot, text: string, format: 'mp3' | 'wav' = 'wav'): LocalAudioItem | null {
    const row = this.db
      .prepare(`SELECT * FROM local_audio_item WHERE account_id = ? AND slot = ? AND text = ? AND format = ? LIMIT 1`)
      .get(accountId, slot, text, format) as LocalAudioItem | undefined;
    return row ?? null;
  }

  /** 新条目以 staging 态落库（active=0）：active 只由 commitSet 统一翻——否则 commit 前后
   *  集合恒等、changed 永假，首轮 revision 停在 0（codex 端只接受正整数 revision，整套会被拒）。
   *  发布门 abort 时已合成条目留在 staging，下轮 findByText 直接复用（省 TTS），14 天未用 cleanup 清走。 */
  insertItem(accountId: string, item: Omit<LocalAudioItem, 'active' | 'created_at'>): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO local_audio_item
           (account_id, slot, id, text, sha256, bytes, duration_ms, format, created_at, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(accountId, item.slot, item.id, item.text, item.sha256, item.bytes, item.duration_ms, item.format, Date.now());
  }

  /**
   * 整套原子提交（生成侧「整套原子」，合同 §7.3 的服务端镜像）：
   * 六 slot 的新成员集合一次事务替换 active 标记；集合与旧 active 集不同才 bump revision。
   * 返回新 revision（未变化返回 null）。keep 传 (slot,id) 全集——含复用的旧条目。
   */
  commitSet(
    accountId: string,
    keep: Array<{ slot: LocalAudioSlot; id: string }>,
    gen: { tier: string; traits: string },
    // minRevision：跨设备 revision 命名空间对齐用（v133 合同硬门 2「不得低于双机已持有值」，
    // 0010 3→5 跳号）。默认 0 = MAX(revision+1, 0) = 纯 +1，旧路径行为不变。
    opts?: { minRevision?: number },
  ): number | null {
    const before = this.listActive(accountId)
      .map((i) => `${i.slot}:${i.id}`)
      .sort()
      .join(',');
    const after = keep
      .map((k) => `${k.slot}:${k.id}`)
      .sort()
      .join(',');
    this.ensureStateRow(accountId);
    const changed = before !== after;
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`UPDATE local_audio_item SET active = 0 WHERE account_id = ?`).run(accountId);
      const revive = this.db.prepare(`UPDATE local_audio_item SET active = 1 WHERE account_id = ? AND id = ?`);
      for (const k of keep) revive.run(accountId, k.id);
      if (changed) {
        this.db
          .prepare(
            `UPDATE local_audio_state SET revision = MAX(revision + 1, ?), last_generated_at = ?, gen_tier = ?, gen_traits = ? WHERE account_id = ?`,
          )
          .run(opts?.minRevision ?? 0, Date.now(), gen.tier, gen.traits, accountId);
      } else {
        // 内容没变不 bump（设备零感知），但生成基准要前移，否则触发条件每天重算重生成
        this.db
          .prepare(`UPDATE local_audio_state SET last_generated_at = ?, gen_tier = ?, gen_traits = ? WHERE account_id = ?`)
          .run(Date.now(), gen.tier, gen.traits, accountId);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return changed ? this.getState(accountId).revision : null;
  }

  recordFetch(accountId: string, appliedRevision: number | null): void {
    this.ensureStateRow(accountId);
    if (appliedRevision !== null && Number.isInteger(appliedRevision) && appliedRevision >= 0) {
      this.db
        .prepare(
          `UPDATE local_audio_state SET last_fetch_at = ?, last_applied_revision = ?, last_applied_at = ? WHERE account_id = ?`,
        )
        .run(Date.now(), appliedRevision, Date.now(), accountId);
    } else {
      this.db.prepare(`UPDATE local_audio_state SET last_fetch_at = ? WHERE account_id = ?`).run(Date.now(), accountId);
    }
  }

  /** 清理：active=0 且超 14 天的条目，删行+删盘上文件。返回清理数。 */
  cleanup(accountId: string): number {
    const stale = this.db
      .prepare(`SELECT id, format FROM local_audio_item WHERE account_id = ? AND active = 0 AND created_at < ?`)
      .all(accountId, Date.now() - STALE_ITEM_TTL_MS) as Array<{ id: string; format: 'mp3' | 'wav' }>;
    for (const { id, format } of stale) {
      const p = this.audioPath(accountId, id, format);
      try {
        if (existsSync(p)) unlinkSync(p);
      } catch {
        /* 文件删除失败不阻断，下轮再试 */
      }
      this.db.prepare(`DELETE FROM local_audio_item WHERE account_id = ? AND id = ?`).run(accountId, id);
    }
    return stale.length;
  }

  /** 重置（admin DELETE relation-state 联动第六样）：删全部条目+文件+状态行。 */
  clearAccount(accountId: string): void {
    const items = this.db
      .prepare(`SELECT id, format FROM local_audio_item WHERE account_id = ?`)
      .all(accountId) as Array<{ id: string; format: 'mp3' | 'wav' }>;
    for (const { id, format } of items) {
      try {
        const p = this.audioPath(accountId, id, format);
        if (existsSync(p)) unlinkSync(p);
      } catch {
        /* 同上 */
      }
    }
    this.db.prepare(`DELETE FROM local_audio_item WHERE account_id = ?`).run(accountId);
    this.db.prepare(`DELETE FROM local_audio_state WHERE account_id = ?`).run(accountId);
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
}

export const localAudioStore = new LocalAudioStore();
