import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { growthLedgerStore, type GrowthTheory } from './growth-ledger-store.js';
import { getStyleTemplate, type StyleTemplateKey } from './style-template.js';

// 小可特质向量（因果链方案 V1.1 §3.2）：真正会「长」的人格层。per-child 五维显式特质，
// 人设默认值=先天基线（荣格律），变化=慢 δ（|δ|≤0.02）+ 每日弹簧拉回（set-point 律，人设漂移防线）。
// 与 OpenHer 8D 信号的差异（V1.0 不搬清单）：无随机网络、每维有名字有因果规则、每次变化必记账本。

export const TRAIT_DIMS = ['playfulness', 'talkativeness', 'storytelling', 'gentleness', 'curiosity_feed'] as const;
export type TraitDim = (typeof TRAIT_DIMS)[number];

export const TRAIT_LABELS: Record<TraitDim, string> = {
  playfulness: '活泼度',
  talkativeness: '话语量',
  storytelling: '故事倾向',
  gentleness: '温柔度',
  curiosity_feed: '好奇引导',
};

/** 人设默认值 = 先天基线（小可 IP 的出厂人格，成长是基线上的有界偏移）。 */
export const TRAIT_BASELINE: Record<TraitDim, number> = {
  playfulness: 0.6,
  talkativeness: 0.5,
  storytelling: 0.5,
  gentleness: 0.7,
  curiosity_feed: 0.5,
};

const MAX_DEVIATION = 0.35; //   界：[基线±0.35]
const GENTLENESS_FLOOR = 0.5; // 温柔度地板（儿童红线：温柔有下限）
const MAX_DELTA = 0.02; //       单次调整硬 clamp（慢变量——重复才固化，T1）
const DAILY_DECAY = 0.01; //     每日向基线回拉（set-point 弹性）
/** R3（2026-09-03）：每维每日有机位移上限——194 次 −0.01 把话语量压到地板的事故再也不可能一天内发生；
 *  档位切换/家长设定/数据修复/回退/回落不计入。 */
export const DAILY_ORGANIC_CAP = 0.06;
const NON_ORGANIC_RULES = new Set(['parent_style_template', 'child_voice_style', 'cc_data_fix', 'rollback', 'daily_setpoint_decay']);

const DEFAULT_DB_PATH = './data/profile.db';

/** 沪时日期（+8h 偏移法）。 */
function cstDayOf(ts: number): string {
  return new Date(ts + 8 * 3600_000).toISOString().slice(0, 10);
}

function resolveDbPath(): string {
  const raw = process.env.PROFILE_DB_PATH?.trim() || DEFAULT_DB_PATH;
  return resolve(process.cwd(), raw);
}

export function clampTrait(dim: TraitDim, value: number, baseOverride?: number): number {
  // baseOverride：家长风格模板设定的 per-account 基线（P0 风格系统）；缺省=出厂基线，纯函数向后兼容。
  const base = baseOverride ?? TRAIT_BASELINE[dim];
  let v = Math.max(base - MAX_DEVIATION, Math.min(base + MAX_DEVIATION, value));
  v = Math.max(0, Math.min(1, v));
  if (dim === 'gentleness') v = Math.max(GENTLENESS_FLOOR, v);
  return v;
}

// ── 规则引擎（纯函数，供单测）：镜像（T3 Bandura/LSM）+ 强化（T2 效果律）两类因果 ──

export type TraitRuleContext = {
  childText: string;
  valence?: number; //     本轮情绪评分（抽取链已有）
  engagement?: number;
  prevTurn?: {
    valence?: number; //             上一轮孩子情绪（安抚效果归因用）
    assistantHadStory?: boolean; //  上一轮小可用了故事方式
    assistantHadHook?: boolean; //   上一轮小可用了悬念/提问引导
  };
};

export type TraitDelta = {
  dim: TraitDim;
  delta: number;
  rule: string;
  theory: GrowthTheory;
  note: string;
};

/** 小可回应的表达特征检测（下一轮强化归因的锚）。 */
export function detectAssistantFeatures(text: string): { story: boolean; hook: boolean } {
  const t = text ?? '';
  return {
    story: /从前|有一天|很久很久|传说|给你讲.{0,4}故事|故事/.test(t) || t.length > 80,
    hook: /你猜|为什么呢|要不要听|想不想知道|猜猜看/.test(t) || /[?？]\s*$/.test(t.trim()),
  };
}

export function computeTraitDeltas(ctx: TraitRuleContext): TraitDelta[] {
  const out: TraitDelta[] = [];
  const text = ctx.childText ?? '';
  const len = [...text].length;

  // 镜像·话语量已改为会话级（lsmTurn / computeLsmSessionDelta，2026-09-03 L1）：
  // 旧的逐轮「<8 字 ↓0.01」在生产 17 天触发 194 次净 −1.94，把三台设备的话语量压到 0.01——
  // 孩子原话 p50=5 字、66%<8 字（ASR 切句 + 儿童短答），量的是切句长度不是孩子的话。
  void len;

  // 镜像·活泼度：孩子的玩闹语气感染小可
  if (/哈哈|嘿嘿|嘻嘻|哇[!！]?|太好玩|好好玩|耶[!！]?|啦啦/.test(text)) {
    out.push({ dim: 'playfulness', delta: 0.01, rule: 'mirror_playful', theory: 'social_mirror',
      note: '孩子在玩闹大笑，小可也变得更活泼 ↑' });
  }

  // 强化·故事倾向（效果律）：上轮讲了故事 → 本轮孩子反馈定奖惩
  if (ctx.prevTurn?.assistantHadStory) {
    const v = ctx.valence ?? 0;
    const e = ctx.engagement ?? 0.5;
    if (v > 0.3 || e > 0.7) {
      out.push({ dim: 'storytelling', delta: 0.02, rule: 'reinforce_story_pos', theory: 'reinforcement',
        note: '讲故事之后孩子开心投入——故事这招对 ta 有效 ↑' });
    } else if (typeof ctx.engagement === 'number' && e < 0.3) {
      out.push({ dim: 'storytelling', delta: -0.01, rule: 'reinforce_story_neg', theory: 'reinforcement',
        note: '讲了故事但孩子有点敷衍——下次少用点 ↓' });
    }
  }

  // 强化·好奇引导：上轮抛了悬念 → 孩子追问=有效
  if (ctx.prevTurn?.assistantHadHook) {
    const follow = /为什么|然后呢|后来呢|还有吗|再讲|接着说/.test(text) || (ctx.engagement ?? 0) > 0.7;
    if (follow) {
      out.push({ dim: 'curiosity_feed', delta: 0.02, rule: 'reinforce_hook_pos', theory: 'reinforcement',
        note: '抛了悬念孩子果然追问——引导好奇有效 ↑' });
    }
  }

  // 强化·温柔度（粗归因，T2+T4）：上轮孩子低落、本轮情绪回正 → 安抚起效
  if (
    typeof ctx.prevTurn?.valence === 'number' && ctx.prevTurn.valence < -0.3 &&
    typeof ctx.valence === 'number' && ctx.valence > 0
  ) {
    out.push({ dim: 'gentleness', delta: 0.01, rule: 'comfort_effect', theory: 'reinforcement',
      note: '孩子从低落转回开心——温柔的安抚起了作用 ↑' });
  }

  return out;
}

// ── 会话级话语量镜像（L1，2026-09-03）：与孩子自己的长期中位数比，不用绝对阈值 ──

/** 每场会话最多动一次的步幅（= MAX_DELTA）。 */
export const LSM_SESSION_DELTA = 0.02;
/** 一场会话至少多少条合格原话才评一次（不足=这场不评）。 */
export const LSM_MIN_SAMPLES = 10;
/** 先攒多少场会话的个人基线才开始评（冷启动不评，防前几场把基线本身当偏离）。 */
export const LSM_MIN_SESSIONS = 2;
/** 本场中位数 / 长期中位数 的判定带：≥1.5 更啰嗦、≤0.67 更简短，中间不动。 */
export const LSM_LONG_RATIO = 1.5;
export const LSM_SHORT_RATIO = 0.67;
/** 长期中位数的 EMA 系数（新会话权重）。 */
export const LSM_EMA_ALPHA = 0.1; // 小一点：一场话多不至于把「平时」抬太高，下一场正常水平被判成简短（单测 lsm-13）
const LSM_SESSION_GAP_MS = 30 * 60_000; // 与 relation-state 会话切分同语义（各自独立常量，互不引用）

/** 纯应答/语气词不算「一句话」——它们量的是 ASR 切句，不是孩子想说多少。 */
const LSM_FILLER_RE = /^(?:嗯+|哦+|啊+|哈+|呀+|好+的?|好的呀?|好呀|好吧|好啦|对+|对的|是+的?|不+|不是|不要|不行|可以|行|没有|没|知道了|谢谢|再见|拜拜)[。！!？?~～，,、 ]*$/;

export function isLsmQualifyingUtterance(text: string): boolean {
  const t = (text ?? '').trim();
  if ([...t].length < 3) return false;
  return !LSM_FILLER_RE.test(t);
}

export function medianOf(nums: number[]): number {
  if (!nums.length) return 0;
  const a = [...nums].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid]! : (a[mid - 1]! + a[mid]!) / 2;
}

/**
 * 会话级镜像判定（纯函数，供单测）：本场合格原话中位数 vs 该孩子长期中位数（EMA）。
 * sessionsSeen < LSM_MIN_SESSIONS 或长期中位数无效 → null（冷启动不评）。
 */
export function computeLsmSessionDelta(
  sessionMedian: number,
  longRunMedian: number,
  sessionsSeen: number,
): TraitDelta | null {
  if (sessionsSeen < LSM_MIN_SESSIONS || !(longRunMedian > 0) || !(sessionMedian > 0)) return null;
  const ratio = sessionMedian / longRunMedian;
  if (ratio >= LSM_LONG_RATIO) {
    return { dim: 'talkativeness', delta: LSM_SESSION_DELTA, rule: 'mirror_lsm_session_long', theory: 'social_mirror',
      note: `这场孩子比平时爱说（中位 ${sessionMedian} 字 vs 平时 ${longRunMedian.toFixed(1)}），小可的话语量向 ta 靠近 ↑` };
  }
  if (ratio <= LSM_SHORT_RATIO) {
    return { dim: 'talkativeness', delta: -LSM_SESSION_DELTA, rule: 'mirror_lsm_session_short', theory: 'social_mirror',
      note: `这场孩子比平时简短（中位 ${sessionMedian} 字 vs 平时 ${longRunMedian.toFixed(1)}），小可学着更简洁 ↓` };
  }
  return null;
}

type LsmSession = { start: number; last: number; lens: number[]; applied: boolean };
/** 进程内会话缓冲（重启丢=当前这场不评，可接受；长期中位数落库不丢）。 */
const _lsmSessions = new Map<string, LsmSession>();

// ── 存储 ──

export type TraitState = Record<TraitDim, number> & { updated_at: number; last_decay_day: string };

class TraitStore {
  private readonly db: DatabaseSync;

  constructor() {
    const dbPath = resolveDbPath();
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trait_state (
        account_id     TEXT PRIMARY KEY,
        playfulness    REAL NOT NULL DEFAULT ${TRAIT_BASELINE.playfulness},
        talkativeness  REAL NOT NULL DEFAULT ${TRAIT_BASELINE.talkativeness},
        storytelling   REAL NOT NULL DEFAULT ${TRAIT_BASELINE.storytelling},
        gentleness     REAL NOT NULL DEFAULT ${TRAIT_BASELINE.gentleness},
        curiosity_feed REAL NOT NULL DEFAULT ${TRAIT_BASELINE.curiosity_feed},
        updated_at     INTEGER NOT NULL,
        last_decay_day TEXT NOT NULL DEFAULT ''
      );
    `);
    // P0 风格模板（2026-09-01）：家长为设备选定的说话风格档。只存 key——五维/文案在
    // style-template.ts 随代码迭代；有行=该账号基线被模板覆盖（弹簧回拉/漂移界锚点随之切换）。
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trait_template (
        account_id TEXT PRIMARY KEY,
        template   TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    // R3 每日快照（2026-09-03）：五维 + 模板，每账号每天一份（每日批路径同日只留第一份=回落前；
    // 退回前的「存今天」显式覆盖），admin 可退回任意一天
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trait_snapshot (
        account_id TEXT NOT NULL,
        day        TEXT NOT NULL,
        state      TEXT NOT NULL,
        template   TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        PRIMARY KEY (account_id, day)
      );
    `);
    // 语音调档 Phase A（2026-09-03）：记录是谁设的档（parent=家长端/admin，voice=孩子语音）；幂等加列
    try {
      this.db.exec(`ALTER TABLE trait_template ADD COLUMN source TEXT NOT NULL DEFAULT 'parent'`);
    } catch {
      /* 列已存在 */
    }
    // L1 会话级话语量镜像（2026-09-03）：孩子长期原话中位数 EMA + 已折算会话数；幂等加列
    for (const ddl of [
      `ALTER TABLE trait_state ADD COLUMN lsm_len_ema REAL NOT NULL DEFAULT 0`,
      `ALTER TABLE trait_state ADD COLUMN lsm_sessions INTEGER NOT NULL DEFAULT 0`,
    ]) {
      try {
        this.db.exec(ddl);
      } catch {
        /* 列已存在 */
      }
    }
  }

  /** 长期原话中位数状态（无行=0/0）。白盒与单测用。 */
  getLsmStats(accountId: string): { lenEma: number; sessions: number } {
    const row = this.db.prepare(`SELECT lsm_len_ema, lsm_sessions FROM trait_state WHERE account_id = ?`).get(accountId) as
      | { lsm_len_ema: number; lsm_sessions: number }
      | undefined;
    return { lenEma: row?.lsm_len_ema ?? 0, sessions: row?.lsm_sessions ?? 0 };
  }

  private foldLsmSession(accountId: string, sessionMedian: number): void {
    this.ensureRow(accountId);
    const { lenEma, sessions } = this.getLsmStats(accountId);
    const next = sessions === 0 ? sessionMedian : lenEma * (1 - LSM_EMA_ALPHA) + sessionMedian * LSM_EMA_ALPHA;
    this.db
      .prepare(`UPDATE trait_state SET lsm_len_ema = ?, lsm_sessions = ? WHERE account_id = ?`)
      .run(next, sessions + 1, accountId);
  }

  /**
   * 每轮喂入孩子原话：维护本场合格原话长度缓冲；跨 30min 即新会话（上一场 ≥5 条才折入长期中位数）；
   * 本场合格原话达 LSM_MIN_SAMPLES 时评一次（每场最多一次），返回 δ 或 null。零 LLM。
   */
  lsmTurn(accountId: string, childText: string, now = Date.now()): TraitDelta | null {
    let buf = _lsmSessions.get(accountId);
    if (!buf || now - buf.last > LSM_SESSION_GAP_MS) {
      if (buf && buf.lens.length >= 5) this.foldLsmSession(accountId, medianOf(buf.lens));
      buf = { start: now, last: now, lens: [], applied: false };
      _lsmSessions.set(accountId, buf);
      if (_lsmSessions.size > 500) _lsmSessions.clear(); // 容量兜底
    }
    buf.last = now;
    if (isLsmQualifyingUtterance(childText)) buf.lens.push([...childText.trim()].length);
    if (buf.applied || buf.lens.length < LSM_MIN_SAMPLES) return null;
    buf.applied = true;
    const { lenEma, sessions } = this.getLsmStats(accountId);
    return computeLsmSessionDelta(medianOf(buf.lens), lenEma, sessions);
  }

  /** 单测用：清进程内会话缓冲。 */
  resetLsmSessions(): void {
    _lsmSessions.clear();
  }

  /** 当前模板的来源（parent/voice）；无模板=null。白盒与家长端展示用。 */
  getTemplateSource(accountId: string): 'parent' | 'voice' | null {
    const row = this.db.prepare(`SELECT template, source FROM trait_template WHERE account_id = ?`).get(accountId) as
      | { template: string; source: string }
      | undefined;
    if (!row || !getStyleTemplate(row.template)) return null;
    return row.source === 'voice' ? 'voice' : 'parent';
  }

  /** 当前生效模板 key（无设置=null=出厂默认）。 */
  getTemplate(accountId: string): string | null {
    const row = this.db.prepare(`SELECT template FROM trait_template WHERE account_id = ?`).get(accountId) as
      | { template: string }
      | undefined;
    // 库里 key 对不上代码模板（模板下线/改名）→ 视为默认，fail-open
    return row && getStyleTemplate(row.template) ? row.template : null;
  }

  /** 模板设定时刻（毫秒时间戳；无模板=null）。P2 白盒可视化用。 */
  getTemplateSetAt(accountId: string): number | null {
    const row = this.db.prepare(`SELECT template, updated_at FROM trait_template WHERE account_id = ?`).get(accountId) as
      | { template: string; updated_at: number }
      | undefined;
    return row && getStyleTemplate(row.template) ? row.updated_at : null;
  }

  /** 该账号的有效基线：模板五维 ?? 出厂 TRAIT_BASELINE。回拉与漂移界都锚定它。 */
  baselineFor(accountId: string): Record<TraitDim, number> {
    const tpl = getStyleTemplate(this.getTemplate(accountId));
    return tpl ? tpl.dims : TRAIT_BASELINE;
  }

  /**
   * 家长选定风格模板：写模板行 + 当前特质值直接置为模板五维（立即可感知，不等 EMA 慢漂）+ 记账。
   * key='default' / clearTemplate = 恢复出厂：删模板行 + 特质值回出厂基线。
   */
  setTemplate(
    accountId: string,
    key: StyleTemplateKey | 'default',
    opts?: { source?: 'parent' | 'voice'; quote?: string },
  ): { template: string | null } {
    const source = opts?.source ?? 'parent';
    // 账本 rule 按写者分：家长端/admin=parent_style_template（🟠）；孩子语音=child_voice_style（🔵）
    const rule = source === 'voice' ? 'child_voice_style' : 'parent_style_template';
    const who = source === 'voice' ? '孩子' : '家长';
    const quoteNote = source === 'voice' && opts?.quote ? `孩子说「${opts.quote.slice(0, 30)}」→ ` : '';
    const prev = this.getTemplate(accountId);
    if (key === 'default') {
      this.db.prepare(`DELETE FROM trait_template WHERE account_id = ?`).run(accountId);
      this.resetDimsTo(
        accountId,
        TRAIT_BASELINE,
        prev ? `${quoteNote}${who}把风格从「${prev}」恢复为默认` : `${quoteNote}${who}选择默认风格`,
        rule,
        opts?.quote,
      );
      return { template: null };
    }
    const tpl = getStyleTemplate(key);
    if (!tpl) throw new Error(`未知风格模板: ${key}`);
    this.db
      .prepare(
        `INSERT INTO trait_template (account_id, template, updated_at, source) VALUES (?, ?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET template = excluded.template, updated_at = excluded.updated_at, source = excluded.source`,
      )
      .run(accountId, key, Date.now(), source);
    this.resetDimsTo(accountId, tpl.dims, `${quoteNote}${who}把说话风格设为「${tpl.name}」`, rule, opts?.quote);
    return { template: key };
  }

  /** 特质值整组置位（模板切换用）：逐维记账（from→to），温柔地板仍强制。rule 按写者（家长/孩子语音）分。 */
  private resetDimsTo(
    accountId: string,
    target: Record<TraitDim, number>,
    note: string,
    rule: string = 'parent_style_template',
    triggerQuote?: string,
  ): void {
    this.ensureRow(accountId);
    const cur = this.get(accountId);
    for (const dim of TRAIT_DIMS) {
      const from = cur[dim];
      const to = clampTrait(dim, target[dim], target[dim]);
      if (Math.abs(to - from) < 1e-9) continue;
      this.db.prepare(`UPDATE trait_state SET ${dim} = ?, updated_at = ? WHERE account_id = ?`).run(to, Date.now(), accountId);
      growthLedgerStore.record(accountId, {
        module: 'trait', dimension: TRAIT_LABELS[dim], from, to,
        rule, theory: 'setpoint', note, triggerQuote,
      });
    }
  }

  /** 读特质（无行=返回基线，不建行——特质行由第一次 adjust 创建）。 */
  get(accountId: string): TraitState {
    const row = this.db.prepare(`SELECT * FROM trait_state WHERE account_id = ?`).get(accountId) as
      | TraitState
      | undefined;
    if (row) return row;
    return { ...TRAIT_BASELINE, updated_at: 0, last_decay_day: '' } as TraitState;
  }

  private ensureRow(accountId: string): void {
    this.db
      .prepare(
        `INSERT INTO trait_state (account_id, updated_at) VALUES (?, ?)
         ON CONFLICT(account_id) DO NOTHING`,
      )
      .run(accountId, Date.now());
  }

  /** 今日（沪时）该维的有机位移总量（账本求和，排除档位/修复/回退/回落）。 */
  organicMovedToday(accountId: string, dim: TraitDim, now = Date.now()): number {
    const dayStart = new Date(`${cstDayOf(now)}T00:00:00+08:00`).getTime();
    let sum = 0;
    for (const e of growthLedgerStore.list(accountId, { module: 'trait', dimension: TRAIT_LABELS[dim], limit: 200 })) {
      if (e.ts < dayStart) break; // list 按 ts DESC
      if (NON_ORGANIC_RULES.has(e.rule)) continue;
      const d = Number(e.to_val) - Number(e.from_val);
      if (Number.isFinite(d)) sum += Math.abs(d);
    }
    return sum;
  }

  /**
   * R3 每日快照：当前五维 + 模板。默认同日不覆盖（每日批重跑/补跑时保住 3 点档回落前那份）；
   * overwrite=true 才覆盖（rollbackTo 退回前把当前状态存成今天，供反悔）。返回 day。
   */
  snapshotDaily(accountId: string, now = Date.now(), opts?: { overwrite?: boolean }): string {
    const day = cstDayOf(now);
    const cur = this.get(accountId);
    const state: Record<TraitDim, number> = { playfulness: cur.playfulness, talkativeness: cur.talkativeness, storytelling: cur.storytelling, gentleness: cur.gentleness, curiosity_feed: cur.curiosity_feed };
    this.db
      .prepare(`INSERT OR ${opts?.overwrite ? 'REPLACE' : 'IGNORE'} INTO trait_snapshot (account_id, day, state, template, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(accountId, day, JSON.stringify(state), this.getTemplate(accountId) ?? '', now);
    return day;
  }

  listSnapshots(accountId: string, limit = 30): { day: string; template: string; dims: Record<TraitDim, number>; created_at: number }[] {
    const rows = this.db
      .prepare(`SELECT day, state, template, created_at FROM trait_snapshot WHERE account_id = ? ORDER BY day DESC LIMIT ?`)
      .all(accountId, limit) as { day: string; state: string; template: string; created_at: number }[];
    const out: { day: string; template: string; dims: Record<TraitDim, number>; created_at: number }[] = [];
    for (const r of rows) {
      try { out.push({ day: r.day, template: r.template, dims: JSON.parse(r.state) as Record<TraitDim, number>, created_at: r.created_at }); } catch { /* 损坏快照跳过 */ }
    }
    return out;
  }

  /**
   * R3 退回到某天的快照：先把当前状态存成今天的快照（可再退回来），再恢复五维 + 模板，逐维记账 rule=rollback。
   * 返回实际变化的维数；快照不存在返回 -1。
   */
  rollbackTo(accountId: string, day: string, now = Date.now()): number {
    const row = this.db.prepare(`SELECT state, template FROM trait_snapshot WHERE account_id = ? AND day = ?`).get(accountId, day) as
      | { state: string; template: string }
      | undefined;
    if (!row) return -1;
    let dims: Partial<Record<TraitDim, number>>;
    try { dims = JSON.parse(row.state) as Partial<Record<TraitDim, number>>; } catch { return -1; }
    this.snapshotDaily(accountId, now, { overwrite: true }); // 退回前存今天（可反悔）——显式覆盖
    this.ensureRow(accountId);
    const curTpl = this.getTemplate(accountId) ?? '';
    if ((row.template || '') !== curTpl) {
      if (row.template && getStyleTemplate(row.template)) {
        this.db.prepare(`INSERT OR REPLACE INTO trait_template (account_id, template, updated_at, source) VALUES (?, ?, ?, 'parent')`).run(accountId, row.template, now);
      } else {
        this.db.prepare(`DELETE FROM trait_template WHERE account_id = ?`).run(accountId);
      }
    }
    const cur = this.get(accountId);
    let moved = 0;
    for (const dim of TRAIT_DIMS) {
      const target = dims[dim];
      if (typeof target !== 'number' || !Number.isFinite(target)) continue;
      const from = cur[dim];
      const to = Math.max(0, Math.min(1, target));
      if (Math.abs(to - from) < 1e-9) continue;
      this.db.prepare(`UPDATE trait_state SET ${dim} = ?, updated_at = ? WHERE account_id = ?`).run(to, now, accountId);
      moved += 1;
      growthLedgerStore.record(accountId, {
        module: 'trait', dimension: TRAIT_LABELS[dim], from, to,
        rule: 'rollback', theory: 'setpoint', note: `运营退回到 ${day} 的快照`,
      });
    }
    return moved;
  }

  /** 应用一批规则产出的 δ（每条硬 clamp ±0.02 + 界内 clip + 记账 + 每维每日有机位移上限 R3）。返回实际生效条数。 */
  applyDeltas(accountId: string, deltas: TraitDelta[], triggerQuote?: string): number {
    if (!deltas.length) return 0;
    this.ensureRow(accountId);
    const cur = this.get(accountId);
    const base = this.baselineFor(accountId); // 漂移界锚定家长模板基线（无模板=出厂）
    let applied = 0;
    const movedToday: Partial<Record<TraitDim, number>> = {};
    for (const d of deltas) {
      const delta = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, d.delta));
      if (!NON_ORGANIC_RULES.has(d.rule)) {
        const used = movedToday[d.dim] ?? this.organicMovedToday(accountId, d.dim);
        if (used + Math.abs(delta) > DAILY_ORGANIC_CAP + 1e-9) {
          console.log(`[trait] account=${accountId} ${TRAIT_LABELS[d.dim]} 今日有机位移已达上限(${used.toFixed(2)}/${DAILY_ORGANIC_CAP})，跳过 ${d.rule}`);
          movedToday[d.dim] = used;
          continue;
        }
        movedToday[d.dim] = used + Math.abs(delta);
      }
      const from = cur[d.dim];
      const to = clampTrait(d.dim, from + delta, base[d.dim]);
      if (Math.abs(to - from) < 1e-9) continue; // 到界/地板，无实际移动不记
      this.db
        .prepare(`UPDATE trait_state SET ${d.dim} = ?, updated_at = ? WHERE account_id = ?`)
        .run(to, Date.now(), accountId);
      cur[d.dim] = to;
      applied += 1;
      growthLedgerStore.record(accountId, {
        module: 'trait', dimension: TRAIT_LABELS[d.dim], from, to,
        triggerQuote, rule: d.rule, theory: d.theory, note: d.note,
      });
    }
    return applied;
  }

  /** 每日弹簧回拉（set-point 律）：每维向基线走 0.01；有实际移动才记账（「回落也是事件」）。 */
  dailyDecay(accountId: string): number {
    const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
    const row = this.db.prepare(`SELECT * FROM trait_state WHERE account_id = ?`).get(accountId) as
      | TraitState
      | undefined;
    if (!row || row.last_decay_day === today) return 0;
    const baselines = this.baselineFor(accountId); // 回拉目标=家长模板基线（无模板=出厂）
    let moved = 0;
    for (const dim of TRAIT_DIMS) {
      const from = row[dim];
      const base = baselines[dim];
      if (Math.abs(from - base) < 1e-9) continue;
      const step = Math.sign(base - from) * Math.min(DAILY_DECAY, Math.abs(base - from));
      const to = clampTrait(dim, from + step, base);
      if (Math.abs(to - from) < 1e-9) continue;
      this.db.prepare(`UPDATE trait_state SET ${dim} = ?, updated_at = ? WHERE account_id = ?`).run(to, Date.now(), accountId);
      moved += 1;
      growthLedgerStore.record(accountId, {
        module: 'trait', dimension: TRAIT_LABELS[dim], from, to,
        rule: 'daily_setpoint_decay', theory: 'setpoint',
        note: `一天没有新强化，${TRAIT_LABELS[dim]}向人设基线自然回落`,
      });
    }
    this.db.prepare(`UPDATE trait_state SET last_decay_day = ? WHERE account_id = ?`).run(today, accountId);
    return moved;
  }

  clear(accountId: string): boolean {
    return Number(this.db.prepare(`DELETE FROM trait_state WHERE account_id = ?`).run(accountId).changes) > 0;
  }

  /** 仅删模板行（admin 重置 scope=all「换孩子」场景；不记账——账本同轮已整体清空）。 */
  clearTemplate(accountId: string): boolean {
    return Number(this.db.prepare(`DELETE FROM trait_template WHERE account_id = ?`).run(accountId).changes) > 0;
  }
}

export const traitStore = new TraitStore();
