import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// M3 孩子行为画像存储（人格成长方案 §M3，KnowMe 方法论骨架）：
// 五维行为观察 + 证据片段 + 样本量置信度。单行最新版（覆盖式更新，每日批写入）。
// 伦理边界（照搬 KnowMe）：方向性观察非诊断；不推断受保护属性；维度是教育观察向，不是人格标签。

export type InsightDim = {
  observation: string; // ≤30 字
  evidence: string; //   孩子原话片段（写入前已做子串存在性硬校验，同 promise C1 思想）
  strength: 'low' | 'medium' | 'high';
};

export type ChildInsight = {
  account_id: string;
  dims: Record<string, InsightDim>; // expression_style/curiosity_mode/emotion_expression/learning_preference/interest_trend
  sample_msgs: number;
  confidence: 'low' | 'directional' | 'stable'; // KnowMe 分级：<20 / 20-49 / 50+
  window_days: number;
  updated_at: number;
};

const DEFAULT_DB_PATH = './data/profile.db';

function resolveDbPath(): string {
  const raw = process.env.PROFILE_DB_PATH?.trim() || DEFAULT_DB_PATH;
  return resolve(process.cwd(), raw);
}

export function confidenceOf(sampleMsgs: number): ChildInsight['confidence'] {
  if (sampleMsgs < 20) return 'low';
  if (sampleMsgs < 50) return 'directional';
  return 'stable';
}

class ChildInsightStore {
  private readonly db: DatabaseSync;

  constructor() {
    const dbPath = resolveDbPath();
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS child_insight (
        account_id  TEXT PRIMARY KEY,
        dims        TEXT NOT NULL,
        sample_msgs INTEGER NOT NULL,
        confidence  TEXT NOT NULL,
        window_days INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
    `);
  }

  set(accountId: string, dims: Record<string, InsightDim>, sampleMsgs: number, windowDays: number): void {
    this.db
      .prepare(
        `INSERT INTO child_insight (account_id, dims, sample_msgs, confidence, window_days, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET
           dims = excluded.dims, sample_msgs = excluded.sample_msgs,
           confidence = excluded.confidence, window_days = excluded.window_days,
           updated_at = excluded.updated_at`,
      )
      .run(accountId, JSON.stringify(dims), sampleMsgs, confidenceOf(sampleMsgs), windowDays, Date.now());
  }

  get(accountId: string): ChildInsight | null {
    const row = this.db.prepare(`SELECT * FROM child_insight WHERE account_id = ?`).get(accountId) as
      | (Omit<ChildInsight, 'dims'> & { dims: string })
      | undefined;
    if (!row) return null;
    try {
      return { ...row, dims: JSON.parse(row.dims) as Record<string, InsightDim> };
    } catch {
      return null; // 损坏数据不进注入路径
    }
  }

  clear(accountId: string): boolean {
    return Number(this.db.prepare(`DELETE FROM child_insight WHERE account_id = ?`).run(accountId).changes) > 0;
  }
}

export const childInsightStore = new ChildInsightStore();
