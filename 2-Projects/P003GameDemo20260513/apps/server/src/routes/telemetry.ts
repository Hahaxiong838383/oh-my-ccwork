import { Hono } from 'hono';
import { z } from 'zod';
import { telemetryStore, dayOf } from '../telemetry-store.js';
import { deviceRegistryStore } from '../device-registry-store.js';
import { verifyDeviceCredential } from './device-session.js';
import { verifyAuthToken } from '../auth-jwt.js';

/**
 * 设备遥测上报 + 家长聚合查询（合同 CODEX_P003_DEVICE_TELEMETRY_REPLY_20260824 + CC 实施计划）。
 *
 * 设备侧 POST /v1/device/telemetry：
 *   Bearer 设备凭据（与 /v1/device/config 同源），SN 只取 JWT sub，body 零 SN；
 *   门序：注入开关 → 凭据 → DB status/allowlist → 限频 → schema → 三层幂等写入 → 部分成功响应。
 *   实现裁决（回执 codex 标注）：event_id 同 ID 异 payload 不整批 409，进 rejected
 *   （reason=event_id_payload_conflict，HTTP 200 部分成功）——客户端动作与 409 一致（dead-letter），
 *   批内其他事件正常 ack。
 *
 * 家长侧 GET /v1/parent/devices/:publicId/{dashboard,weekly-report}：
 *   家长 JWT；public_id 反查（路由/日志零 SN）；非本家长绑定的设备一律 404（不泄露存在性）。
 *
 * 日志红线：零 Bearer / 零 SN 全文（只打尾 4 位）/ 零家长手机号。
 */

const EVENT_TYPES = new Set([
  'focus_session_started',
  'focus_session_ended',
  'focus_segment',
  'posture_round',
  'posture_reminder',
  'presence_transition',
  // 2026-09-05 语音设备控制合同 v3.1 §4（codex 阶段 B GO §4）：一次逻辑请求一条终态事件，data 严格白名单见下
  'device_command',
]);

/**
 * `device_command` 事件 data 白名单（合同 v3.1 §4 终值）：只含下列字段，多余键拒（strict）；
 * 不含任何原话/文本/SN 全文/token。lane/trace_id 可空（离线芯片=L0、UI 为空）；reason 自由串 ≤64；
 * status 只收终态（accepted 不是执行事件）。校验失败 → 逐条 rejected `invalid_event_data`，不影响同批其他事件。
 */
const DeviceCommandDataSchema = z
  .object({
    source: z.enum(['vad_chip', 'worker_l1', 'worker_l2', 'fallback', 'ui']),
    label: z.number().int().min(0).max(1000),
    action: z.string().min(1).max(64),
    lane: z.enum(['L0', 'L1', 'L2']).nullish(),
    status: z.enum(['succeeded', 'already_applied', 'rejected', 'failed', 'timeout']),
    reason: z.string().max(64),
    execution_ms: z.number().int().min(0).max(600_000),
    mcu_tx_count: z.number().int().min(0).max(100),
    steps_done: z.number().int().min(0).max(3),
    boundary_basis: z.string().max(32),
    spoken_locally: z.boolean(),
    candidate_seq: z.number().int().min(0).nullish(),
    trace_id: z.string().max(80).nullish(),
  })
  .strict();
const MAX_EVENTS_PER_BATCH = 50;
const RATE_PER_HOUR = 240; // 2026-08-25 提额:设备默认 30s 上传=120次/h,原 60 不到节奏一半(恢复后30分钟打满全 429);240=2倍余量,防风暴语义仍在
const ONLINE_WINDOW_MS = 10 * 60_000; // 心跳 5min 的两倍

const SnapshotSchema = z.object({
  snapshot_id: z.string().min(1).max(80),
  captured_at_ms: z.number().int().positive(),
  lid_open: z.boolean().nullish(),
  present: z.boolean().nullish(),
  presence_state: z.string().max(40).nullish(),
  presence_source: z.string().max(40).nullish(),
  led_enabled: z.boolean().nullish(),
  brightness_level: z.number().int().nullish(),
  color_mode: z.string().max(40).nullish(),
  image_distance_m: z.number().nullish(),
  image_distance_state: z.string().max(40).nullish(),
  volume_percent: z.number().int().nullish(),
  signal_strength: z.number().int().nullish(),
  focus_active: z.boolean().nullish(),
  focus_id: z.string().max(120).nullish(),
});

const EventSchema = z.object({
  event_id: z.string().min(1).max(80),
  type: z.string().min(1).max(60),
  occurred_at_ms: z.number().int().positive(),
  data: z.record(z.unknown()),
});

const BatchSchema = z.object({
  schema_version: z.literal(1),
  batch_id: z.string().min(1).max(120),
  device_ts_ms: z.number().int().positive(),
  snapshot: SnapshotSchema.optional(),
  events: z.array(EventSchema).max(MAX_EVENTS_PER_BATCH).optional(),
});

// 限频：内存滑动窗（重启清零可接受——防风暴非精确配额）
const rateHits = new Map<string, number[]>();
function rateLimited(sn: string, now = Date.now()): boolean {
  const arr = (rateHits.get(sn) ?? []).filter((t) => now - t < 3600_000);
  if (arr.length >= RATE_PER_HOUR) {
    rateHits.set(sn, arr);
    return true;
  }
  arr.push(now);
  rateHits.set(sn, arr);
  return false;
}

/** 灰度门：env 未设/空=放开；有值=SN 白名单（Canary 期 0010 先行）。DB disabled 恒拒。 */
function telemetryAllowed(sn: string): boolean {
  const rec = deviceRegistryStore.get(sn);
  if (rec && rec.status !== 'active') return false;
  const raw = process.env.TELEMETRY_SN_ALLOWLIST?.trim();
  if (!raw) return true;
  return raw.split(',').some((s) => s.trim() === sn);
}

export const deviceTelemetryRoute = new Hono();

deviceTelemetryRoute.post('/', async (c) => {
  // 验收错误注入（T2/T4/限频负测用；测完删键+restart）
  const override = process.env.TELEMETRY_ACCEPTANCE_OVERRIDE?.trim();
  if (override && ['401', '403', '409', '429', '500'].includes(override)) {
    console.log(`[telemetry] ⚠️ 验收注入生效 status=${override}`);
    // 保真度：注入 429 与真实限流 429 同形（2026-08-25 矩阵复盘发现注入版漏 Retry-After 头）。
    // 头值 env 可配：严格 Retry-After 补验用 45（与设备 fallback 序列 30/60/120 区分），默认 60 同真实限流。
    if (override === '429') c.header('Retry-After', process.env.TELEMETRY_INJECT_RETRY_AFTER?.trim() || '60');
    return c.json({ ok: false, error: 'acceptance_override', reason: `injected_${override}` }, Number(override) as 401);
  }

  const cred = await verifyDeviceCredential(c.req.header('authorization'), process.env.AUTH_JWT_SECRET || '');
  if (!cred) return c.json({ ok: false, error: 'unauthorized', reason: 'credential_missing_or_invalid' }, 401);
  const sn = cred.sn;
  if (!telemetryAllowed(sn)) return c.json({ ok: false, error: 'forbidden', reason: 'device_not_allowed' }, 403);
  if (rateLimited(sn)) {
    c.header('Retry-After', '60');
    return c.json({ ok: false, error: 'rate_limited', reason: 'rate_limited' }, 429);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'bad_request', reason: 'invalid_json' }, 400);
  }
  const parsed = BatchSchema.safeParse(body);
  if (!parsed.success) return c.json({ ok: false, error: 'bad_request', reason: 'invalid_schema' }, 400);
  const batch = parsed.data;
  if (!batch.snapshot && (!batch.events || batch.events.length === 0)) {
    return c.json({ ok: false, error: 'bad_request', reason: 'empty_batch' }, 400);
  }

  const meta = {
    schemaVersion: batch.schema_version,
    deviceTsMs: batch.device_ts_ms,
    serverReceivedMs: Date.now(),
    traceId: c.req.header('x-trace-id')?.slice(0, 80) ?? '',
  };

  let snapshotResult: { accepted: boolean; duplicated: boolean } | null = null;
  if (batch.snapshot) snapshotResult = telemetryStore.ingestSnapshot(sn, batch.snapshot, meta);

  const acked: string[] = [];
  const duplicated: string[] = [];
  const rejected: Array<{ event_id: string; reason: string }> = [];
  for (const ev of batch.events ?? []) {
    if (!EVENT_TYPES.has(ev.type)) {
      rejected.push({ event_id: ev.event_id, reason: 'invalid_event_type' });
      continue;
    }
    if (ev.type === 'device_command' && !DeviceCommandDataSchema.safeParse(ev.data).success) {
      rejected.push({ event_id: ev.event_id, reason: 'invalid_event_data' });
      continue;
    }
    const outcome = telemetryStore.ingestEvent(sn, ev, meta);
    if (outcome === 'accepted') acked.push(ev.event_id);
    else if (outcome === 'duplicated') duplicated.push(ev.event_id);
    else rejected.push({ event_id: ev.event_id, reason: 'event_id_payload_conflict' });
  }

  console.log(
    `[telemetry] batch sn=****${sn.slice(-4)} snap=${snapshotResult ? (snapshotResult.duplicated ? 'dup' : 'ok') : '-'} acked=${acked.length} dup=${duplicated.length} rejected=${rejected.length} skew=${meta.serverReceivedMs - meta.deviceTsMs}ms`,
  );
  return c.json({
    ok: true,
    data: {
      batch_id: batch.batch_id,
      snapshot: snapshotResult,
      acked_event_ids: acked,
      duplicated_event_ids: duplicated,
      rejected,
      server_received_ms: meta.serverReceivedMs,
    },
  });
});

// ─────────────────── 家长聚合查询 ───────────────────

export const parentTelemetryRoute = new Hono<{ Variables: { accountId: string } }>();

parentTelemetryRoute.use('*', async (c, next) => {
  const header = c.req.header('authorization');
  const token = header ? /^Bearer\s+(.+)$/i.exec(header.trim())?.[1] : undefined;
  const auth = await verifyAuthToken(token);
  if (!auth) return c.json({ ok: false, error: 'unauthorized' }, 401);
  c.set('accountId', auth.accountId);
  await next();
});

/** public_id → 本家长绑定的设备；不是自己的/不存在 → null（对外一律 404 不泄露存在性）。 */
function ownedDevice(publicId: string, accountId: string) {
  const dev = deviceRegistryStore.getByPublicId(publicId);
  if (!dev || dev.parent_account_id !== accountId) return null;
  return dev;
}

function tzGuard(c: { req: { query: (k: string) => string | undefined } }): string | null {
  const tz = c.req.query('timezone');
  if (tz && tz !== 'Asia/Shanghai') return null; // P0 聚合固定 +8；给错时区数据不如显式拒绝
  return tz ?? 'Asia/Shanghai';
}

function dateAdd(day: string, deltaDays: number): string {
  return new Date(Date.parse(`${day}T00:00:00+08:00`) + deltaDays * 86400_000 + 8 * 3600_000)
    .toISOString()
    .slice(0, 10);
}

parentTelemetryRoute.get('/:publicId/dashboard', (c) => {
  if (!tzGuard(c)) return c.json({ ok: false, error: 'invalid_timezone', message: 'P0 仅支持 Asia/Shanghai' }, 400);
  const dev = ownedDevice(c.req.param('publicId'), c.get('accountId'));
  if (!dev) return c.json({ ok: false, error: 'not_found' }, 404);

  const now = Date.now();
  const today = dayOf(now);
  const weekFrom = dateAdd(today, -6);
  const daily = telemetryStore.dailyRange(dev.sn, weekFrom, today);
  const todayRow = daily.find((d) => d.date === today);
  const snap = telemetryStore.latestSnapshot(dev.sn);
  const p = snap?.payload;

  // 周日均：只除以已经过的自然日数（合同 §7.1：避免未来天数稀释）
  const totalFocusMin = Math.round(daily.reduce((s, d) => s + d.focus_ms, 0) / 60_000);
  const elapsedDays = daily.filter((d) => d.date < today).length || 1;

  return c.json({
    ok: true,
    data: {
      device: {
        updated_at_ms: snap?.server_received_ms ?? null,
        online: snap ? now - snap.server_received_ms < ONLINE_WINDOW_MS : false,
        lid_open: p?.lid_open ?? null,
        present: p?.present ?? null,
        brightness_level: p?.brightness_level ?? null,
        color_mode: p?.color_mode ?? null,
        image_distance_m: p?.image_distance_m ?? null,
        image_distance_state: p?.image_distance_state ?? null,
      },
      today: {
        focus_minutes: Math.round((todayRow?.focus_ms ?? 0) / 60_000),
        guarded_minutes: Math.round((todayRow?.guarded_ms ?? 0) / 60_000),
        posture_alert_count: todayRow?.reminder_played ?? 0,
      },
      week: {
        total_focus_minutes: totalFocusMin,
        daily_average_focus_minutes: Math.round(
          daily.filter((d) => d.date < today).reduce((s, d) => s + d.focus_ms, 0) / 60_000 / elapsedDays,
        ),
        daily: (() => {
          const map = new Map(daily.map((d) => [d.date, d]));
          const out: Array<{ date: string; focus_minutes: number }> = [];
          for (let i = -6; i <= 0; i += 1) {
            const day = dateAdd(today, i);
            out.push({ date: day, focus_minutes: Math.round((map.get(day)?.focus_ms ?? 0) / 60_000) });
          }
          return out;
        })(),
      },
      availability: { night_reward: false, percentile: false },
    },
  });
});

parentTelemetryRoute.get('/:publicId/weekly-report', (c) => {
  if (!tzGuard(c)) return c.json({ ok: false, error: 'invalid_timezone', message: 'P0 仅支持 Asia/Shanghai' }, 400);
  const dev = ownedDevice(c.req.param('publicId'), c.get('accountId'));
  if (!dev) return c.json({ ok: false, error: 'not_found' }, 404);

  const weekStart = c.req.query('week_start');
  if (weekStart && !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    return c.json({ ok: false, error: 'bad_request', message: 'week_start 须为 YYYY-MM-DD' }, 400);
  }
  // 默认本周一（Asia/Shanghai）
  const today = dayOf(Date.now());
  const dow = (new Date(`${today}T00:00:00+08:00`).getUTCDay() + 6) % 7; // 周一=0
  const from = weekStart ?? dateAdd(today, -dow);
  const to = dateAdd(from, 6);
  const daily = telemetryStore.dailyRange(dev.sn, from, to);

  const correct = daily.reduce((s, d) => s + d.correct_rounds, 0);
  const deviated = daily.reduce((s, d) => s + d.deviated_rounds, 0);
  const denom = correct + deviated; // no_person/failed 不进分母（合同 §7.2）
  return c.json({
    ok: true,
    data: {
      week_start: from,
      eye_health_rate: denom > 0 ? Math.round((correct / denom) * 100) : null,
      guarded_minutes: Math.round(daily.reduce((s, d) => s + d.guarded_ms, 0) / 60_000),
      posture_alert_count: daily.reduce((s, d) => s + d.reminder_played, 0),
      percentile: null,
      highlights: [], // P1：server 聚合生成文案
      data_quality: {
        valid_posture_rounds: denom,
        missing_hours: null, // P0 未实现——返回 null 不撒谎（不给假 0）
      },
    },
  });
});
