import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isCrisisContent } from './memory-safety-filter.js';
import { growthLedgerStore } from './growth-ledger-store.js';

// Phase 1 typed 情景记忆(docs/43 §8 定稿):promise/event/emotion/relation/preference。
// 与 family_member 同库(profile.db)不同表——profile.db 仍是孩子记忆的唯一物理真相源;
// 独立文件 = 独立域高内聚(团队评审后的 schema 全在这里,别散进 profile-store)。
// 并发安全同 profile-store 范式:DatabaseSync 全同步方法(无 await 间隙=原子),
// 双链路(WS pipeline / RTC custom-llm)回调在事件循环里串行执行,不会 lost update。

// concern：P0 人格成长 M5 foresight（方案 §M5）——「值得关心的事」（明天考试/换牙/和同学闹别扭），
// 带 due 复用 promise 的解析链；due 过后 7 天惰性归档（不像 promise 永不淘汰——关心过期就翻篇）。
export type MemoryType = 'promise' | 'event' | 'emotion' | 'relation' | 'preference' | 'concern';

export type MemoryItem = {
  id: string;
  account_id: string;
  type: MemoryType;
  content: string;
  subject: string; // promise:'xiaoke'|'child';relation:人名;其余 ''
  status: 'active' | 'resolved' | 'retracted' | 'archived';
  confidence: number;
  source: string; // voice | parent | system
  session_id: string; // 溯源(评审 C3)
  source_role: string; // user | assistant(评审 C1:promise by=xiaoke 必须来自 assistant)
  source_quote: string; // 证据原话片段(评审 C1,服务端校验后存档)
  due_text: string; // promise 原始时间表达(评审 X1:"明天"/"周五"/"下次")
  due_at: number | null; // 解析出的绝对时间;解析不了为 null
  due_granularity: string; // day | next_session | unknown | ''
  meta: string; // JSON 扩展(评审 C3)
  created_at: number;
  last_injected_at: number; // 注入回执,异步写(评审 X3:绝不在读路径同步写)
  resolved_at: number | null;
};

export type NewMemoryItem = {
  type: MemoryType;
  content: string;
  subject?: string;
  confidence?: number;
  source?: string;
  session_id?: string;
  source_role?: string;
  source_quote?: string;
  due_text?: string;
};

// 非 promise 类的存量上限(写时淘汰最旧;promise 永不淘汰——评审 X2:淘汰 active promise=系统性失约)。
const TYPE_CAP: Record<Exclude<MemoryType, 'promise'>, number> = {
  event: 30,
  emotion: 60,
  relation: 8,
  preference: 10,
  concern: 8,
};
const PROMISE_ACTIVE_WARN = 8; // active promise 超过则 log 警告(不淘汰,人工看)
const EMOTION_ARCHIVE_MS = 30 * 24 * 3600 * 1000; // emotion 30 天归档(评审 C4)
const CONCERN_ARCHIVE_AFTER_DUE_MS = 7 * 24 * 3600 * 1000; // concern due 过后 7 天归档(无 due 按 created_at)

const DEFAULT_DB_PATH = './data/profile.db';

function resolveDbPath(): string {
  const raw = process.env.PROFILE_DB_PATH?.trim() || DEFAULT_DB_PATH;
  return resolve(process.cwd(), raw);
}

/**
 * due_text 规则解析(评审 X1)。零 LLM:只认高频儿童口语时间词,认不出 → unknown(注入端按"下次见面"渲染)。
 * 返回 due_at=当天 23:59:59 本地时间(粒度到天足够——小可只需判断"今天该兑现/已过期")。
 */
export function parseDue(dueText: string, now = Date.now()): { due_at: number | null; due_granularity: string } {
  const t = (dueText || '').trim();
  if (!t) return { due_at: null, due_granularity: '' };
  const endOfDay = (offsetDays: number): number => {
    const d = new Date(now);
    d.setDate(d.getDate() + offsetDays);
    d.setHours(23, 59, 59, 0);
    return d.getTime();
  };
  if (/今天|今晚|一会|等下|待会/.test(t)) return { due_at: endOfDay(0), due_granularity: 'day' };
  if (/明天|明晚/.test(t)) return { due_at: endOfDay(1), due_granularity: 'day' };
  if (/后天/.test(t)) return { due_at: endOfDay(2), due_granularity: 'day' };
  const wk = /(?:周|星期|礼拜)([一二三四五六日天])/.exec(t);
  if (wk) {
    const map: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
    const target = map[wk[1]];
    const cur = new Date(now).getDay();
    let diff = (target - cur + 7) % 7;
    if (diff === 0) diff = 7; // "周五说的周五" 指下一个周五
    return { due_at: endOfDay(diff), due_granularity: 'day' };
  }
  if (/下次|下回|以后|再见面|见面/.test(t)) return { due_at: null, due_granularity: 'next_session' };
  return { due_at: null, due_granularity: 'unknown' };
}

class MemoryItemStore {
  private readonly db: DatabaseSync;

  constructor() {
    const dbPath = resolveDbPath();
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_item (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        subject TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        confidence REAL NOT NULL DEFAULT 0.7,
        source TEXT NOT NULL DEFAULT 'voice',
        session_id TEXT NOT NULL DEFAULT '',
        source_role TEXT NOT NULL DEFAULT '',
        source_quote TEXT NOT NULL DEFAULT '',
        due_text TEXT NOT NULL DEFAULT '',
        due_at INTEGER,
        due_granularity TEXT NOT NULL DEFAULT '',
        meta TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        last_injected_at INTEGER NOT NULL DEFAULT 0,
        resolved_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_item_dedup ON memory_item (account_id, type, content);
      CREATE INDEX IF NOT EXISTS idx_memory_item_sel ON memory_item (account_id, type, status);
    `);
    // schema 版本(评审 C3):v1。后续加列走 user_version 判断 + ALTER。
    const v = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (v < 1) this.db.exec('PRAGMA user_version = 1');
  }

  /**
   * 批量写入(抽取器产出)。同步原子;UNIQUE(account,type,content) ON CONFLICT IGNORE 防双链路重复写。
   * 非 promise 类写后淘汰超限最旧;promise 永不淘汰(评审 X2),active 超 8 条仅 log 警告。
   */
  addItems(accountId: string, rawItems: NewMemoryItem[]): number {
    // 安全兜底：危机内容(自伤/自杀/极端家庭压力)绝不进记忆系统——临时关键词规则，
    // 科学的儿童安全防护(实时识别+分级干预)待产品设计后叠加(见 memory-safety-filter.ts)。
    const items = rawItems.filter((it) => !isCrisisContent(it.content));
    if (!items.length) return 0;
    const now = Date.now();
    const ins = this.db.prepare(`
      INSERT INTO memory_item (id, account_id, type, content, subject, status, confidence, source,
        session_id, source_role, source_quote, due_text, due_at, due_granularity, meta,
        created_at, last_injected_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, 0, NULL)
      ON CONFLICT (account_id, type, content) DO NOTHING
    `);
    let added = 0;
    for (const it of items) {
      const due =
        it.type === 'promise' || it.type === 'concern'
          ? parseDue(it.due_text ?? '', now)
          : { due_at: null, due_granularity: '' };
      const r = ins.run(
        randomUUID(), accountId, it.type, it.content, it.subject ?? '',
        it.confidence ?? 0.7, it.source ?? 'voice',
        it.session_id ?? '', it.source_role ?? '', it.source_quote ?? '',
        it.due_text ?? '', due.due_at, due.due_granularity, now,
      );
      added += Number(r.changes);
      // 成长账本：concern 真实入库时记（changes>0 才记——UNIQUE 去重命中的不算新事件）
      if (it.type === 'concern' && Number(r.changes) > 0) {
        growthLedgerStore.record(accountId, {
          module: 'concern', dimension: '值得关心', from: '—', to: it.content,
          triggerQuote: it.content, rule: 'concern_extracted', theory: 'attachment',
          note: `记下值得关心的事：「${it.content}」${it.due_text ? `（${it.due_text}）` : ''}`,
        });
      }
    }
    // 写后治理:非 promise 超限淘汰(retracted 化,非物理删,审计保留)
    for (const [type, cap] of Object.entries(TYPE_CAP)) {
      this.db.prepare(`
        UPDATE memory_item SET status = 'retracted', resolved_at = ?
        WHERE status = 'active' AND account_id = ? AND type = ? AND id NOT IN (
          SELECT id FROM memory_item WHERE status = 'active' AND account_id = ? AND type = ?
          ORDER BY created_at DESC LIMIT ${cap}
        )
      `).run(now, accountId, type, accountId, type);
    }
    const activePromises = this.countActive(accountId, 'promise');
    if (activePromises > PROMISE_ACTIVE_WARN) {
      console.warn(`[memory-item] account=${accountId} active promise=${activePromises} 超警戒线(不淘汰,建议人工看)`);
    }
    return added;
  }

  /** promise 兑现:按 id 精确 resolve(评审 C2:绝不按 content 子串消账)。返回实际 resolve 条数。 */
  resolvePromisesByIds(accountId: string, ids: string[], evidence = ''): number {
    if (!ids.length) return 0;
    const now = Date.now();
    const upd = this.db.prepare(`
      UPDATE memory_item SET status = 'resolved', resolved_at = ?,
        meta = json_set(meta, '$.resolved_evidence', ?)
      WHERE id = ? AND account_id = ? AND type = 'promise' AND status = 'active'
    `);
    let n = 0;
    for (const id of ids) n += Number(upd.run(now, evidence.slice(0, 120), id, accountId).changes);
    return n;
  }

  /** LLM/系统撤销 = 软删(审计保留)。 */
  retract(accountId: string, id: string): boolean {
    const r = this.db.prepare(`
      UPDATE memory_item SET status = 'retracted', resolved_at = ? WHERE id = ? AND account_id = ?
    `).run(Date.now(), id, accountId);
    return Number(r.changes) > 0;
  }

  /**
   * 撤回/淘汰过的条目按原 content 复活（2026-09-03 不喜欢撤回的对称路径）：UNIQUE(account,type,content)
   * 让同内容重插静默失败，孩子本轮又明确说不喜欢时由抽取器调用复活。只动非 active 行；返回是否复活。
   */
  reviveIfRetracted(accountId: string, type: MemoryType, content: string, sessionId = ''): boolean {
    const r = this.db.prepare(`
      UPDATE memory_item SET status = 'active', created_at = ?, resolved_at = NULL, session_id = ?
      WHERE account_id = ? AND type = ? AND content = ? AND status IN ('retracted', 'archived')
    `).run(Date.now(), sessionId, accountId, type, content);
    return Number(r.changes) > 0;
  }

  /** 家长/admin 删除 = 物理删除(评审 C4:儿童数据删除权)。 */
  hardDelete(id: string): boolean {
    const r = this.db.prepare('DELETE FROM memory_item WHERE id = ?').run(id);
    return Number(r.changes) > 0;
  }

  /** 面板用户删除:归属校验版物理删(儿童数据删除权;admin 的 hardDelete 保持原样)。 */
  hardDeleteOwned(accountId: string, id: string): boolean {
    const r = this.db.prepare('DELETE FROM memory_item WHERE id = ? AND account_id = ?').run(id, accountId);
    return r.changes > 0;
  }

  /** 按"不喜欢了"的内容撤销 preference/event 同名项(抽取器 dislike 联动用,精确 content 匹配)。 */
  retractByContent(accountId: string, type: MemoryType, content: string): boolean {
    const r = this.db.prepare(`
      UPDATE memory_item SET status = 'retracted', resolved_at = ?
      WHERE account_id = ? AND type = ? AND content = ? AND status = 'active'
    `).run(Date.now(), accountId, type, content);
    return Number(r.changes) > 0;
  }

  /**
   * 注入选取(评审 G1/X2/C4):纯 SQL 毫秒级,读路径零 LLM/零写。
   * promise ≤3:due_at 非空升序优先(快到期/已过期在前),再 created_at 最新;
   * relation 全部(≤8)/preference ≤5/emotion 最近3(30天内,顺带把过期的归档)/event 最近5(30天内)。
   */
  selectForInjection(accountId: string): {
    promises: MemoryItem[]; events: MemoryItem[]; emotions: MemoryItem[];
    relations: MemoryItem[]; preferences: MemoryItem[]; concerns: MemoryItem[];
  } {
    const now = Date.now();
    // emotion 惰性归档(30 天,评审 C4):选取前顺带执行,同步毫秒级
    this.db.prepare(`
      UPDATE memory_item SET status = 'archived'
      WHERE account_id = ? AND type = 'emotion' AND status = 'active' AND created_at < ?
    `).run(accountId, now - EMOTION_ARCHIVE_MS);
    // concern 惰性归档(M5)：due 过后 7 天(无 due 按 created_at 起算)——关心过期就翻篇
    // 归档前取待翻篇条目做成长账本记录（低频路径）
    const expiring = this.db.prepare(`
      SELECT content FROM memory_item
      WHERE account_id = ? AND type = 'concern' AND status = 'active' AND COALESCE(due_at, created_at) < ?
    `).all(accountId, now - CONCERN_ARCHIVE_AFTER_DUE_MS) as { content: string }[];
    this.db.prepare(`
      UPDATE memory_item SET status = 'archived'
      WHERE account_id = ? AND type = 'concern' AND status = 'active'
        AND COALESCE(due_at, created_at) < ?
    `).run(accountId, now - CONCERN_ARCHIVE_AFTER_DUE_MS);
    for (const e of expiring) {
      growthLedgerStore.record(accountId, {
        module: 'concern', dimension: '值得关心', from: e.content, to: '已翻篇',
        rule: 'concern_expire_7d', theory: 'setpoint',
        note: `「${e.content}」到期一周，自然翻篇`,
      });
    }

    const q = (sql: string, ...args: unknown[]) =>
      this.db.prepare(sql).all(...(args as never[])) as unknown as MemoryItem[];
    const promises = q(`
      SELECT * FROM memory_item WHERE account_id = ? AND type = 'promise' AND status = 'active'
      ORDER BY (due_at IS NULL) ASC, due_at ASC, created_at DESC LIMIT 3
    `, accountId);
    const relations = q(`
      SELECT * FROM memory_item WHERE account_id = ? AND type = 'relation' AND status = 'active'
      ORDER BY created_at DESC LIMIT 8
    `, accountId);
    const preferences = q(`
      SELECT * FROM memory_item WHERE account_id = ? AND type = 'preference' AND status = 'active'
      ORDER BY created_at DESC LIMIT 5
    `, accountId);
    const emotions = q(`
      SELECT * FROM memory_item WHERE account_id = ? AND type = 'emotion' AND status = 'active'
      ORDER BY created_at DESC LIMIT 3
    `, accountId);
    const events = q(`
      SELECT * FROM memory_item WHERE account_id = ? AND type = 'event' AND status = 'active' AND created_at > ?
      ORDER BY created_at DESC LIMIT 5
    `, accountId, now - EMOTION_ARCHIVE_MS);
    const concerns = q(`
      SELECT * FROM memory_item WHERE account_id = ? AND type = 'concern' AND status = 'active'
      ORDER BY (due_at IS NULL) ASC, due_at ASC, created_at DESC LIMIT 3
    `, accountId);
    return { promises, events, emotions, relations, preferences, concerns };
  }

  /** 注入回执:只在 fire-and-forget 异步路径调用(评审 X3:读路径绝不同步写)。 */
  markInjected(ids: string[]): void {
    if (!ids.length) return;
    const now = Date.now();
    const upd = this.db.prepare('UPDATE memory_item SET last_injected_at = ? WHERE id = ?');
    for (const id of ids) upd.run(now, id);
  }

  /** 未兑现约定(给抽取器 known 上下文 + resolve 短 id 映射用)。 */
  /** 兴趣 dislike 对撞用（2026-08-23）：该账号 active 的「不喜欢」类偏好条目。 */
  listActiveDislikes(accountId: string): MemoryItem[] {
    return this.db
      .prepare(
        `SELECT * FROM memory_item WHERE account_id = ? AND status = 'active'
         AND type = 'preference' AND content LIKE '不喜欢%' ORDER BY created_at DESC`,
      )
      .all(accountId) as MemoryItem[];
  }

  listActivePromises(accountId: string): MemoryItem[] {
    return this.db.prepare(`
      SELECT * FROM memory_item WHERE account_id = ? AND type = 'promise' AND status = 'active'
      ORDER BY created_at ASC
    `).all(accountId) as unknown as MemoryItem[];
  }

  /** admin/家长端:列该账号全部(archived 的 emotion 不返回原文——评审 C4,只给趋势统计)。 */
  listByAccount(accountId: string): { items: MemoryItem[]; archived_emotion_count: number } {
    const items = this.db.prepare(`
      SELECT * FROM memory_item WHERE account_id = ? AND NOT (type = 'emotion' AND status = 'archived')
      ORDER BY created_at DESC
    `).all(accountId) as unknown as MemoryItem[];
    const row = this.db.prepare(`
      SELECT COUNT(*) AS c FROM memory_item WHERE account_id = ? AND type = 'emotion' AND status = 'archived'
    `).get(accountId) as { c: number };
    return { items, archived_emotion_count: row?.c ?? 0 };
  }

  private countActive(accountId: string, type: MemoryType): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS c FROM memory_item WHERE account_id = ? AND type = ? AND status = ?',
    ).get(accountId, type, 'active') as { c: number };
    return row?.c ?? 0;
  }

  /** 测试清理用。 */
  deleteByAccountId(accountId: string): void {
    this.db.prepare('DELETE FROM memory_item WHERE account_id = ?').run(accountId);
  }

  /** 全库隔离对照（运营台租户隔离白盒）：active 总数 + 涉及账号数——与单账号计数并排展示数据边界。 */
  globalStats(): { total_active: number; distinct_accounts: number } {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS n, COUNT(DISTINCT account_id) AS a FROM memory_item WHERE status = 'active'`,
    ).get() as { n: number; a: number };
    return { total_active: Number(row?.n ?? 0), distinct_accounts: Number(row?.a ?? 0) };
  }

  /** 逐账号统计（全局隔离总览）：total 含 retracted/archived——孤儿检查要看全状态，悬空数据不因下架而豁免。 */
  perAccountStats(): Array<{ account_id: string; active_n: number; total_n: number }> {
    return this.db.prepare(`
      SELECT account_id,
             SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_n,
             COUNT(*) AS total_n
      FROM memory_item GROUP BY account_id
    `).all() as Array<{ account_id: string; active_n: number; total_n: number }>;
  }
}

export const memoryItemStore = new MemoryItemStore();
