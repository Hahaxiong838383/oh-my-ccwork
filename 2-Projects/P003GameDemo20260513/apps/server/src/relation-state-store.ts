import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { growthLedgerStore } from './growth-ledger-store.js';

// P0 人格成长 · 关系状态 store（契约 CC_P003_PERSONA_GROWTH_P0_CONTRACT_20260825
// + codex 评审 CODEX_..._REVIEW 四项修正落地）：小可↔孩子 per-account 关系与情绪连续性。
// 连 profile.db（与画像同域，独立连接同 memory-item-store 模式）。
// 身份键阶段性前提（codex 3.2）：一账号一孩子一设备（产品冻结）；开放多孩子时主键须升级
// child_profile_id，不能继续复用 account_id。解绑/换绑生命周期见 admin-data PATCH parent。

export type RelationState = {
  account_id: string;
  first_seen_at: number;
  last_seen_at: number;
  prev_session_end_at: number | null;
  current_session_started_at: number; // codex 2.2：会话冻结锚点
  miss_at_session_start: number; //     会话内想念度冻结值（内部变量，注入措辞不用「想念」）
  session_count: number;
  valence_ema: number; //               近期相处基调 EMA [-1,1]
  engagement_ema: number; //            投入度 EMA [0,1]（P0 只积累不注入，P2 晶化门备数据）
  valence_sample_count: number; //      codex 3.3：区分「真中性」与「从未抽成」
  engagement_sample_count: number;
  last_sample_key: string; //           codex 2.4：同一条孩子输入只贡献一次 EMA 样本
  last_processed_ts: number; //         codex 2.3：乱序保护单调门（抽取发起时刻）
  updated_at: number;
};

export type TurnSample = {
  ts: number; //          抽取发起时刻（LLM call 之前取，后发先至的旧请求会被单调门拒掉）
  sampleKey: string; //   最新一条孩子输入的内容指纹（close 补抽与每轮抽评同一条时防重复计入 EMA）
  valence?: number; //    省略 = 跳过 EMA 更新（省略≠0，防中性轮拉偏 — 契约 §4.2）
  engagement?: number;
  quote?: string; //      最新一条孩子输入原文（成长账本的 trigger_quote，账本内做危机过滤与截断）
};

export type InjectionView = {
  tier: '新朋友' | '渐渐熟悉' | '老朋友';
  daysKnown: number;
  sessionCount: number;
  miss: number; //          [0,1] 重逢感（注入措辞用「重逢感」，禁「想念」— codex 2.1/V3.2 对齐）
  mood: number | null; //   [0,1] 相处气氛；样本 <3 返回 null（不注入，防兜底值冒充真值）
};

const SESSION_GAP_MS = 30 * 60_000; //  关系会话切分（契约 §3.1，与遥测会话语义解耦互不引用）
const MISS_SATURATION_MS = 72 * 3600_000; // 72h 饱和封顶（健康依恋红线：三天和三十天一样想）
const EMA_ALPHA = 0.3;
const MOOD_MIN_SAMPLES = 3; //          气氛注入最小样本量（codex 3.3）

const DEFAULT_DB_PATH = './data/profile.db';

function resolveDbPath(): string {
  const raw = process.env.PROFILE_DB_PATH?.trim() || DEFAULT_DB_PATH;
  return resolve(process.cwd(), raw);
}

export function computeMiss(gapMs: number): number {
  if (!(gapMs > 0)) return 0;
  return Math.min(1, gapMs / MISS_SATURATION_MS);
}

export function familiarityTier(sessionCount: number, daysKnown: number): InjectionView['tier'] {
  if (daysKnown < 7 || sessionCount < 10) return '新朋友';
  if (daysKnown >= 30 && sessionCount >= 40) return '老朋友';
  return '渐渐熟悉';
}

/** Asia/Shanghai 小时（固定 UTC+8 无 DST，沿用 telemetry dayOf 同款偏移法 — codex 3.5 禁依赖进程时区）。 */
export function shanghaiHour(ms: number): number {
  return new Date(ms + 8 * 3600_000).getUTCHours();
}

/** 精力时段查表（契约 §3.3）：晚间低精力配合「该休息了」的温和暗示。 */
export function energyOfHour(hourSh: number): number {
  if (hourSh >= 6 && hourSh < 9) return 0.9;
  if (hourSh >= 9 && hourSh < 19) return 0.7;
  if (hourSh >= 19 && hourSh < 21) return 0.5;
  return 0.3;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

class RelationStateStore {
  private readonly db: DatabaseSync;

  constructor() {
    const dbPath = resolveDbPath();
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS relation_state (
        account_id                 TEXT PRIMARY KEY,
        first_seen_at              INTEGER NOT NULL,
        last_seen_at               INTEGER NOT NULL,
        prev_session_end_at        INTEGER,
        current_session_started_at INTEGER NOT NULL,
        miss_at_session_start      REAL NOT NULL DEFAULT 0,
        session_count              INTEGER NOT NULL DEFAULT 1,
        valence_ema                REAL NOT NULL DEFAULT 0,
        engagement_ema             REAL NOT NULL DEFAULT 0.5,
        valence_sample_count       INTEGER NOT NULL DEFAULT 0,
        engagement_sample_count    INTEGER NOT NULL DEFAULT 0,
        last_sample_key            TEXT NOT NULL DEFAULT '',
        last_processed_ts          INTEGER NOT NULL DEFAULT 0,
        updated_at                 INTEGER NOT NULL
      );
    `);
    this.migrate();
  }

  /** M6 自我叙事列迁移（幂等，仿 profile-store migrate 模式；失败不阻断启动）。 */
  private migrate(): void {
    try {
      const cols = this.db.prepare('PRAGMA table_info(relation_state)').all() as { name: string }[];
      const has = (n: string) => cols.some((c) => c.name === n);
      if (!has('self_narrative')) {
        this.db.exec(`ALTER TABLE relation_state ADD COLUMN self_narrative TEXT NOT NULL DEFAULT ''`);
      }
      if (!has('narrative_updated_at')) {
        this.db.exec(`ALTER TABLE relation_state ADD COLUMN narrative_updated_at INTEGER NOT NULL DEFAULT 0`);
      }
    } catch (err) {
      console.error('[persona] relation_state migrate 失败(不阻断启动):', String((err as Error)?.message ?? err));
    }
  }

  /** M6：写自我叙事（每日批调用）。 */
  setNarrative(accountId: string, narrative: string): boolean {
    const res = this.db
      .prepare(`UPDATE relation_state SET self_narrative = ?, narrative_updated_at = ?, updated_at = ? WHERE account_id = ?`)
      .run(narrative, Date.now(), Date.now(), accountId);
    return res.changes > 0;
  }

  getNarrative(accountId: string): { text: string; updated_at: number } | null {
    const row = this.db
      .prepare(`SELECT self_narrative, narrative_updated_at FROM relation_state WHERE account_id = ?`)
      .get(accountId) as { self_narrative: string; narrative_updated_at: number } | undefined;
    if (!row || !row.self_narrative) return null;
    return { text: row.self_narrative, updated_at: row.narrative_updated_at };
  }

  /**
   * 每轮抽取链末尾调用（fire-and-forget 链内）。DatabaseSync 同步执行 + JS 单线程，
   * SELECT→UPDATE 之间无 await 无并发穿插，天然原子；UPDATE 的 CAS WHERE 是双保险
   * （codex 2.3：session_count 判定与 EMA 更新同一事务；乱序/重复直接忽略）。
   */
  recordTurn(accountId: string, sample: TurnSample): 'first' | 'applied' | 'stale' {
    const row = this.getState(accountId);
    if (!row) {
      // 首见建档：miss_at_session_start=0（契约 §3.3 首次见面特判）
      this.db
        .prepare(
          `INSERT INTO relation_state
             (account_id, first_seen_at, last_seen_at, prev_session_end_at,
              current_session_started_at, miss_at_session_start, session_count,
              valence_ema, engagement_ema, valence_sample_count, engagement_sample_count,
              last_sample_key, last_processed_ts, updated_at)
           VALUES (?, ?, ?, NULL, ?, 0, 1, 0, 0.5, 0, 0, ?, ?, ?)`,
        )
        .run(accountId, sample.ts, sample.ts, sample.ts, sample.sampleKey, sample.ts, Date.now());
      return 'first';
    }

    // 乱序保护：后发先至的旧请求（发起时刻更早）不得覆盖新状态
    if (sample.ts <= row.last_processed_ts) return 'stale';

    const gap = sample.ts - row.last_seen_at;
    let { prev_session_end_at, current_session_started_at, miss_at_session_start, session_count } = row;
    if (gap > SESSION_GAP_MS) {
      prev_session_end_at = row.last_seen_at;
      current_session_started_at = sample.ts;
      miss_at_session_start = computeMiss(gap); // 冻结锚点：整个会话读这个值（codex 2.2）
      session_count += 1;
      // 成长账本：会话切档 + 档位跨档（因果链方案 §3.3，依恋律——可靠陪伴累积→关系换挡）
      const days = Math.max(0, Math.floor((sample.ts - row.first_seen_at) / 86_400_000));
      const oldTier = familiarityTier(session_count - 1, days);
      const newTier = familiarityTier(session_count, days);
      growthLedgerStore.record(accountId, {
        module: 'relation', dimension: 'session', from: session_count - 1, to: session_count,
        triggerQuote: sample.quote, rule: 'session_gap_30min', theory: 'attachment',
        note: `第 ${session_count} 次会话开始（离线 ${(gap / 3600_000).toFixed(1)} 小时，重逢感 ${miss_at_session_start.toFixed(2)}）`,
      });
      if (newTier !== oldTier) {
        growthLedgerStore.record(accountId, {
          module: 'relation', dimension: 'tier', from: oldTier, to: newTier,
          rule: 'familiarity_tier', theory: 'attachment',
          note: `陪伴累积跨档：${oldTier} → ${newTier}（${days} 天 / ${session_count} 次会话）`,
        });
      }
    }

    // EMA：字段省略=跳过；同 sampleKey（close 补抽评同一条输入）=跳过（codex 2.4）
    let { valence_ema, engagement_ema, valence_sample_count, engagement_sample_count } = row;
    const freshSample = sample.sampleKey !== row.last_sample_key;
    if (freshSample && typeof sample.valence === 'number' && Number.isFinite(sample.valence)) {
      const prevEma = valence_ema;
      valence_ema = EMA_ALPHA * clamp(sample.valence, -1, 1) + (1 - EMA_ALPHA) * valence_ema;
      valence_sample_count += 1;
      // 成长账本：气氛 EMA 每次有信号的更新（因果链方案 §3.3——这轮对话把气氛推向了哪里）
      growthLedgerStore.record(accountId, {
        module: 'relation', dimension: 'valence_ema', from: prevEma, to: valence_ema,
        triggerQuote: sample.quote, rule: 'ema_valence_a0.3', theory: 'attachment',
        note: `本轮情绪 ${sample.valence > 0 ? '+' : ''}${sample.valence.toFixed(1)} → 相处气氛 ${prevEma.toFixed(2)}→${valence_ema.toFixed(2)}${valence_ema > prevEma ? ' ↑' : ' ↓'}`,
      });
    }
    if (freshSample && typeof sample.engagement === 'number' && Number.isFinite(sample.engagement)) {
      engagement_ema = EMA_ALPHA * clamp(sample.engagement, 0, 1) + (1 - EMA_ALPHA) * engagement_ema;
      engagement_sample_count += 1;
    }

    const res = this.db
      .prepare(
        `UPDATE relation_state SET
           last_seen_at = ?, prev_session_end_at = ?, current_session_started_at = ?,
           miss_at_session_start = ?, session_count = ?,
           valence_ema = ?, engagement_ema = ?, valence_sample_count = ?, engagement_sample_count = ?,
           last_sample_key = ?, last_processed_ts = ?, updated_at = ?
         WHERE account_id = ? AND last_processed_ts < ?`,
      )
      .run(
        sample.ts, prev_session_end_at, current_session_started_at,
        miss_at_session_start, session_count,
        valence_ema, engagement_ema, valence_sample_count, engagement_sample_count,
        sample.sampleKey, sample.ts, Date.now(),
        accountId, sample.ts,
      );
    return res.changes > 0 ? 'applied' : 'stale';
  }

  getState(accountId: string): RelationState | null {
    const row = this.db
      .prepare(`SELECT * FROM relation_state WHERE account_id = ?`)
      .get(accountId) as RelationState | undefined;
    return row ?? null;
  }

  /**
   * 注入视图：纯读现算，读路径零写（TTFT 铁律）。
   * 时序错位兜底（终值回执 §时序，codex 2.2 的补全）：新会话第一轮注入发生在轮末抽取
   * recordTurn 之前——此刻写路径尚未切会话，miss_at_session_start 还是上一会话的旧值。
   * 故 gap>30min 时现算 miss（与写路径稍后落库的冻结值是同一公式同一 gap，秒级微差可忽略）；
   * 会话中（gap≤30min）读冻结值，会话内稳定不漂移。
   */
  getInjectionView(accountId: string, now: number): InjectionView | null {
    const row = this.getState(accountId);
    if (!row) return null;
    const gap = now - row.last_seen_at;
    const miss = gap > SESSION_GAP_MS ? computeMiss(gap) : row.miss_at_session_start;
    const daysKnown = Math.max(0, Math.floor((now - row.first_seen_at) / 86_400_000));
    return {
      tier: familiarityTier(row.session_count, daysKnown),
      daysKnown,
      sessionCount: row.session_count,
      miss,
      mood: row.valence_sample_count >= MOOD_MIN_SAMPLES ? clamp(0.5 + 0.5 * row.valence_ema, 0, 1) : null,
    };
  }

  /** 每日批遍历用：凡有关系状态的账号（M3/M6 跑批范围 = 有互动痕迹的账号）。 */
  listAccounts(): string[] {
    const rows = this.db.prepare(`SELECT account_id FROM relation_state`).all() as { account_id: string }[];
    return rows.map((r) => r.account_id);
  }

  /** 换绑换孩子/admin 显式重置时清除（codex 3.2 生命周期）。 */
  clear(accountId: string): boolean {
    const res = this.db.prepare(`DELETE FROM relation_state WHERE account_id = ?`).run(accountId);
    return res.changes > 0;
  }

  /**
   * 回填专用（scripts/backfill-relation-state.ts --apply）：仅当该账号无行时写入，
   * 绝不覆盖运行中数据（回填是冷启动补历史，不是修数工具）。
   */
  upsertBackfill(row: Omit<RelationState, 'updated_at'>): boolean {
    if (this.getState(row.account_id)) return false;
    this.db
      .prepare(
        `INSERT INTO relation_state
           (account_id, first_seen_at, last_seen_at, prev_session_end_at,
            current_session_started_at, miss_at_session_start, session_count,
            valence_ema, engagement_ema, valence_sample_count, engagement_sample_count,
            last_sample_key, last_processed_ts, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.account_id, row.first_seen_at, row.last_seen_at, row.prev_session_end_at,
        row.current_session_started_at, row.miss_at_session_start, row.session_count,
        row.valence_ema, row.engagement_ema, row.valence_sample_count, row.engagement_sample_count,
        row.last_sample_key, row.last_processed_ts, Date.now(),
      );
    return true;
  }
}

// ── 开关与灰度（codex 3.1：生产默认双关；allowlist 未设=放开、设了=仅名单，语义同 TELEMETRY_SN_ALLOWLIST）──

function inAllowlist(accountId: string): boolean {
  const raw = process.env.PERSONA_STATE_ACCOUNT_ALLOWLIST?.trim();
  if (!raw) return true;
  return raw.split(',').map((s) => s.trim()).filter(Boolean).includes(accountId);
}

/** 追踪门（写路径）：默认关。生效前提 MEMORY_EXTRACT_ENABLED≠0（抽取链是唯一数据泵）。 */
export function personaTrackEnabled(accountId: string): boolean {
  if (process.env.PERSONA_STATE_TRACK !== '1') return false;
  return inAllowlist(accountId);
}

/** 注入门（读路径）：默认关。两段上线：TRACK 稳定 5-7 天后才开。 */
export function personaInjectEnabled(accountId: string): boolean {
  if (process.env.PERSONA_STATE_INJECT !== '1') return false;
  return inAllowlist(accountId);
}

/** M4 风格晶化门（晶化写入+few-shot 注入共用）：默认关，共享 allowlist。 */
export function personaStyleEnabled(accountId: string): boolean {
  if (process.env.PERSONA_STYLE_ENABLED !== '1') return false;
  return inAllowlist(accountId);
}

/** M3 行为画像门（每日批+policy 注入共用）：默认关，共享 allowlist。 */
export function personaInsightEnabled(accountId: string): boolean {
  if (process.env.PERSONA_INSIGHT_ENABLED !== '1') return false;
  return inAllowlist(accountId);
}

/** M6 自我叙事门（每日批+data 注入共用）：默认关，共享 allowlist。 */
export function personaNarrativeEnabled(accountId: string): boolean {
  if (process.env.PERSONA_NARRATIVE_ENABLED !== '1') return false;
  return inAllowlist(accountId);
}

/** 特质向量门（因果链方案 §3.2，规则更新+注入共用）：默认关，共享 allowlist。 */
export function personaTraitEnabled(accountId: string): boolean {
  if (process.env.PERSONA_TRAIT_ENABLED !== '1') return false;
  return inAllowlist(accountId);
}

/** 本地人格音频门（合同 CODEX_P003_LOCAL_AUDIO_CONTRACT_v1.1 §8）：默认关，共享 allowlist（004 永不进）。 */
export function personaLocalAudioEnabled(accountId: string): boolean {
  if (process.env.PERSONA_LOCAL_AUDIO_ENABLED !== '1') return false;
  return inAllowlist(accountId);
}

export const relationStateStore = new RelationStateStore();
