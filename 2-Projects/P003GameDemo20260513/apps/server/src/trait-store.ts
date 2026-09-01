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

const DEFAULT_DB_PATH = './data/profile.db';

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

  // 镜像·话语量（LSM 趋同）：孩子长句 → 小可可以多聊；孩子简短 → 小可简洁陪伴
  if (len > 25) {
    out.push({ dim: 'talkativeness', delta: 0.01, rule: 'mirror_lsm_long', theory: 'social_mirror',
      note: `孩子说了长句(${len}字)，小可的话语量向 ta 靠近 ↑` });
  } else if (len > 0 && len < 8) {
    out.push({ dim: 'talkativeness', delta: -0.01, rule: 'mirror_lsm_short', theory: 'social_mirror',
      note: `孩子简短应答(${len}字)，小可学着更简洁 ↓` });
  }

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
  setTemplate(accountId: string, key: StyleTemplateKey | 'default'): { template: string | null } {
    const prev = this.getTemplate(accountId);
    if (key === 'default') {
      this.db.prepare(`DELETE FROM trait_template WHERE account_id = ?`).run(accountId);
      this.resetDimsTo(accountId, TRAIT_BASELINE, prev ? `家长把风格从「${prev}」恢复为默认` : '家长选择默认风格');
      return { template: null };
    }
    const tpl = getStyleTemplate(key);
    if (!tpl) throw new Error(`未知风格模板: ${key}`);
    this.db
      .prepare(
        `INSERT INTO trait_template (account_id, template, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET template = excluded.template, updated_at = excluded.updated_at`,
      )
      .run(accountId, key, Date.now());
    this.resetDimsTo(accountId, tpl.dims, `家长把说话风格设为「${tpl.name}」`);
    return { template: key };
  }

  /** 特质值整组置位（模板切换用）：逐维记账（from→to），温柔地板仍强制。 */
  private resetDimsTo(accountId: string, target: Record<TraitDim, number>, note: string): void {
    this.ensureRow(accountId);
    const cur = this.get(accountId);
    for (const dim of TRAIT_DIMS) {
      const from = cur[dim];
      const to = clampTrait(dim, target[dim], target[dim]);
      if (Math.abs(to - from) < 1e-9) continue;
      this.db.prepare(`UPDATE trait_state SET ${dim} = ?, updated_at = ? WHERE account_id = ?`).run(to, Date.now(), accountId);
      growthLedgerStore.record(accountId, {
        module: 'trait', dimension: TRAIT_LABELS[dim], from, to,
        rule: 'parent_style_template', theory: 'setpoint', note,
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

  /** 应用一批规则产出的 δ（每条硬 clamp ±0.02 + 界内 clip + 记账）。返回实际生效条数。 */
  applyDeltas(accountId: string, deltas: TraitDelta[], triggerQuote?: string): number {
    if (!deltas.length) return 0;
    this.ensureRow(accountId);
    const cur = this.get(accountId);
    const base = this.baselineFor(accountId); // 漂移界锚定家长模板基线（无模板=出厂）
    let applied = 0;
    for (const d of deltas) {
      const delta = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, d.delta));
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
