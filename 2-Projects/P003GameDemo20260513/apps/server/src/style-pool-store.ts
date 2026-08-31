import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { growthLedgerStore } from './growth-ledger-store.js';

// M4 有效经验晶化（人格成长方案 §M4，OpenHer style_memory 简化移植）：
// 「对这个孩子什么方式有效」沉淀为可检索的习惯。per-account 池，情境 KNN + 质量引力 +
// Hawking 时间衰减（不用的经验淡去）。零 LLM：晶化门用抽取链已有的 turn 评分，内容存原文截断。
// 与 OpenHer 的差异（方案 §五不搬清单）：无随机网络/无 Hebbian/无热力学噪声——全部显式可审计。

export type StyleEntry = {
  id: string;
  account_id: string;
  vector: number[]; //   4 维情境：[沪时归一, 气氛(0..1), 投入度(0..1), 会话深度(0..1)]
  child_said: string;
  xiaoke_did: string;
  mass: number;
  created_at: number;
  last_used_at: number;
};

const MERGE_DIST = 0.25; //     近邻合并阈值（OpenHer 同值）
const HAWKING_GAMMA = 0.001; // 每小时衰减 ≈30 天半衰期；基底 mass=1 永不蒸发
const POOL_CAP = 30; //         per-account 上限，超限淘汰 mass_eff 最小者
const CRYSTAL_THRESHOLD = 0.5;

const DEFAULT_DB_PATH = './data/profile.db';

function resolveDbPath(): string {
  const raw = process.env.PROFILE_DB_PATH?.trim() || DEFAULT_DB_PATH;
  return resolve(process.cwd(), raw);
}

function l2(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - (b[i] ?? 0)) ** 2;
  return Math.sqrt(s);
}

export function hawkingMass(massRaw: number, lastUsedAt: number, now: number): number {
  const dh = Math.max(0, (now - lastUsedAt) / 3600_000);
  return 1 + Math.max(0, massRaw - 1) * Math.exp(-HAWKING_GAMMA * dh);
}

/** 晶化门（儿童版复合分，方案 §M4）：好的(valence)+投入的(engagement)+聊开了的(depth)才值得记。 */
export function crystalScore(valence: number | undefined, engagement: number | undefined, userTurns: number): number {
  if (valence === undefined && engagement === undefined) return 0; // 无信号不判定
  return 0.5 * Math.max(0, valence ?? 0) + 0.3 * (engagement ?? 0) + 0.2 * (userTurns >= 3 ? 1 : 0);
}

export function shouldCrystallize(valence: number | undefined, engagement: number | undefined, userTurns: number): boolean {
  return crystalScore(valence, engagement, userTurns) > CRYSTAL_THRESHOLD;
}

class StylePoolStore {
  private readonly db: DatabaseSync;

  constructor() {
    const dbPath = resolveDbPath();
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS style_pool (
        id           TEXT PRIMARY KEY,
        account_id   TEXT NOT NULL,
        vector       TEXT NOT NULL,
        child_said   TEXT NOT NULL,
        xiaoke_did   TEXT NOT NULL,
        mass         REAL NOT NULL DEFAULT 2,
        created_at   INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_style_pool_account ON style_pool (account_id);
    `);
  }

  private listAll(accountId: string): StyleEntry[] {
    const rows = this.db
      .prepare(`SELECT * FROM style_pool WHERE account_id = ?`)
      .all(accountId) as unknown as (Omit<StyleEntry, 'vector'> & { vector: string })[];
    return rows.map((r) => ({ ...r, vector: JSON.parse(r.vector) as number[] }));
  }

  /**
   * 晶化：近邻(<0.25) → 引力增厚 mass+1 刷新时间戳（内容保留原有，新内容更长才覆盖——
   * OpenHer 同款「不覆盖独特记忆」）；否则新建 mass=2。超限淘汰 mass_eff 最小者。
   */
  crystallize(accountId: string, vector: number[], childSaid: string, xiaokeDid: string): 'merged' | 'new' {
    const now = Date.now();
    const pool = this.listAll(accountId);
    let best: StyleEntry | null = null;
    let bestDist = Infinity;
    for (const e of pool) {
      const d = l2(vector, e.vector);
      if (d < bestDist) { bestDist = d; best = e; }
    }
    if (best && bestDist < MERGE_DIST) {
      const overwrite = xiaokeDid.length > best.xiaoke_did.length;
      this.db
        .prepare(`UPDATE style_pool SET mass = mass + 1, last_used_at = ?, child_said = ?, xiaoke_did = ? WHERE id = ?`)
        .run(now, overwrite ? childSaid : best.child_said, overwrite ? xiaokeDid : best.xiaoke_did, best.id);
      // 成长账本：引力增厚（状态→特质固化律——相近情境反复奏效，习惯变重）
      growthLedgerStore.record(accountId, {
        module: 'style', dimension: '经验池', from: best.mass, to: best.mass + 1,
        triggerQuote: childSaid, rule: 'crystallize_merge', theory: 'state_to_trait',
        note: `相近情境的有效方式再次奏效，经验增厚 mass ${best.mass}→${best.mass + 1}`,
      });
      return 'merged';
    }
    this.db
      .prepare(`INSERT INTO style_pool (id, account_id, vector, child_said, xiaoke_did, mass, created_at, last_used_at)
                VALUES (?, ?, ?, ?, ?, 2, ?, ?)`)
      .run(randomUUID(), accountId, JSON.stringify(vector.map((v) => Number(v.toFixed(4)))), childSaid, xiaokeDid, now, now);
    // 成长账本：新经验入池（效果律——这个方式在这个情境第一次被验证有效）
    growthLedgerStore.record(accountId, {
      module: 'style', dimension: '经验池', from: '—', to: 'mass 2',
      triggerQuote: childSaid, rule: 'crystallize_new', theory: 'reinforcement',
      note: `新的有效相处方式入池：小可「${xiaokeDid.slice(0, 30)}…」让孩子开心投入`,
    });
    // 超限淘汰：mass_eff 最小者（时间衰减后最「轻」的经验先走）
    const after = this.listAll(accountId);
    if (after.length > POOL_CAP) {
      const scored = after
        .map((e) => ({ id: e.id, eff: hawkingMass(e.mass, e.last_used_at, now) }))
        .sort((a, b) => a.eff - b.eff);
      const evict = scored.slice(0, after.length - POOL_CAP);
      const del = this.db.prepare(`DELETE FROM style_pool WHERE id = ?`);
      for (const v of evict) del.run(v.id);
    }
    return 'new';
  }

  /** 检索：effective_dist = 物理距离/√mass_eff——质量大的经验引力大；命中刷新 last_used_at。 */
  retrieve(accountId: string, vector: number[], topK = 2): (StyleEntry & { mass_eff: number; dist: number })[] {
    const now = Date.now();
    const pool = this.listAll(accountId);
    const scored = pool
      .map((e) => {
        const eff = hawkingMass(e.mass, e.last_used_at, now);
        return { ...e, mass_eff: eff, dist: l2(vector, e.vector) / Math.sqrt(Math.max(eff, 0.01)) };
      })
      .sort((a, b) => a.dist - b.dist)
      .slice(0, topK);
    const upd = this.db.prepare(`UPDATE style_pool SET last_used_at = ? WHERE id = ?`);
    for (const e of scored) upd.run(now, e.id);
    return scored;
  }

  count(accountId: string): number {
    const r = this.db.prepare(`SELECT COUNT(*) AS c FROM style_pool WHERE account_id = ?`).get(accountId) as { c: number };
    return r.c;
  }

  clear(accountId: string): number {
    const r = this.db.prepare(`DELETE FROM style_pool WHERE account_id = ?`).run(accountId);
    return Number(r.changes);
  }
}

export const stylePoolStore = new StylePoolStore();
