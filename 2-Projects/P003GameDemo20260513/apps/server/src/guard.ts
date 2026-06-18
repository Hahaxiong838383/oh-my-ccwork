// 内存级 per-IP 日限额兜底（UTC+8 自然日重置）
// 无外部依赖，公网无密码部署的最低防护
// 限额仅在内存，进程重启即清；适合 demo / 个人站兜底

export type QuotaKind = 'ws_session' | 'chat_round' | 'vision';

export interface CheckResult {
  ok: boolean;
  remaining: number;
}

interface IpQuota {
  day: string;
  counts: Partial<Record<QuotaKind, number>>;
}

// 存储：key=ip , value=当日计数
const ipQuotas = new Map<string, IpQuota>();

// 从 env 读取限额（0 表示该项不限额）
function getLimit(kind: QuotaKind): number {
  if (kind === 'ws_session') return Number(process.env.GUARD_WS_SESSIONS_PER_DAY ?? 60);
  if (kind === 'chat_round') return Number(process.env.GUARD_CHAT_ROUNDS_PER_DAY ?? 120);
  if (kind === 'vision') return Number(process.env.GUARD_VISION_PER_DAY ?? 200);
  return 0;
}

// 计算 UTC+8 当日 key（YYYY-MM-DD），自然日重置
// 支持测试脚本通过全局覆盖强制不同日期
function getCurrentDay(): string {
  const override = (globalThis as any).__guard_test_day_override;
  if (typeof override === 'string' && override) {
    return override;
  }
  const now = new Date();
  // UTC+8 偏移（不依赖时区库，生产环境通常为 Asia/Shanghai）
  const offsetMs = 8 * 60 * 60 * 1000;
  const utc8 = new Date(now.getTime() + offsetMs);
  const y = utc8.getUTCFullYear();
  const m = String(utc8.getUTCMonth() + 1).padStart(2, '0');
  const d = String(utc8.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// 提取客户端 IP（支持 ws 的 raw req 和 Hono 的 Context）
// 优先级：x-real-ip > x-forwarded-for[0] > ws 场景 remoteAddress > '?'
export function getClientIp(source: any): string {
  if (!source) return '?';

  // Hono Context：有 c.req.header 方法
  if (source && typeof source.req?.header === 'function') {
    const xri = source.req.header('x-real-ip');
    if (typeof xri === 'string' && xri.trim()) return xri.trim();
    const xff = source.req.header('x-forwarded-for');
    if (typeof xff === 'string' && xff.trim()) {
      return xff.split(',')[0].trim();
    }
    return '?';
  }

  // raw http.IncomingMessage（ws upgrade req）
  const headers = source.headers || source.req?.headers || {};
  const xri = headers['x-real-ip'] || headers['X-Real-IP'];
  if (typeof xri === 'string' && xri.trim()) return xri.trim();
  let xff = headers['x-forwarded-for'] || headers['X-Forwarded-For'];
  if (typeof xff === 'string' && xff.trim()) {
    return xff.split(',')[0].trim();
  }
  if (Array.isArray(xff) && xff.length > 0) {
    const first = String(xff[0] || '').trim();
    if (first) return first;
  }

  const remote =
    source.socket?.remoteAddress ||
    source.req?.socket?.remoteAddress ||
    source.connection?.remoteAddress;
  return remote || '?';
}

// 检查并自增计数（惰性跨天重置）
// 返回 ok + 剩余可用次数（未命中限额时）；限额为0时直接 ok 且 remaining 很大
export function checkAndCount(kind: QuotaKind, ip: string): CheckResult {
  const limit = getLimit(kind);
  if (limit === 0) {
    // env 显式设 0 = 该项不限
    return { ok: true, remaining: 999999 };
  }

  const day = getCurrentDay();
  let quota = ipQuotas.get(ip);

  if (!quota || quota.day !== day) {
    // 跨天或首次：重置该 IP 当日计数
    quota = { day, counts: {} };
    ipQuotas.set(ip, quota);
  }

  const current = quota.counts[kind] ?? 0;
  if (current >= limit) {
    return { ok: false, remaining: 0 };
  }

  // 自增
  const next = current + 1;
  quota.counts[kind] = next;

  const remaining = Math.max(0, limit - next);

  // 内存防护：超过 5000 个 IP 时清理最旧条目（Map 按插入序）
  if (ipQuotas.size > 5000) {
    const oldestKey = ipQuotas.keys().next().value;
    if (oldestKey !== undefined) {
      ipQuotas.delete(oldestKey);
    }
  }

  return { ok: true, remaining };
}

// admin 手动重置今日限额（内测自助：清空所有 IP 当日计数，等价 pm2 restart 的清限额效果但不重启服务/不断开连接）。
export function resetAllQuotas(): number {
  const n = ipQuotas.size;
  ipQuotas.clear();
  return n;
}

// 仅用于临时测试脚本的辅助（生产代码绝不调用）
// 允许强制跨天重置验证 + 清理状态
export function __resetForTest(): void {
  ipQuotas.clear();
}

export function __setTestDay(day: string): void {
  (globalThis as any).__guard_test_day_override = day;
}
