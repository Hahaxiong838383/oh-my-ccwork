import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * job_run · 每日批「当天跑过」的落库标记 + 租约（2026-09-03）。
 *
 * 背景：persona 每日批的标记以前只在进程内存（lastRunDay）。白天每次部署重启都会让下一个 tick
 * 判定「今天还没跑」再跑一遍——09-03 当天实测跑了 6 次：特质回落有 last_decay_day 守卫没重复，
 * 但洞察/叙事没有同日守卫，账本被大模型同义改写刷进 56 条假「观察更新」，小笔记一天重写 6 版，
 * 当日快照也被最后一次覆盖。codex 同日提出「改成数据库持久化的日期唯一锁/任务租约」，即本文件。
 *
 * 语义：
 * - claim(job, day)：INSERT OR IGNORE 原子认领，成功=claimed；已存在且已 finished=done；
 *   已存在未 finished 且 started_at 超过租约=视为上次进程崩了，条件 UPDATE 抢到=reclaimed，否则 busy。
 * - finish(job, day)：跑完标 finished_at。跑到一半进程没了就不标，租约到期后允许补跑一次。
 * - peek：同 claim 的判定但不落库（生产探针/干跑用）。
 * - seedDone：运维用，把某天直接标成已完成（上线当天必做，否则部署后的第一个 tick 照样补跑）。
 * 单实例 fork 下这把锁防的是「重启补跑」；将来若多实例，INSERT 的唯一键同样只让一个进程认领成功。
 */

const DEFAULT_DB_PATH = './data/profile.db';
/** 认领后超过这么久还没标完成 = 上一次进程死在半路，允许重新认领。每日批实测单次 ≤5 分钟。 */
export const JOB_LEASE_MS = 2 * 3600_000;

export type ClaimResult = 'claimed' | 'reclaimed' | 'done' | 'busy';

export interface JobRunRow {
  job: string;
  day: string;
  started_at: number;
  finished_at: number | null;
  pid: number | null;
  note: string;
}

/** 沪时日期（+8h 偏移法，与 trait-store / insight-runner 同口径）。 */
export function cstDayOf(ts: number): string {
  return new Date(ts + 8 * 3600_000).toISOString().slice(0, 10);
}

function resolveDbPath(): string {
  const raw = process.env.PROFILE_DB_PATH?.trim() || DEFAULT_DB_PATH;
  return resolve(process.cwd(), raw);
}

class JobRunStore {
  private readonly db: DatabaseSync;

  constructor() {
    const dbPath = resolveDbPath();
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS job_run (
        job         TEXT    NOT NULL,
        day         TEXT    NOT NULL,
        started_at  INTEGER NOT NULL,
        finished_at INTEGER,
        pid         INTEGER,
        note        TEXT    NOT NULL DEFAULT '',
        PRIMARY KEY (job, day)
      );
    `);
  }

  get(job: string, day: string): JobRunRow | undefined {
    return this.db
      .prepare(`SELECT job, day, started_at, finished_at, pid, note FROM job_run WHERE job = ? AND day = ?`)
      .get(job, day) as JobRunRow | undefined;
  }

  list(job: string, limit = 30): JobRunRow[] {
    return this.db
      .prepare(`SELECT job, day, started_at, finished_at, pid, note FROM job_run WHERE job = ? ORDER BY day DESC LIMIT ?`)
      .all(job, limit) as unknown as JobRunRow[];
  }

  /** 干跑：此刻 claim 会得到什么结论，但不落库。 */
  peek(job: string, day: string, now = Date.now(), leaseMs = JOB_LEASE_MS): ClaimResult {
    const row = this.get(job, day);
    if (!row) return 'claimed';
    if (row.finished_at) return 'done';
    return now - row.started_at >= leaseMs ? 'reclaimed' : 'busy';
  }

  /** 原子认领当天任务。返回值语义见文件头。 */
  claim(job: string, day: string, now = Date.now(), leaseMs = JOB_LEASE_MS, note = ''): ClaimResult {
    const ins = this.db
      .prepare(`INSERT OR IGNORE INTO job_run (job, day, started_at, finished_at, pid, note) VALUES (?, ?, ?, NULL, ?, ?)`)
      .run(job, day, now, process.pid, note);
    if (Number(ins.changes) === 1) return 'claimed';
    // 租约到期的半路尸体：条件 UPDATE 只有一个进程能 changes=1
    const upd = this.db
      .prepare(`UPDATE job_run SET started_at = ?, pid = ?, note = ? WHERE job = ? AND day = ? AND finished_at IS NULL AND started_at <= ?`)
      .run(now, process.pid, note, job, day, now - leaseMs);
    if (Number(upd.changes) === 1) return 'reclaimed';
    const row = this.get(job, day);
    return row?.finished_at ? 'done' : 'busy';
  }

  finish(job: string, day: string, now = Date.now()): void {
    this.db.prepare(`UPDATE job_run SET finished_at = ? WHERE job = ? AND day = ?`).run(now, job, day);
  }

  /** 运维：把某天直接标为已完成（覆盖写）。上线当天 seed / 人工确认已跑过时用。 */
  seedDone(job: string, day: string, startedAt: number, finishedAt: number, note: string): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO job_run (job, day, started_at, finished_at, pid, note) VALUES (?, ?, ?, ?, NULL, ?)`)
      .run(job, day, startedAt, finishedAt, note);
  }

  /** 测试用：清掉某任务全部记录。 */
  clear(job: string): void {
    this.db.prepare(`DELETE FROM job_run WHERE job = ?`).run(job);
  }
}

export const jobRunStore = new JobRunStore();
