import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { z, type ZodError } from 'zod';
import { verifyDeviceCredential } from './device-session.js';
import { deviceRegistryStore } from '../device-registry-store.js';
import { configStore, type RuntimeFlag } from '../config-store.js';
import { getTokenUser } from './auth.js';
import { validateDeviceSn } from '../device-sn.js';
import {
  diagnosticsStore,
  DIAGLOG_RETENTION_DAYS_DEFAULT,
  type DiagBatchMeta,
  type DiagEventInput,
  type DiagLevel,
} from '../diagnostics-store.js';
import { sanitizeData, redactString, DATA_LIMITS_DEFAULT } from '../diagnostics-redact.js';

/**
 * 设备诊断日志上云（合同：Godot/Launcher codex《DIAGNOSTIC_LOG_SERVER_HANDOFF》《DIAGNOSTIC_LOG_CLOUD》
 * + `diagnostic-log-ingest.openapi.yaml`；服务端口径 = CC 复核回执 v1 §3（2026-09-18）+ §7 冻结（川哥 2026-09-19）
 * + codex §4 回复（2026-09-19：rejected 终态已实现 / client_event_id 带开机 nonce / Godot 每 15 s 最多 1 批）。
 *
 * 设备侧 POST /v1/device/diagnostics/logs:batch（路径**字面**冒号；Hono 不解码 %3A，端侧已确认字面发）：
 *   门序：验收注入(endpoint 作用域，凭据前) → 设备凭据（SN 只取 JWT sub，body 里任何 sn/serial/installation_id 一律忽略）
 *        → 设备状态 + 灰度名单（DIAGLOG_SN_ALLOWLIST：未设=全关 fail-closed / `*`=全开 / 逗号 SN 列表）
 *        → 验收注入(allowlist 作用域：只对过了凭据+名单的设备，可按 sn_suffix 点名一台；401 只能走这里且 once)
 *        → 远程开关（config 键 diagnostics.log_upload_enabled，SN 覆盖 > 全局 > 内置 true；关=503 + Retry-After 900）
 *        → 限频（30 批/分钟/SN，429 + Retry-After 60）→ 体积（64 KiB / 20 条 → 413）→ JSON/schema（400）
 *        → 逐条：schema → 事件白名单 → 二次脱敏 → 单条 8 KiB → 幂等写入（(SN, client_event_id)）→ 200 部分成功。
 *   401 **只**来自共用的 verifyDeviceCredential（回执 §1.1：端侧 401 策略可能自清凭据，本端点绝不复用 401 表达别的意思）；
 *   401 演练注入（2026-09-20）与门 1 同字节，且被三重锁（scope=allowlist + sn_suffix + once）钉死在一台灰度设备、一次命中。
 *   时钟：不按偏差拒收，只记 clock_skew_ms（回执 §1.4；生产 telemetry 实测 2913/80708 批 >1h）。
 *   响应（openapi + codex 同意新增 rejected[]）：{ok, accepted_event_ids, rejected_event_ids, rejected[{client_event_id,reason}],
 *   retry_after_ms, server_time_ms, request_id}；重复事件（同 ID 同载荷）计入 accepted。错误体：{ok:false, error_code, message?, retry_after_ms?, request_id}。
 *   日志锚：`[diaglog] batch sn=****<末4> …`（零 Bearer / 零 SN 全文）。
 *
 * admin 侧（挂 /api/admin/diagnostics，admin 专属正则已加 diagnostics）：summary / events / rejected / switch。
 */

/** §6 冻结：30 批 / 分钟 / SN。codex 回执 §4.6：Godot 每 15 s 最多 flush 一批（≈4 批/分钟），Bridge ready 时允许一次立即 flush。 */
export const DIAGLOG_BATCH_RPM_DEFAULT = 30;
export const GODOT_DECLARED_BATCHES_PER_MIN = 4;
export const MAX_EVENTS_PER_BATCH = 20;
export const MAX_BATCH_BYTES = 64 * 1024;
export const MAX_EVENT_BYTES = 8 * 1024;
export const MESSAGE_MAX_CHARS = 512;
export const SWITCH_CONFIG_KEY = 'diagnostics.log_upload_enabled';
export const DISABLED_RETRY_AFTER_SEC = 900;
export const RATE_LIMIT_RETRY_AFTER_SEC = 60;
/** HANDOFF §5 事件白名单（初版）；扩展走 DIAGLOG_EVENT_ALLOWLIST_EXTRA（逗号，restart 生效）或改这里发版。未登记 → rejected event_not_allowed（§6 冻结：拒收）。 */
export const EVENT_ALLOWLIST_BUILTIN = [
  'godot.startup',
  'bridge.ready',
  'bridge.error',
  'runtime.error',
  'g1.command_failed',
  'game.presence_state_changed',
  'voice.state_changed',
  'network.offline_state_changed',
  'ota.check_state_changed',
  'ota.update_state_changed',
  'settings.open',
  'settings.close',
  'diagnostics.log.upload_state_changed',
] as const;
export const REJECT_REASONS = ['event_not_allowed', 'invalid_event', 'event_too_large', 'event_id_payload_conflict'] as const;
const LEVELS = ['debug', 'info', 'warn', 'error', 'fatal'] as const;

// ── 验收注入热开关（2026-09-20 Launcher 联调用）：后台 runtime_flag 覆盖 > env `DIAGLOG_ACCEPTANCE_OVERRIDE`；
//    覆盖带 TTL 自动到期（默认 15 分钟、上限 60 分钟），杜绝「测完忘撤」；改后下一请求即生效，不重启、不动 env。
export const INJECT_FLAG_KEY = 'diaglog_acceptance_override';
export const INJECT_STATUSES = ['401', '403', '429', '500', '503'] as const;
export type InjectStatus = (typeof INJECT_STATUSES)[number];
export const INJECT_TTL_DEFAULT_MIN = 15;
export const INJECT_TTL_MAX_MIN = 60;
/** 注入作用域：endpoint=门 0（凭据前，端点上所有请求，含无凭据）；allowlist=门 2 之后（只对过了凭据+灰度名单的设备，可再按 SN 末位收窄）。 */
export const INJECT_SCOPES = ['endpoint', 'allowlist'] as const;
export type InjectScope = (typeof INJECT_SCOPES)[number];
export const INJECT_SN_SUFFIX_RE = /^\d{8,20}$/;
export type InjectionState = {
  status: InjectStatus | null;
  source: 'override' | 'env' | null;
  scope: InjectScope;
  sn_suffix: string | null;
  once: boolean;
  expires_at_ms: number | null;
  retry_after_sec: number | null;
  set_by: string | null;
  set_at_ms: number | null;
  note: string | null;
};
const NO_INJECTION: InjectionState = { status: null, source: null, scope: 'endpoint', sn_suffix: null, once: false, expires_at_ms: null, retry_after_sec: null, set_by: null, set_at_ms: null, note: null };
/**
 * 401 三重锁（2026-09-20 401 演练）：端侧 401 策略会清 Keystore 凭据并波及该设备全部通道，所以 401 注入只允许
 * scope=allowlist（过了凭据+名单的设备）+ sn_suffix（≥8 位，点名一台）+ once（命中一次即撤，防恢复换钥后的下一请求再被清）。
 * 在解析点强制（不只在 PUT 校验）：手工改库 / env 写 401 都到不了设备。
 */
export function inject401Locked(s: { status: string | null; scope: InjectScope; sn_suffix: string | null; once: boolean }): boolean {
  return s.status !== '401' || (s.scope === 'allowlist' && !!s.sn_suffix && s.once);
}
/** 生效注入的唯一解析点：后台覆盖（合法且未到期）> env（合法值）> 无。DB 读失败 → 按 env 走（不断上报）。 */
export function resolveInjection(now = Date.now()): InjectionState {
  let flag: RuntimeFlag | null = null;
  try {
    flag = configStore.getFlag(INJECT_FLAG_KEY);
  } catch (e) {
    console.error(`[diaglog] runtime_flag 读取失败，回落 env: ${(e as Error).message}`);
  }
  if (flag) {
    try {
      const v = JSON.parse(flag.value) as { status?: unknown; expires_at_ms?: unknown; retry_after_sec?: unknown; scope?: unknown; sn_suffix?: unknown; once?: unknown };
      const st = typeof v.status === 'string' && (INJECT_STATUSES as readonly string[]).includes(v.status) ? (v.status as InjectStatus) : null;
      const exp = typeof v.expires_at_ms === 'number' ? v.expires_at_ms : 0;
      if (st && exp > now) {
        const cand: InjectionState = {
          status: st,
          source: 'override',
          scope: v.scope === 'allowlist' ? 'allowlist' : 'endpoint',
          sn_suffix: typeof v.sn_suffix === 'string' && INJECT_SN_SUFFIX_RE.test(v.sn_suffix) ? v.sn_suffix : null,
          once: v.once === true,
          expires_at_ms: exp,
          retry_after_sec: typeof v.retry_after_sec === 'number' ? v.retry_after_sec : null,
          set_by: flag.updated_by,
          set_at_ms: flag.updated_at,
          note: flag.note || null,
        };
        if (inject401Locked(cand)) return cand;
        console.warn('[diaglog] ⚠️ 后台覆盖 401 缺三重锁（scope=allowlist+sn_suffix+once），忽略该覆盖');
      }
    } catch {
      /* 非法 JSON（只可能手工改库）：忽略覆盖 */
    }
  }
  const env = process.env.DIAGLOG_ACCEPTANCE_OVERRIDE?.trim();
  if (env === '401') {
    console.warn('[diaglog] ⚠️ env DIAGLOG_ACCEPTANCE_OVERRIDE=401 已不支持（401 只能后台三重锁注入），忽略');
    return NO_INJECTION;
  }
  if (env && (INJECT_STATUSES as readonly string[]).includes(env)) return { ...NO_INJECTION, status: env as InjectStatus, source: 'env' };
  return NO_INJECTION;
}

const cfg = () => ({
  authSecret: process.env.AUTH_JWT_SECRET || '',
  rpm: Number(process.env.DIAGLOG_BATCH_RPM || DIAGLOG_BATCH_RPM_DEFAULT),
  retentionDays: Number(process.env.DIAGLOG_RETENTION_DAYS || DIAGLOG_RETENTION_DAYS_DEFAULT),
  extraEvents: (process.env.DIAGLOG_EVENT_ALLOWLIST_EXTRA || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
});

export type AllowlistMode = 'closed' | 'open' | 'list';
export function parseAllowlist(raw: string | undefined): { mode: AllowlistMode; sns: Set<string> } {
  const v = (raw ?? '').trim();
  if (!v) return { mode: 'closed', sns: new Set() };
  if (v === '*') return { mode: 'open', sns: new Set() };
  return { mode: 'list', sns: new Set(v.split(',').map((s) => s.trim()).filter(Boolean)) };
}

/** 灰度门：DB status 非 active 恒拒；名单未设=全关（新通道 fail-closed，与 telemetry「未设=全开」故意不同，见回执/skill）。 */
export function deviceAllowed(sn: string, raw: string | undefined = process.env.DIAGLOG_SN_ALLOWLIST): boolean {
  const rec = deviceRegistryStore.get(sn);
  if (rec && rec.status !== 'active') return false;
  const a = parseAllowlist(raw);
  if (a.mode === 'closed') return false;
  if (a.mode === 'open') return true;
  return a.sns.has(sn);
}

export function eventAllowed(name: string, extra: string[] = cfg().extraEvents): boolean {
  return (EVENT_ALLOWLIST_BUILTIN as readonly string[]).includes(name) || extra.includes(name);
}

// 限频：同 SN 60s 滑窗（模式同 local-audio/device-config；重启清零可接受——防风暴非精确配额）
const hits = new Map<string, number[]>();
function rateLimited(sn: string, rpm: number, now: number): boolean {
  const arr = (hits.get(sn) ?? []).filter((t) => now - t < 60_000);
  if (arr.length >= rpm) {
    hits.set(sn, arr);
    return true;
  }
  arr.push(now);
  hits.set(sn, arr);
  return false;
}
/** 测试用：清空限频窗 */
export function resetRateLimitForTests(): void {
  hits.clear();
}

type ErrStatus = 400 | 401 | 403 | 413 | 429 | 500 | 503;
function errJson(
  c: Context,
  status: ErrStatus,
  errorCode: string,
  requestId: string,
  opts: { message?: string; retryAfterSec?: number } = {},
) {
  if (opts.retryAfterSec !== undefined) c.header('Retry-After', String(opts.retryAfterSec));
  return c.json(
    {
      ok: false as const,
      error_code: errorCode,
      ...(opts.message ? { message: opts.message.slice(0, 256) } : {}),
      ...(opts.retryAfterSec !== undefined ? { retry_after_ms: opts.retryAfterSec * 1000 } : {}),
      request_id: requestId,
    },
    status,
  );
}

/** 注入命中：once 先撤销再应答（同步 SQLite，防恢复换钥后的下一请求再命中）；401 与门 1 真实 401 同字节（端侧 401 策略可能看 error_code，演练必须走真实路径）。 */
function injectedResponse(c: Context, inj: InjectionState, requestId: string, sn: string | null) {
  const consumed = inj.once && inj.source === 'override' ? configStore.clearFlag(INJECT_FLAG_KEY) : null;
  console.log(
    `[diaglog] ⚠️ 验收注入生效 status=${inj.status} source=${inj.source} scope=${inj.scope}${sn ? ` sn=…${sn.slice(-8)}` : ''}${inj.once ? ` once=${consumed ? 'consumed' : 'not_consumed'}` : ''}${inj.expires_at_ms ? ` until=${new Date(inj.expires_at_ms).toISOString()}` : ''} rid=${requestId}`,
  );
  const st = Number(inj.status) as ErrStatus;
  if (st === 401) return errJson(c, 401, 'unauthorized', requestId, { message: 'credential_missing_or_invalid' });
  const retryAfterSec =
    st === 429
      ? (inj.retry_after_sec ?? Number(process.env.DIAGLOG_INJECT_RETRY_AFTER || RATE_LIMIT_RETRY_AFTER_SEC))
      : st === 503
        ? DISABLED_RETRY_AFTER_SEC
        : undefined;
  return errJson(c, st, 'acceptance_override', requestId, { message: `injected_${inj.status}`, retryAfterSec });
}

const ClientSchema = z.object({
  product: z.string().max(32),
  component: z.string().max(48),
  protocol_version: z.string().max(16),
  content_version: z.string().max(96).optional(),
});
// 未知顶层键忽略不拒（zod 默认 strip；向前兼容）；events 先当 unknown[] 收，逐条再校验——一条坏事件不拖整批
const BatchSchema = z.object({
  schema_version: z.literal(1),
  sent_at_ms: z.number().int().nonnegative(),
  client: ClientSchema,
  events: z.array(z.unknown()),
});
const EventSchema = z.object({
  schema_version: z.literal(1),
  client_event_id: z.string().min(1).max(128),
  occurred_at_ms: z.number().int().nonnegative(),
  level: z.enum(LEVELS),
  component: z.string().max(48),
  event: z.string().min(1).max(96),
  message: z.string().max(4096), // 合同 512：超出裁到 512 计 truncated（不拒——裁掉尾巴比丢整条便宜）
  trace_id: z.string().max(96).optional(),
  data: z.record(z.unknown()).optional(),
});

function firstIssue(err: ZodError): string {
  const i = err.issues[0];
  return i ? `${i.path.join('.') || '$'}:${i.code}` : 'unknown';
}
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
/** 拒绝留档摘录：整条事件先过同一套脱敏再序列化（原文可能就是被拒的原因），≤900 字符 */
function excerptOf(raw: unknown, prefix: string): string {
  const body = isObj(raw) ? JSON.stringify(sanitizeData(raw).data) : redactString(String(raw)).value;
  return `${prefix} ${body}`.slice(0, 900);
}

type Prepared =
  | { kind: 'ok'; ev: DiagEventInput; truncated: number }
  | { kind: 'reject'; id: string; reason: (typeof REJECT_REASONS)[number]; event: string; level: string; excerpt: string };

export function prepareEvent(raw: unknown, extraEvents: string[]): Prepared {
  const idGuess = isObj(raw) && typeof raw.client_event_id === 'string' ? raw.client_event_id.slice(0, 128) : '';
  const evGuess = isObj(raw) && typeof raw.event === 'string' ? raw.event.slice(0, 96) : '';
  const lvGuess = isObj(raw) && typeof raw.level === 'string' ? raw.level.slice(0, 16) : '';
  const p = EventSchema.safeParse(raw);
  if (!p.success) {
    return { kind: 'reject', id: idGuess, reason: 'invalid_event', event: evGuess, level: lvGuess, excerpt: excerptOf(raw, `invalid_event:${firstIssue(p.error)}`) };
  }
  const e = p.data;
  if (!eventAllowed(e.event, extraEvents)) {
    return { kind: 'reject', id: e.client_event_id, reason: 'event_not_allowed', event: e.event, level: e.level, excerpt: excerptOf(raw, 'event_not_allowed') };
  }
  const san = sanitizeData(e.data ?? {}, DATA_LIMITS_DEFAULT);
  const msg = redactString(e.message);
  const comp = redactString(e.component);
  const tr = redactString(e.trace_id ?? '');
  let truncated = san.truncated;
  let message = msg.value;
  if (message.length > MESSAGE_MAX_CHARS) {
    message = `${message.slice(0, MESSAGE_MAX_CHARS)}…`;
    truncated += 1;
  }
  const ev: DiagEventInput = {
    client_event_id: e.client_event_id,
    occurred_at_ms: e.occurred_at_ms,
    level: e.level as DiagLevel,
    component: comp.value,
    event: e.event,
    message,
    trace_id: tr.value,
    data: san.data,
    redacted_count: san.redacted + msg.hits + comp.hits + tr.hits,
  };
  const bytes = Buffer.byteLength(JSON.stringify(ev), 'utf8');
  if (bytes > MAX_EVENT_BYTES) {
    return { kind: 'reject', id: e.client_event_id, reason: 'event_too_large', event: e.event, level: e.level, excerpt: `event_too_large:${bytes}B > ${MAX_EVENT_BYTES}B` };
  }
  return { kind: 'ok', ev, truncated };
}

export const diagnosticsDeviceRoute = new Hono();

diagnosticsDeviceRoute.post('/logs:batch', async (c) => {
  const conf = cfg();
  const requestId = (c.req.header('x-request-id') || '').trim().slice(0, 96) || randomUUID();
  const now = Date.now();

  // 0. 验收注入 · endpoint 作用域（后台热开关 runtime_flag > env；凭据前，端点上所有请求；429/503 带 Retry-After；覆盖到期自动失效）
  const inj = resolveInjection();
  if (inj.status && inj.scope === 'endpoint') return injectedResponse(c, inj, requestId, null);

  // 1. 凭据（与其他七条设备通道同一函数；401 只有这一处）
  const cred = await verifyDeviceCredential(c.req.header('authorization'), conf.authSecret);
  if (!cred) return errJson(c, 401, 'unauthorized', requestId, { message: 'credential_missing_or_invalid' });
  const sn = cred.sn;

  // 2. 设备状态 + 灰度名单
  if (!deviceAllowed(sn)) return errJson(c, 403, 'device_not_allowed', requestId);

  // 2.5 验收注入 · allowlist 作用域（只对过了凭据+名单的设备；sn_suffix 再点名一台；401 只能走这里且 once）
  if (inj.status && inj.scope === 'allowlist' && (!inj.sn_suffix || sn.endsWith(inj.sn_suffix))) return injectedResponse(c, inj, requestId, sn);

  // 3. 远程开关（SN 覆盖 > 全局 > 内置 true）
  if (!configStore.getEffectiveBool(sn, SWITCH_CONFIG_KEY)) {
    return errJson(c, 503, 'LOG_UPLOAD_DISABLED', requestId, { retryAfterSec: DISABLED_RETRY_AFTER_SEC });
  }

  // 4. 限频
  if (rateLimited(sn, conf.rpm, now)) {
    return errJson(c, 429, 'rate_limited', requestId, { retryAfterSec: RATE_LIMIT_RETRY_AFTER_SEC });
  }

  // 5. 体积：先看 Content-Length，再量实际字节（chunked 无长度头时只能量实际）
  const declared = Number(c.req.header('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BATCH_BYTES) {
    return errJson(c, 413, 'batch_too_large', requestId, { message: `content-length ${declared} > ${MAX_BATCH_BYTES}` });
  }
  let text: string;
  try {
    text = await c.req.text();
  } catch {
    return errJson(c, 400, 'bad_request', requestId, { message: 'unreadable_body' });
  }
  const bodyBytes = Buffer.byteLength(text, 'utf8');
  if (bodyBytes > MAX_BATCH_BYTES) {
    return errJson(c, 413, 'batch_too_large', requestId, { message: `body ${bodyBytes} > ${MAX_BATCH_BYTES}` });
  }

  // 6. JSON / 批级 schema
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return errJson(c, 400, 'bad_request', requestId, { message: 'invalid_json' });
  }
  const parsed = BatchSchema.safeParse(body);
  if (!parsed.success) {
    return errJson(c, 400, 'bad_request', requestId, { message: `invalid_schema:${firstIssue(parsed.error)}` });
  }
  const batch = parsed.data;
  if (batch.events.length === 0) return errJson(c, 400, 'bad_request', requestId, { message: 'empty_batch' });
  if (batch.events.length > MAX_EVENTS_PER_BATCH) {
    return errJson(c, 413, 'batch_too_large', requestId, { message: `events ${batch.events.length} > ${MAX_EVENTS_PER_BATCH}` });
  }

  const meta: DiagBatchMeta = {
    schemaVersion: batch.schema_version,
    sentAtMs: batch.sent_at_ms,
    serverReceivedMs: now,
    requestId,
    client: {
      product: batch.client.product,
      component: batch.client.component,
      protocol_version: batch.client.protocol_version,
      content_version: batch.client.content_version ?? '',
    },
  };

  // 7. 逐条：先纯函数整形（不碰库），再一个事务写入
  const prepared = batch.events.map((raw) => prepareEvent(raw, conf.extraEvents));
  const accepted: string[] = [];
  const rejected: Array<{ client_event_id: string; reason: string }> = [];
  let dup = 0;
  let redactedTotal = 0;
  let truncatedTotal = 0;
  let unidentified = 0;
  try {
    diagnosticsStore.transaction(() => {
      for (const p of prepared) {
        if (p.kind === 'reject') {
          diagnosticsStore.recordRejected(sn, { client_event_id: p.id, reason: p.reason, event: p.event, level: p.level, excerpt: p.excerpt }, meta);
          if (!p.id) {
            unidentified += 1; // 连 ID 都没有：端侧无从对账，只留档不进响应
            continue;
          }
          rejected.push({ client_event_id: p.id, reason: p.reason });
          continue;
        }
        redactedTotal += p.ev.redacted_count;
        truncatedTotal += p.truncated;
        const outcome = diagnosticsStore.ingestEvent(sn, p.ev, meta);
        if (outcome === 'accepted') accepted.push(p.ev.client_event_id);
        else if (outcome === 'duplicated') {
          dup += 1;
          if (!accepted.includes(p.ev.client_event_id)) accepted.push(p.ev.client_event_id); // 同批内重复 ID 只回一次
        } else {
          rejected.push({ client_event_id: p.ev.client_event_id, reason: 'event_id_payload_conflict' });
          diagnosticsStore.recordRejected(
            sn,
            { client_event_id: p.ev.client_event_id, reason: 'event_id_payload_conflict', event: p.ev.event, level: p.ev.level, excerpt: 'event_id_payload_conflict' },
            meta,
          );
        }
      }
      diagnosticsStore.recordBatch(
        sn,
        { events_total: batch.events.length, accepted: accepted.length - dup, duplicated: dup, rejected: rejected.length + unidentified, redacted: redactedTotal },
        meta,
      );
    });
  } catch (e) {
    // 500 不确认任何 ID（合同）；事务已回滚
    console.error(`[diaglog] batch write failed sn=****${sn.slice(-4)} rid=${requestId}: ${(e as Error).message}`);
    return errJson(c, 500, 'internal', requestId, { message: 'write_failed' });
  }

  const purged = diagnosticsStore.maybePurge(conf.retentionDays, now);
  if (purged && (purged.events || purged.rejected || purged.batches)) {
    console.log(`[diaglog] purge retention=${conf.retentionDays}d events=${purged.events} rejected=${purged.rejected} batches=${purged.batches}`);
  }
  console.log(
    `[diaglog] batch sn=****${sn.slice(-4)} n=${batch.events.length} acked=${accepted.length} dup=${dup} rejected=${rejected.length} unidentified=${unidentified} redacted=${redactedTotal} truncated=${truncatedTotal} skew=${now - batch.sent_at_ms}ms rid=${requestId}`,
  );
  return c.json({
    ok: true as const,
    accepted_event_ids: accepted,
    rejected_event_ids: rejected.map((r) => r.client_event_id),
    rejected,
    retry_after_ms: 0,
    server_time_ms: now,
    request_id: requestId,
  });
});

// 进程启动时清一次（之后靠摄入路径每小时节流）；失败只留痕不阻塞启动
try {
  const p = diagnosticsStore.purge(cfg().retentionDays);
  if (p.events || p.rejected || p.batches) console.log(`[diaglog] startup purge events=${p.events} rejected=${p.rejected} batches=${p.batches}`);
} catch (e) {
  console.error(`[diaglog] startup purge failed: ${(e as Error).message}`);
}

// ─────────────────────────── admin（挂 /api/admin/diagnostics；鉴权在 adminDataRoute use('*')）───────────────────────────

export const diagnosticsAdminRoute = new Hono();

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

function switchState() {
  const ov = configStore.adminOverview();
  const k = ov.keys.find((x) => x.key === SWITCH_CONFIG_KEY);
  return {
    key: SWITCH_CONFIG_KEY,
    global: k ? (k.global === null ? k.builtin_default : k.global) : true,
    global_is_builtin: !k || k.global === null,
    global_updated_at: k?.global_updated_at ?? null,
    overrides: ov.overrides.filter((o) => o.key === SWITCH_CONFIG_KEY),
    device_visible: k ? !k.server_only : false, // 端侧确认能消费该键后翻 serverOnly（回执 §2 第 4 条两层开关的设备层）
  };
}

diagnosticsAdminRoute.get('/summary', (c) => {
  const hours = clampInt(c.req.query('hours'), 24, 1, 24 * 14);
  const conf = cfg();
  const al = parseAllowlist(process.env.DIAGLOG_SN_ALLOWLIST);
  const inj = resolveInjection();
  return c.json({
    ok: true,
    hours,
    summary: diagnosticsStore.summary(Date.now() - hours * 3600_000),
    switch: switchState(),
    config: {
      retention_days: conf.retentionDays,
      batch_rpm: conf.rpm,
      allowlist_mode: al.mode,
      allowlist: [...al.sns],
      event_allowlist: [...EVENT_ALLOWLIST_BUILTIN, ...conf.extraEvents],
      limits: { max_events_per_batch: MAX_EVENTS_PER_BATCH, max_batch_bytes: MAX_BATCH_BYTES, max_event_bytes: MAX_EVENT_BYTES, data: DATA_LIMITS_DEFAULT },
      injection_active: inj.status,
      injection: inj,
    },
  });
});

// ── 注入热开关 + 批次对账（2026-09-20 联调用；admin 专属）──
function operatorOf(c: Context): string {
  const header = c.req.header('authorization');
  const tok = header ? /^Bearer\s+(.+)$/i.exec(header.trim())?.[1] : undefined;
  return (tok ? getTokenUser(tok) : undefined) ?? 'admin';
}

diagnosticsAdminRoute.get('/inject', (c) => c.json({ ok: true, injection: resolveInjection(), server_time_ms: Date.now() }));

/**
 * {status:'401'|'403'|'429'|'500'|'503'|null, ttl_min?:1..60(默认 15), retry_after_sec?:1..3600(仅 429),
 *  scope?:'endpoint'|'allowlist'(默认 endpoint), sn_suffix?:8..20 位数字(仅 allowlist), once?:bool(401 强制 true), note?}。
 * null = 撤销。401 必须 scope=allowlist + sn_suffix + once（三重锁，见 inject401Locked）。
 */
diagnosticsAdminRoute.put('/inject', async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { status?: unknown; ttl_min?: unknown; retry_after_sec?: unknown; scope?: unknown; sn_suffix?: unknown; once?: unknown; note?: unknown }
    | null;
  if (!body || !('status' in body)) return c.json({ ok: false, error: 'bad_request', message: 'status 必填（401|403|429|500|503|null）' }, 400);
  const by = operatorOf(c);
  const before = resolveInjection();
  if (body.status === null) {
    const removed = configStore.clearFlag(INJECT_FLAG_KEY);
    const after = resolveInjection();
    console.log(`[diaglog] inject cleared removed=${removed} before=${before.status ?? 'none'}(${before.source ?? '-'}) after=${after.status ?? 'none'}(${after.source ?? '-'}) by=${by}`);
    return c.json({ ok: true, removed, injection: after, before, server_time_ms: Date.now() });
  }
  const st = typeof body.status === 'string' ? body.status.trim() : String(body.status ?? '');
  if (!(INJECT_STATUSES as readonly string[]).includes(st)) return c.json({ ok: false, error: 'bad_status', message: `status 须为 ${INJECT_STATUSES.join('|')} 或 null` }, 400);
  const scope: InjectScope | null =
    body.scope === undefined ? 'endpoint' : (INJECT_SCOPES as readonly string[]).includes(body.scope as string) ? (body.scope as InjectScope) : null;
  if (!scope) return c.json({ ok: false, error: 'bad_scope', message: `scope 须为 ${INJECT_SCOPES.join('|')}` }, 400);
  const snSuffix: string | null | undefined =
    body.sn_suffix === undefined || body.sn_suffix === null
      ? null
      : typeof body.sn_suffix === 'string' && INJECT_SN_SUFFIX_RE.test(body.sn_suffix.trim())
        ? body.sn_suffix.trim()
        : undefined;
  if (snSuffix === undefined) return c.json({ ok: false, error: 'bad_sn_suffix', message: 'sn_suffix 须为 8..20 位数字（SN 末位）' }, 400);
  if (snSuffix && scope !== 'allowlist') return c.json({ ok: false, error: 'sn_suffix_requires_allowlist_scope', message: 'sn_suffix 只在 scope=allowlist 下有意义' }, 400);
  const once: boolean | undefined = body.once === undefined ? st === '401' : body.once === true ? true : body.once === false ? false : undefined;
  if (once === undefined) return c.json({ ok: false, error: 'bad_once', message: 'once 须为布尔' }, 400);
  if (!inject401Locked({ status: st, scope, sn_suffix: snSuffix, once })) {
    return c.json(
      { ok: false, error: 'unsafe_401', message: '401 注入必须 scope=allowlist + sn_suffix（≥8 位，点名一台）+ once=true：端侧 401 策略会清设备凭据并波及该设备全部通道，禁止端点级 / 可重复命中' },
      400,
    );
  }
  const ttl = clampInt(body.ttl_min, INJECT_TTL_DEFAULT_MIN, 1, INJECT_TTL_MAX_MIN);
  const ra = body.retry_after_sec === undefined ? undefined : clampInt(body.retry_after_sec, RATE_LIMIT_RETRY_AFTER_SEC, 1, 3600);
  const note = typeof body.note === 'string' ? body.note.slice(0, 200) : '';
  const expiresAt = Date.now() + ttl * 60_000;
  configStore.setFlag(
    INJECT_FLAG_KEY,
    JSON.stringify({ status: st, expires_at_ms: expiresAt, scope, ...(snSuffix ? { sn_suffix: snSuffix } : {}), once, ...(ra !== undefined ? { retry_after_sec: ra } : {}) }),
    by,
    note,
  );
  const after = resolveInjection();
  console.log(
    `[diaglog] inject set status=${st} scope=${scope}${snSuffix ? ` sn_suffix=…${snSuffix.slice(-8)}` : ''} once=${once} ttl_min=${ttl} until=${new Date(expiresAt).toISOString()}${ra !== undefined ? ` retry_after_sec=${ra}` : ''} by=${by} note=${JSON.stringify(note)}`,
  );
  return c.json({ ok: true, injection: after, before, server_time_ms: Date.now() });
});

/** 批次对账：按 SN / 时间窗 / X-Request-Id 列出每批 accepted / duplicated / rejected / redacted / client_content_version。 */
diagnosticsAdminRoute.get('/batches', (c) => {
  const sn = c.req.query('sn')?.trim() || '';
  if (sn && !validateDeviceSn(sn).ok) return c.json({ ok: false, error: 'bad_sn' }, 400);
  const hours = clampInt(c.req.query('hours'), 24, 1, 24 * 14);
  const limit = clampInt(c.req.query('limit'), 100, 1, 500);
  const requestId = (c.req.query('request_id')?.trim() || '').slice(0, 96);
  const rows = diagnosticsStore.listBatches({ sn: sn || undefined, sinceMs: Date.now() - hours * 3600_000, limit, requestId: requestId || undefined });
  return c.json({ ok: true, rows, limit, hours });
});

diagnosticsAdminRoute.get('/events', (c) => {
  const sn = c.req.query('sn')?.trim() || '';
  if (sn && !validateDeviceSn(sn).ok) return c.json({ ok: false, error: 'bad_sn' }, 400);
  const level = c.req.query('level')?.trim() || '';
  if (level && !(LEVELS as readonly string[]).includes(level)) return c.json({ ok: false, error: 'bad_level' }, 400);
  const event = (c.req.query('event')?.trim() || '').slice(0, 96);
  const hours = clampInt(c.req.query('hours'), 24, 1, 24 * 14);
  const limit = clampInt(c.req.query('limit'), 50, 1, 200);
  const untilMs = c.req.query('until_ms') ? clampInt(c.req.query('until_ms'), 0, 0, Number.MAX_SAFE_INTEGER) : undefined;
  const rows = diagnosticsStore
    .listEvents({ sn: sn || undefined, level: level || undefined, event: event || undefined, sinceMs: Date.now() - hours * 3600_000, untilMs: untilMs || undefined, limit })
    .map((r) => {
      let data: unknown = null;
      try {
        data = JSON.parse(r.data_json);
      } catch {
        data = { _unparsable: true };
      }
      const { data_json: _omit, payload_hash: _omit2, ...rest } = r;
      return { ...rest, data };
    });
  return c.json({ ok: true, rows, limit, hours });
});

diagnosticsAdminRoute.get('/rejected', (c) => {
  const sn = c.req.query('sn')?.trim() || '';
  if (sn && !validateDeviceSn(sn).ok) return c.json({ ok: false, error: 'bad_sn' }, 400);
  const hours = clampInt(c.req.query('hours'), 24, 1, 24 * 14);
  const limit = clampInt(c.req.query('limit'), 50, 1, 200);
  return c.json({ ok: true, rows: diagnosticsStore.listRejected({ sn: sn || undefined, sinceMs: Date.now() - hours * 3600_000, limit }), limit, hours });
});

/** 一键开关：{enabled:boolean, sn?:string}。无 sn = 全局；有 sn = 该设备覆盖。底层就是 device-config 的同一把键（同一 revision 序列）。 */
diagnosticsAdminRoute.put('/switch', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { enabled?: unknown; sn?: unknown } | null;
  if (!body || typeof body.enabled !== 'boolean') return c.json({ ok: false, error: 'bad_request', message: 'enabled 须为 boolean' }, 400);
  const sn = typeof body.sn === 'string' ? body.sn.trim() : '';
  if (sn && !validateDeviceSn(sn).ok) return c.json({ ok: false, error: 'bad_sn' }, 400);
  const rev = sn ? configStore.setValue(sn, SWITCH_CONFIG_KEY, body.enabled) : configStore.setGlobal(SWITCH_CONFIG_KEY, body.enabled);
  if (rev === null) return c.json({ ok: false, error: 'invalid_value' }, 400);
  console.log(`[diaglog] switch ${sn ? `sn=****${sn.slice(-4)}` : 'global'} enabled=${body.enabled} rev=${rev}`);
  return c.json({ ok: true, rev, switch: switchState() });
});

diagnosticsAdminRoute.delete('/switch/:sn', (c) => {
  const sn = c.req.param('sn');
  if (!validateDeviceSn(sn).ok) return c.json({ ok: false, error: 'bad_sn' }, 400);
  const rev = configStore.clearForSn(sn, SWITCH_CONFIG_KEY);
  if (rev === null) return c.json({ ok: false, error: 'unknown_key' }, 400);
  console.log(`[diaglog] switch clear sn=****${sn.slice(-4)} rev=${rev}`);
  return c.json({ ok: true, rev, switch: switchState() });
});
