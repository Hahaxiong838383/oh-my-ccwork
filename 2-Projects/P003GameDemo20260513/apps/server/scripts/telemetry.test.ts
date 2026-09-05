/**
 * 设备遥测全链回归 · 跑法：npm run test:telemetry（tsx 直跑，无框架）
 *
 * 覆盖（合同 CODEX_P003_DEVICE_TELEMETRY_REPLY_20260824 + 验收矩阵 server 侧项）：
 *  - 鉴权门（T1/T2）：无凭据/坏凭据 401、body 零 SN（sub 即身份）
 *  - 灰度门：TELEMETRY_SN_ALLOWLIST 白名单外 403、清空放开
 *  - schema 门：invalid_json/invalid_schema/empty_batch/超 50 条
 *  - 三层幂等（T3/T4）：快照 duplicated；事件 accepted→duplicated→conflict(rejected)
 *  - 聚合：focus_segment 入 daily；duplicated 不重复计；跨日切分；posture 轮分类；reminder 计数
 *  - parent API（T15/T16 前置）：public_id 反查、非本家长 404、dashboard 映射、健康率分母（no_person 不进）
 *  - 限频 429 + Retry-After；错误注入开关
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'telemetry-test-'));
process.env.TELEMETRY_DB_PATH = join(tmp, 'telemetry.db');
process.env.DEVICES_DB_PATH = join(tmp, 'devices.db');
process.env.ACCOUNTS_DB_PATH = join(tmp, 'accounts.db');
process.env.PROFILE_DB_PATH = join(tmp, 'profile.db');
process.env.AUTH_JWT_SECRET = 'test-secret';
delete process.env.TELEMETRY_SN_ALLOWLIST;
delete process.env.TELEMETRY_ACCEPTANCE_OVERRIDE;

const { Hono } = await import('hono');
const { SignJWT } = await import('jose');
const { deviceTelemetryRoute, parentTelemetryRoute } = await import('../src/routes/telemetry.js');
const { deviceRegistryStore } = await import('../src/device-registry-store.js');
const { telemetryStore, dayOf } = await import('../src/telemetry-store.js');

let pass = 0;
let fail = 0;
function eq(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) pass += 1;
  else {
    fail += 1;
    console.error(`FAIL ${name} got=${g} want=${w}`);
  }
}

const app = new Hono();
app.route('/v1/device/telemetry', deviceTelemetryRoute);
app.route('/v1/parent/devices', parentTelemetryRoute);

const secret = new TextEncoder().encode('test-secret');
async function deviceJwt(sn: string): Promise<string> {
  return new SignJWT({ kind: 'p003-device', sub: sn })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(secret);
}
async function parentJwt(accountId: string): Promise<string> {
  return new SignJWT({ accountId, role: 'parent' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer('p003')
    .setAudience('kidshub')
    .setExpirationTime('1h')
    .sign(secret);
}

const SN = 'BJP00326060100000021';
const SN_OTHER = 'BJP00326060100000022';
deviceRegistryStore.add(SN, '遥测测试机');
deviceRegistryStore.add(SN_OTHER, '别人家设备');
deviceRegistryStore.setParentAccountId(SN, 'acct-90');
deviceRegistryStore.setParentAccountId(SN_OTHER, 'acct-91');
const PUB = deviceRegistryStore.get(SN)!.public_id!;
const PUB_OTHER = deviceRegistryStore.get(SN_OTHER)!.public_id!;

async function postBatch(token: string | null, body: unknown): Promise<{ status: number; json: any }> {
  const res = await app.request('/v1/device/telemetry', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
async function get(path: string, token: string): Promise<{ status: number; json: any }> {
  const res = await app.request(path, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

const tk = await deviceJwt(SN);
const NOW = Date.now();
function mkBatch(extra: Record<string, unknown>): Record<string, unknown> {
  return { schema_version: 1, batch_id: `tel_test_${Math.random()}`, device_ts_ms: NOW, ...extra };
}
function snap(id: string): Record<string, unknown> {
  return { snapshot_id: id, captured_at_ms: NOW, brightness_level: 1, color_mode: 'normal', image_distance_m: 3.0, image_distance_state: 'valid', present: true };
}

// ---------- 鉴权门 ----------
eq('auth-1 无凭据 401', (await postBatch(null, mkBatch({ snapshot: snap('s0') }))).status, 401);
eq('auth-2 坏凭据 401', (await postBatch('garbage', mkBatch({ snapshot: snap('s0') }))).status, 401);

// ---------- 灰度门 ----------
process.env.TELEMETRY_SN_ALLOWLIST = 'BJP00326060100999999';
{
  const r = await postBatch(tk, mkBatch({ snapshot: snap('s0') }));
  eq('allow-1 白名单外 403', { status: r.status, reason: r.json.reason }, { status: 403, reason: 'device_not_allowed' });
}
process.env.TELEMETRY_SN_ALLOWLIST = ` ${SN} ,BJP00326060100999999`;
eq('allow-2 白名单内放行', (await postBatch(tk, mkBatch({ snapshot: snap('s1') }))).status, 200);
delete process.env.TELEMETRY_SN_ALLOWLIST;
eq('allow-3 未设=放开', (await postBatch(tk, mkBatch({ snapshot: snap('s2') }))).status, 200);

// ---------- schema 门 ----------
eq('schema-1 坏 JSON', (await postBatch(tk, '{oops')).json.reason, 'invalid_json');
eq('schema-2 版本≠1', (await postBatch(tk, { ...mkBatch({ snapshot: snap('x') }), schema_version: 2 })).json.reason, 'invalid_schema');
eq('schema-3 空批', (await postBatch(tk, mkBatch({}))).json.reason, 'empty_batch');
{
  const events = Array.from({ length: 51 }, (_, i) => ({ event_id: `e${i}`, type: 'presence_transition', occurred_at_ms: NOW, data: {} }));
  eq('schema-4 超 50 条', (await postBatch(tk, mkBatch({ events }))).json.reason, 'invalid_schema');
}

// ---------- 快照幂等 ----------
{
  const r = await postBatch(tk, mkBatch({ snapshot: snap('s1') })); // s1 在 allow-2 已发过
  eq('snap-1 重复 snapshot duplicated', r.json.data.snapshot, { accepted: true, duplicated: true });
}

// ---------- 事件三态 + 聚合 ----------
const FOCUS_START = Date.parse(`${dayOf(NOW)}T10:00:00+08:00`);
const seg = {
  event_id: 'evt_seg_1',
  type: 'focus_segment',
  occurred_at_ms: FOCUS_START + 600_000,
  data: { focus_id: 'f1', start_ms: FOCUS_START, end_ms: FOCUS_START + 600_000, duration_ms: 600_000, end_reason: 'presence_lost' },
};
{
  const r = await postBatch(tk, mkBatch({ events: [seg] }));
  eq('evt-1 accepted', r.json.data.acked_event_ids, ['evt_seg_1']);
  const r2 = await postBatch(tk, mkBatch({ events: [seg] }));
  eq('evt-2 同 ID 同 payload duplicated', r2.json.data.duplicated_event_ids, ['evt_seg_1']);
  const r3 = await postBatch(tk, mkBatch({ events: [{ ...seg, data: { ...seg.data, duration_ms: 1 } }] }));
  eq('evt-3 同 ID 异 payload conflict', r3.json.data.rejected, [{ event_id: 'evt_seg_1', reason: 'event_id_payload_conflict' }]);
  const today = telemetryStore.dailyRange(SN, dayOf(NOW), dayOf(NOW));
  eq('agg-1 聚合 10min 且 duplicated 不重复计', today[0]?.focus_ms, 600_000);
}
{
  // 跨日切分：昨日 23:50 → 今日 00:10
  const midnight = Date.parse(`${dayOf(NOW)}T00:00:00+08:00`);
  const ev = {
    event_id: 'evt_seg_cross',
    type: 'focus_segment',
    occurred_at_ms: midnight + 600_000,
    data: { focus_id: 'f2', start_ms: midnight - 600_000, end_ms: midnight + 600_000, duration_ms: 1_200_000, end_reason: 'lid_closed' },
  };
  await postBatch(tk, mkBatch({ events: [ev] }));
  const yesterday = telemetryStore.dailyRange(SN, dayOf(midnight - 1), dayOf(midnight - 1));
  const today = telemetryStore.dailyRange(SN, dayOf(NOW), dayOf(NOW));
  eq('agg-2 跨日切分', { y: yesterday[0]?.focus_ms, t: today[0]?.focus_ms }, { y: 600_000, t: 1_200_000 });
}
{
  const mk = (id: string, result: string) => ({ event_id: id, type: 'posture_round', occurred_at_ms: NOW, data: { result, focus_id: 'f1' } });
  await postBatch(tk, mkBatch({ events: [mk('pr1', 'correct'), mk('pr2', 'correct'), mk('pr3', 'deviated'), mk('pr4', 'no_person'), mk('pr5', 'failed')] }));
  await postBatch(tk, mkBatch({ events: [
    { event_id: 'rm1', type: 'posture_reminder', occurred_at_ms: NOW, data: { outcome: 'played' } },
    { event_id: 'rm2', type: 'posture_reminder', occurred_at_ms: NOW, data: { outcome: 'suppressed' } },
  ] }));
  const today = telemetryStore.dailyRange(SN, dayOf(NOW), dayOf(NOW))[0]!;
  eq('agg-3 姿态轮分类', { c: today.correct_rounds, d: today.deviated_rounds, r: today.reminder_played }, { c: 2, d: 1, r: 1 });
  eq('agg-4 guarded=有姿态轮的日 focus', today.guarded_ms, today.focus_ms);
}
eq('evt-4 未知 type rejected', (await postBatch(tk, mkBatch({ events: [{ event_id: 'x1', type: 'alien_event', occurred_at_ms: NOW, data: {} }] }))).json.data.rejected, [{ event_id: 'x1', reason: 'invalid_event_type' }]);

// ---------- device_command（合同 v3.1 §4，2026-09-05）----------
{
  const dc = (id: string, data: Record<string, unknown>) => ({ event_id: id, type: 'device_command', occurred_at_ms: NOW, data });
  const good = {
    source: 'vad_chip', label: 2, action: 'led_on', lane: 'L0', status: 'succeeded', reason: 'state_confirmed',
    execution_ms: 180, mcu_tx_count: 3, steps_done: 1, boundary_basis: 'none', spoken_locally: true, candidate_seq: 1, trace_id: 'trace-dc-1',
  };
  let r = await postBatch(tk, mkBatch({ events: [dc('dc_1', good)] }));
  eq('dc-1 合法 device_command 逐条 ACK', r.json.data.acked_event_ids, ['dc_1']);
  r = await postBatch(tk, mkBatch({ events: [dc('dc_1', good)] }));
  eq('dc-2 同 event_id 同 payload 重传 = duplicated（不重复入账）', r.json.data.duplicated_event_ids, ['dc_1']);
  r = await postBatch(tk, mkBatch({ events: [dc('dc_x', { ...good, canonical_phrase: '打开灯光' })] }));
  eq('dc-3 多余键（原话类）拒 invalid_event_data', r.json.data.rejected, [{ event_id: 'dc_x', reason: 'invalid_event_data' }]);
  r = await postBatch(tk, mkBatch({ events: [dc('dc_r', { ...good, reason: 'r'.repeat(65) })] }));
  eq('dc-4 reason>64 拒', r.json.data.rejected[0]?.reason, 'invalid_event_data');
  r = await postBatch(tk, mkBatch({ events: [dc('dc_n', { ...good, lane: null, trace_id: null, candidate_seq: null, source: 'ui' })] }));
  eq('dc-5 lane/trace/candidate 可空（UI 来源）', r.json.data.acked_event_ids, ['dc_n']);
  r = await postBatch(tk, mkBatch({ events: [dc('dc_a', { ...good, status: 'accepted' })] }));
  eq('dc-6 非终态 accepted 不是执行事件，拒', r.json.data.rejected[0]?.reason, 'invalid_event_data');
  r = await postBatch(tk, mkBatch({ events: [dc('dc_bad', { ...good, mcu_tx_count: 'three' }), dc('dc_ok', { ...good, label: 6, action: 'brightness_down' })] }));
  eq('dc-7 坏事件不误删同批其他事件', { rej: r.json.data.rejected.map((x: { event_id: string }) => x.event_id), ack: r.json.data.acked_event_ids }, { rej: ['dc_bad'], ack: ['dc_ok'] });
  eq('dc-8 坏事件的批仍 200（逐条 ACK 语义）', r.status, 200);
}

// ---------- parent API ----------
const ptk = await parentJwt('acct-90');
{
  eq('parent-1 无 token 401', (await app.request(`/v1/parent/devices/${PUB}/dashboard`)).status, 401);
  eq('parent-2 别人的设备 404', (await get(`/v1/parent/devices/${PUB_OTHER}/dashboard`, ptk)).status, 404);
  eq('parent-3 不存在的 public_id 404', (await get(`/v1/parent/devices/dev_nonexistent00/dashboard`, ptk)).status, 404);
  const r = await get(`/v1/parent/devices/${PUB}/dashboard`, ptk);
  eq('parent-4 dashboard 今日专注分钟', r.json.data.today.focus_minutes, 20); // seg_1 10min + 跨日段今日半 10min
  eq('parent-5 设备实时态映射', { b: r.json.data.device.brightness_level, d: r.json.data.device.image_distance_m }, { b: 1, d: 3 });
  eq('parent-6 availability 关闭项', r.json.data.availability, { night_reward: false, percentile: false });
  eq('parent-7 时区门', (await get(`/v1/parent/devices/${PUB}/dashboard?timezone=America/New_York`, ptk)).status, 400);
  const w = await get(`/v1/parent/devices/${PUB}/weekly-report`, ptk);
  eq('parent-8 健康率分母只含 correct+deviated', { rate: w.json.data.eye_health_rate, valid: w.json.data.data_quality.valid_posture_rounds }, { rate: 67, valid: 3 });
  eq('parent-9 missing_hours 诚实 null', w.json.data.data_quality.missing_hours, null);
}

// ---------- 错误注入 ----------
process.env.TELEMETRY_ACCEPTANCE_OVERRIDE = '429';
eq('inject-1 注入 429', (await postBatch(tk, mkBatch({ snapshot: snap('s9') }))).status, 429);
delete process.env.TELEMETRY_ACCEPTANCE_OVERRIDE;

// ---------- 限频（放最后：会吃掉 SN 的窗口额度）----------
{
  let last = 0;
  for (let i = 0; i < 260; i += 1) {
    const r = await postBatch(tk, mkBatch({ snapshot: snap(`rate_${i}`) }));
    last = r.status;
    if (last === 429) break;
  }
  eq('rate-1 触发 429', last, 429);
}

console.log(`\ntelemetry.test: pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
