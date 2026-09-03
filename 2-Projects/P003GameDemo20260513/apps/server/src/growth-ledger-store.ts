import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { isCrisisContent } from './memory-safety-filter.js';

// 成长账本（因果链方案 V1.1 §3.3）：小可人格成长的因果物质载体——每次状态/特质变化
// 记一条「因为什么(trigger_quote)、依据什么机制(rule/theory)、什么变成了什么(from→to)」。
// 账本是观测不是机制：只写不读主链，关掉/清空不影响任何行为（方案 §五.4 观察者效应红线）。

export type GrowthModule = 'relation' | 'style' | 'trait' | 'insight' | 'narrative' | 'concern' | 'local_audio' | 'profile' | 'filler';

// 理论标签（方案 §二 五条因果律）：state_to_trait=Fleeson/TESSERA 状态→特质固化；
// reinforcement=Thorndike/Skinner 效果律；social_mirror=Bandura/LSM 镜像趋同；
// attachment=Bowlby/Ainsworth 依恋换挡；setpoint=基线弹性回归。
export type GrowthTheory = 'state_to_trait' | 'reinforcement' | 'social_mirror' | 'attachment' | 'setpoint';

export type GrowthEvent = {
  id: string;
  account_id: string;
  ts: number;
  module: GrowthModule;
  dimension: string;
  from_val: string;
  to_val: string;
  trigger_quote: string;
  rule: string;
  theory: GrowthTheory;
  note: string;
};

const ACCOUNT_CAP = 800; // per-account 环形淘汰（方案 §3.3 治理）

const DEFAULT_DB_PATH = './data/profile.db';

function resolveDbPath(): string {
  const raw = process.env.PROFILE_DB_PATH?.trim() || DEFAULT_DB_PATH;
  return resolve(process.cwd(), raw);
}

function clip(raw: string, max: number): string {
  return [...(raw ?? '')]
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return !(code < 0x20 || code === 0x7f) && ch !== '<' && ch !== '>';
    })
    .join('')
    .trim()
    .slice(0, max);
}

class GrowthLedgerStore {
  private readonly db: DatabaseSync;

  constructor() {
    const dbPath = resolveDbPath();
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS growth_event (
        id            TEXT PRIMARY KEY,
        account_id    TEXT NOT NULL,
        ts            INTEGER NOT NULL,
        module        TEXT NOT NULL,
        dimension     TEXT NOT NULL,
        from_val      TEXT NOT NULL DEFAULT '',
        to_val        TEXT NOT NULL DEFAULT '',
        trigger_quote TEXT NOT NULL DEFAULT '',
        rule          TEXT NOT NULL,
        theory        TEXT NOT NULL,
        note          TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_growth_event_account_ts ON growth_event (account_id, ts DESC);
    `);
  }

  /**
   * 记一条因果事件。绝不抛（账本失败不影响任何主链）；trigger_quote 过危机过滤
   * （危机内容置空引用但保留事件——变化本身发生了，只是不留敏感原话）。
   */
  record(
    accountId: string,
    ev: {
      module: GrowthModule;
      dimension: string;
      from?: string | number | null;
      to?: string | number | null;
      triggerQuote?: string;
      rule: string;
      theory: GrowthTheory;
      note: string;
    },
  ): void {
    try {
      let quote = clip(ev.triggerQuote ?? '', 50);
      if (quote && isCrisisContent(quote)) quote = '';
      const fmt = (v: string | number | null | undefined) =>
        v === null || v === undefined ? '' : typeof v === 'number' ? String(Number(v.toFixed(3))) : clip(String(v), 60);
      this.db
        .prepare(
          `INSERT INTO growth_event
             (id, account_id, ts, module, dimension, from_val, to_val, trigger_quote, rule, theory, note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          randomUUID(), accountId, Date.now(), ev.module, clip(ev.dimension, 40),
          fmt(ev.from), fmt(ev.to), quote, clip(ev.rule, 40), ev.theory, clip(ev.note, 120),
        );
      // 环形淘汰：超上限删最旧（低频路径，count 查询可接受）
      const c = (this.db.prepare(`SELECT COUNT(*) AS c FROM growth_event WHERE account_id = ?`).get(accountId) as { c: number }).c;
      if (c > ACCOUNT_CAP) {
        this.db
          .prepare(
            `DELETE FROM growth_event WHERE account_id = ? AND id IN (
               SELECT id FROM growth_event WHERE account_id = ? ORDER BY ts ASC LIMIT ?
             )`,
          )
          .run(accountId, accountId, c - ACCOUNT_CAP);
      }
    } catch (err) {
      console.log('[ledger] 记账失败(不影响主链):', String((err as Error)?.message ?? err));
    }
  }

  list(accountId: string, opts?: { module?: string; dimension?: string; limit?: number }): GrowthEvent[] {
    const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
    const conds = ['account_id = ?'];
    const args: unknown[] = [accountId];
    if (opts?.module) { conds.push('module = ?'); args.push(opts.module); }
    if (opts?.dimension) { conds.push('dimension = ?'); args.push(opts.dimension); }
    args.push(limit);
    return this.db
      .prepare(`SELECT * FROM growth_event WHERE ${conds.join(' AND ')} ORDER BY ts DESC, rowid DESC LIMIT ?`)
      .all(...(args as never[])) as unknown as GrowthEvent[];
  }

  /** Phase C 雷达归因：某维度按时间倒序的 top 贡献事件。 */
  topContributors(accountId: string, dimension: string, limit = 5): GrowthEvent[] {
    return this.list(accountId, { dimension, limit });
  }

  count(accountId: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS c FROM growth_event WHERE account_id = ?`).get(accountId) as { c: number }).c;
  }

  clear(accountId: string): number {
    return Number(this.db.prepare(`DELETE FROM growth_event WHERE account_id = ?`).run(accountId).changes);
  }
}

export const growthLedgerStore = new GrowthLedgerStore();
