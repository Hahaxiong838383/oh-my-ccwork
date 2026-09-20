/**
 * 诊断日志服务端二次脱敏（合同：CC 诊断日志上云服务端合同复核回执 v1 §3.7，2026-09-18）。
 * 端侧 Godot 已做第一遍（key 黑名单 + 长度限制），这里是第二道门，纯函数、无 IO：
 *  - key 命中黑名单 → 整值替换 `[redacted]`（不拒整条：拒掉就丢了诊断价值），计入 redacted；
 *  - 所有字符串（含 key）扫 SN 全文（BJP003+14 位数字）/ JWT 三段 / 11 位手机号 → 掩码，计入 redacted；
 *  - 结构上限（深度 / 串长 / 数组长 / 每层键数）超出即裁剪并计入 truncated，同样不拒。
 * 拒收只留给硬性违规（schema / 事件白名单 / 单条 8 KiB / 同 ID 异载荷），见 routes/diagnostics.ts。
 */

export const SENSITIVE_KEY_RE = /token|secret|password|credential|cookie|ssid|wifi|keystore|signing|private_key/i;
const SN_RE = /BJP003\d{14}/g;
const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const CN_PHONE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;

export type DataLimits = { depth: number; string: number; array: number; keys: number };
/** 回执 §3.5 拟定并随 §6 一并冻结：data 深度 ≤4（含根）、字符串 ≤512、数组 ≤32、每层键 ≤32 */
export const DATA_LIMITS_DEFAULT: DataLimits = { depth: 4, string: 512, array: 32, keys: 32 };

export function redactString(s: string): { value: string; hits: number } {
  let hits = 0;
  let v = s.replace(SN_RE, (m) => {
    hits += 1;
    return `****${m.slice(-4)}`;
  });
  v = v.replace(JWT_RE, () => {
    hits += 1;
    return '[redacted-jwt]';
  });
  v = v.replace(CN_PHONE_RE, (m) => {
    hits += 1;
    return `${m.slice(0, 3)}****${m.slice(-4)}`;
  });
  return { value: v, hits };
}

export type SanitizeResult = { data: Record<string, unknown>; redacted: number; truncated: number };
type Stats = { redacted: number; truncated: number };

export function sanitizeData(input: unknown, limits: DataLimits = DATA_LIMITS_DEFAULT): SanitizeResult {
  const stats: Stats = { redacted: 0, truncated: 0 };
  const data = isPlainObject(input) ? walkObject(input, 1, limits, stats) : {};
  return { data, redacted: stats.redacted, truncated: stats.truncated };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function clampString(s: string, limits: DataLimits, stats: Stats): string {
  const r = redactString(s);
  stats.redacted += r.hits;
  if (r.value.length > limits.string) {
    stats.truncated += 1;
    return `${r.value.slice(0, limits.string)}…`;
  }
  return r.value;
}

function walkValue(v: unknown, depth: number, limits: DataLimits, stats: Stats): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return clampString(v, limits, stats);
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v;
  if (Array.isArray(v)) {
    if (depth > limits.depth) {
      stats.truncated += 1;
      return '[depth-truncated]';
    }
    let arr: unknown[] = v;
    if (arr.length > limits.array) {
      stats.truncated += 1;
      arr = arr.slice(0, limits.array);
    }
    return arr.map((x) => walkValue(x, depth + 1, limits, stats));
  }
  if (isPlainObject(v)) {
    if (depth > limits.depth) {
      stats.truncated += 1;
      return '[depth-truncated]';
    }
    return walkObject(v, depth, limits, stats);
  }
  return null; // bigint/symbol/function 不可能来自 JSON，兜底置 null
}

function walkObject(obj: Record<string, unknown>, depth: number, limits: DataLimits, stats: Stats): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [rawKey, val] of Object.entries(obj)) {
    if (n >= limits.keys) {
      stats.truncated += 1;
      break;
    }
    n += 1;
    const kr = redactString(rawKey.slice(0, 64));
    stats.redacted += kr.hits;
    if (SENSITIVE_KEY_RE.test(rawKey)) {
      stats.redacted += 1;
      out[kr.value] = '[redacted]';
      continue;
    }
    out[kr.value] = walkValue(val, depth + 1, limits, stats);
  }
  return out;
}
