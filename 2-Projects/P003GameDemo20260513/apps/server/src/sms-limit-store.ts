import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * 短信发送流水 + 三窗限流（防刷第一道，阿里云侧同号 60s 频控只是最后兜底）。
 *
 * 独立库 sms.db（与 accounts.db / devices.db 物理隔离，同现有分库哲学）。
 * 持久化而非内存（guard.ts 风格）：短信按条计费，进程重启不能清零限额。
 * 只记「已实际调用阿里云」的发送（限流拒绝/参数错不记，不占用户额度）。
 *
 * 窗口（env 可调，0=关闭该窗）：
 *  - 同号间隔 SMS_SEND_INTERVAL_S（默认 60s）
 *  - 同号小时上限 SMS_LIMIT_PER_HOUR（默认 5）
 *  - 同号日上限 SMS_LIMIT_PER_DAY（默认 10）
 *  - 同 IP 日上限 SMS_LIMIT_IP_PER_DAY（默认 20）
 *
 * retry_after_s 为真实剩余秒数（窗口内最老一条滚出的时刻），不是窗口全长——
 * 前端拿它做倒计时，报窗口全长会把等待时间夸大近一个量级（2026-08-23 联调实撞）。
 *
 * SMS_TEST_PHONE_ALLOWLIST（逗号分隔全号，生产 .env.local 配置，不进 git）：
 * 联调测试号跳过额度窗（小时/日/IP）；60s 间隔窗保留（对齐阿里云平台同号
 * 1条/分钟 频控，本地放行也会被 biz.FREQUENCY 拒）。公网其余号防刷照旧。
 */

export type SmsLimitVerdict =
  | { ok: true }
  | { ok: false; reason: 'interval' | 'phone_hour' | 'phone_day' | 'ip_day'; retry_after_s: number };

const DEFAULT_DB_PATH = './data/sms.db';

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function resolveDbPath(): string {
  const raw = process.env.SMS_DB_PATH?.trim() || DEFAULT_DB_PATH;
  return resolve(process.cwd(), raw);
}

class SmsLimitStore {
  private readonly db: DatabaseSync;

  constructor() {
    const dbPath = resolveDbPath();
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sms_send_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone TEXT NOT NULL,
        ip TEXT NOT NULL DEFAULT '',
        biz_id TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sms_log_phone_time ON sms_send_log (phone, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sms_log_ip_time ON sms_send_log (ip, created_at DESC);
    `);
  }

  private countSince(col: 'phone' | 'ip', value: string, sinceMs: number): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM sms_send_log WHERE ${col} = ? AND created_at >= ?`)
      .get(value, sinceMs) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  private lastSentAt(phone: string): number | null {
    const row = this.db
      .prepare(`SELECT created_at FROM sms_send_log WHERE phone = ? ORDER BY created_at DESC LIMIT 1`)
      .get(phone) as { created_at: number } | undefined;
    return row?.created_at ?? null;
  }

  /** 窗口内最老一条的时间（用于算真实解锁时刻：最老一条滚出窗口即降到上限以下）。 */
  private oldestSince(col: 'phone' | 'ip', value: string, sinceMs: number): number | null {
    const row = this.db
      .prepare(`SELECT MIN(created_at) AS t FROM sms_send_log WHERE ${col} = ? AND created_at >= ?`)
      .get(value, sinceMs) as { t: number | null } | undefined;
    return row?.t ?? null;
  }

  private retryAfterS(oldestMs: number | null, windowMs: number, now: number): number {
    if (oldestMs === null) return Math.ceil(windowMs / 1000); // 理论不可达（计数≥上限必有最老条），兜底窗口全长
    return Math.max(1, Math.ceil((oldestMs + windowMs - now) / 1000));
  }

  private isAllowlisted(phone: string): boolean {
    const raw = process.env.SMS_TEST_PHONE_ALLOWLIST ?? '';
    if (!raw.trim()) return false;
    return raw.split(',').some((s) => s.trim() === phone);
  }

  /** 发送前限流裁决（不写库；通过后实际发送成功才 record）。 */
  check(phone: string, ip: string, now = Date.now()): SmsLimitVerdict {
    // 60s 间隔对所有号生效（含白名单）：对齐阿里云平台同号 1条/分钟 频控——本地不拦
    // 请求打过去也被 biz.FREQUENCY 拒（502 干等），本地 429 反而有准确倒计时（川哥 2026-08-23 拍板）
    const intervalS = envInt('SMS_SEND_INTERVAL_S', 60);
    if (intervalS > 0) {
      const last = this.lastSentAt(phone);
      if (last !== null && now - last < intervalS * 1000) {
        return { ok: false, reason: 'interval', retry_after_s: Math.ceil((intervalS * 1000 - (now - last)) / 1000) };
      }
    }
    // 联调测试号：跳过额度窗（小时/日/IP），高频测试不受限；发送仍 record 流水，审计不缺账
    if (this.isAllowlisted(phone)) return { ok: true };
    const perHour = envInt('SMS_LIMIT_PER_HOUR', 5);
    if (perHour > 0) {
      const since = now - 3600_000;
      if (this.countSince('phone', phone, since) >= perHour) {
        const retry = this.retryAfterS(this.oldestSince('phone', phone, since), 3600_000, now);
        return { ok: false, reason: 'phone_hour', retry_after_s: retry };
      }
    }
    const perDay = envInt('SMS_LIMIT_PER_DAY', 10);
    if (perDay > 0) {
      const since = now - 86400_000;
      if (this.countSince('phone', phone, since) >= perDay) {
        const retry = this.retryAfterS(this.oldestSince('phone', phone, since), 86400_000, now);
        return { ok: false, reason: 'phone_day', retry_after_s: retry };
      }
    }
    const ipPerDay = envInt('SMS_LIMIT_IP_PER_DAY', 20);
    if (ipPerDay > 0 && ip) {
      const since = now - 86400_000;
      if (this.countSince('ip', ip, since) >= ipPerDay) {
        const retry = this.retryAfterS(this.oldestSince('ip', ip, since), 86400_000, now);
        return { ok: false, reason: 'ip_day', retry_after_s: retry };
      }
    }
    return { ok: true };
  }

  /** 记一条已实发的流水（阿里云受理成功后调用）。 */
  record(phone: string, ip: string, bizId: string, now = Date.now()): void {
    this.db
      .prepare(`INSERT INTO sms_send_log (phone, ip, biz_id, created_at) VALUES (?, ?, ?, ?)`)
      .run(phone, ip, bizId, now);
  }
}

export const smsLimitStore = new SmsLimitStore();
