/**
 * 设备诊断日志上云回归 · 跑法：npm run test:diaglog（tsx 直跑，无框架）
 *
 * 覆盖（合同 DIAGNOSTIC_LOG_SERVER_HANDOFF + openapi + CC 复核回执 v1 §3/§7 + codex §4 回复）：
 *  - 路由：字面冒号 logs:batch 命中、%3A 编码 404（端侧必须字面发）
 *  - 门序：401（只来自凭据）/ 403 灰度（未设=全关 fail-closed、`*`、名单、DB disabled）/ 503 开关（全局+SN 覆盖+admin 一键）
 *         / 429 限频（Retry-After 60 + 容量锚 ≥2×Godot 节奏）/ 413 体积（64 KiB、21 条）/ 400 schema
 *  - 逐条：白名单拒收 event_not_allowed（+ env 扩展）/ invalid_event / event_too_large / 无 ID 只留档不进响应 / message 裁 512
 *  - 幂等：(SN, client_event_id) 作用域；同载荷重放 3 次一行；异载荷 conflict；跨 SN 同 ID 互不影响；同批重复 ID 只回一次
 *  - 脱敏：key 黑名单 / SN 全文 / JWT / 手机号 / 深度 / 数组；负向锚（明文 SN 注入后存储行必须无原文）
 *  - 时钟：偏差 30h 不拒、只记 clock_skew_ms；occurred_at_ms=0 可收
 *  - 响应形状：成功 7 键、错误体键集、X-Request-Id 回显
 *  - 保留：purge 14 天默认 + 老行被删新行保留
 *  - 注入开关 429/503 带 Retry-After；admin summary/events/rejected/switch
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'diaglog-test-'));
process.env.DIAGNOSTICS_DB_PATH = join(tmp, 'diagnostics.db');
process.env.DEVICES_DB_PATH = join(tmp, 'devices.db');
process.env.CONFIG_DB_PATH = join(tmp, 'config.db');
process.env.ACCOUNTS_DB_PATH = join(tmp, 'accounts.db');
process.env.PROFILE_DB_PATH = join(tmp, 'profile.db');
process.env.TELEMETRY_DB_PATH = join(tmp, 'telemetry.db');
process.env.AUTH_JWT_SECRET = 'test-secret';
for (const k of ['DIAGLOG_SN_ALLOWLIST', 'DIAGLOG_ACCEPTANCE_OVERRIDE', 'DIAGLOG_EVENT_ALLOWLIST_EXTRA', 'DIAGLOG_BATCH_RPM', 'DIAGLOG_RETENTION_DAYS', 'DIAGLOG_INJECT_RETRY_AFTER'])
  delete process.env[k];

const { Hono } = await import('hono');
const { SignJWT } = await import('jose');
const diag = await import('../src/routes/diagnostics.js');
const { diagnosticsDeviceRoute, diagnosticsAdminRoute, resetRateLimitForTests } = diag;
const { deviceRegistryStore } = await import('../src/device-registry-store.js');
const { configStore } = await import('../src/config-store.js');
const { diagnosticsStore, DIAGLOG_RETENTION_DAYS_DEFAULT } = await import('../src/diagnostics-store.js');
const { sanitizeData, redactString } = await import('../src/diagnostics-redact.js');

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
app.route('/v1/device/diagnostics', diagnosticsDeviceRoute);
app.route('/api/admin/diagnostics', diagnosticsAdminRoute);

const secret = new TextEncoder().encode('test-secret');
async function deviceJwt(sn: string): Promise<string> {
  return new SignJWT({ kind: 'p003-device', sub: sn }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('1h').sign(secret);
}

const SN = 'BJP00326060100000031';
const SN_OTHER = 'BJP00326060100000032';
const SN_DISABLED = 'BJP00326060100000033';
deviceRegistryStore.add(SN, '诊断日志测试机');
deviceRegistryStore.add(SN_OTHER, '另一台');
deviceRegistryStore.add(SN_DISABLED, '停用机');
deviceRegistryStore.setStatus(SN_DISABLED, 'disabled');
const tk = await deviceJwt(SN);
const tkOther = await deviceJwt(SN_OTHER);
const tkDisabled = await deviceJwt(SN_DISABLED);

const PATH = '/v1/device/diagnostics/logs:batch';
type Res = { status: number; json: any; headers: Headers };
async function post(token: string | null, body: unknown, headers: Record<string, string> = {}, path = PATH): Promise<Res> {
  const res = await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})), headers: res.headers };
}
async function admin(path: string, init: RequestInit = {}): Promise<Res> {
  const res = await app.request(path, { ...init, headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) } });
  return { status: res.status, json: await res.json().catch(() => ({})), headers: res.headers };
}

const NOW = Date.now();
let seq = 0;
const nid = () => `g1-testboot-${++seq}`;
function ev(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    client_event_id: nid(),
    occurred_at_ms: NOW,
    level: 'error',
    component: 'godot',
    event: 'runtime.error',
    message: 'RUNTIME_UNAVAILABLE',
    trace_id: '',
    data: { action: 'g1.progress.tick' },
    ...overrides,
  };
}
function batch(events: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    sent_at_ms: NOW,
    client: { product: 'p003', component: 'godot_g1', protocol_version: '1.0', content_version: 'g1-test' },
    events,
    ...extra,
  };
}

// ---------- 路由：冒号字面 ----------
process.env.DIAGLOG_SN_ALLOWLIST = '*';
{
  const r = await post(tk, batch([ev()]));
  eq('route-1 字面 logs:batch 命中 200', r.status, 200);
  const r2 = await post(tk, batch([ev()]), {}, '/v1/device/diagnostics/logs%3Abatch');
  eq('route-2 %3A 编码 404（端侧必须字面发）', r2.status, 404);
}

// ---------- 401 只来自凭据 ----------
{
  const r = await post(null, batch([ev()]));
  eq('auth-1 无凭据 401', { status: r.status, code: r.json.error_code, rid: typeof r.json.request_id }, { status: 401, code: 'unauthorized', rid: 'string' });
  eq('auth-2 坏凭据 401', (await post('garbage', batch([ev()]))).status, 401);
  const id = nid();
  const r3 = await post(tk, batch([ev({ client_event_id: id })], { sn: SN_OTHER, serial: SN_OTHER, installation_id: 'x' }));
  eq('auth-3 body 自报 sn 被忽略：按凭据 sub 落库', { status: r3.status, mine: !!diagnosticsStore.getEvent(SN, id), theirs: !!diagnosticsStore.getEvent(SN_OTHER, id) }, { status: 200, mine: true, theirs: false });
}

// ---------- 灰度门 ----------
delete process.env.DIAGLOG_SN_ALLOWLIST;
{
  const r = await post(tk, batch([ev()]));
  eq('gate-1 名单未设=全关 fail-closed 403', { status: r.status, code: r.json.error_code }, { status: 403, code: 'device_not_allowed' });
}
process.env.DIAGLOG_SN_ALLOWLIST = 'BJP00326060100999999';
eq('gate-2 名单只有别人 403', (await post(tk, batch([ev()]))).status, 403);
process.env.DIAGLOG_SN_ALLOWLIST = ` BJP00326060100999999, ${SN} `;
eq('gate-3 名单含本机 200', (await post(tk, batch([ev()]))).status, 200);
process.env.DIAGLOG_SN_ALLOWLIST = '*';
eq('gate-4 * 全开 200', (await post(tkOther, batch([ev()]))).status, 200);
eq('gate-5 DB disabled 设备即使 * 也 403', (await post(tkDisabled, batch([ev()]))).status, 403);

// ---------- 远程开关 ----------
{
  eq('sw-0 内置默认开', configStore.getEffectiveBool(SN, diag.SWITCH_CONFIG_KEY), true);
  eq('sw-0b 设备快照暂不含 diagnostics 域（serverOnly，等 Launcher 确认后翻）', 'diagnostics' in configStore.effectiveSnapshot(SN), false);
  configStore.setGlobal(diag.SWITCH_CONFIG_KEY, false);
  const r = await post(tk, batch([ev()]));
  eq('sw-1 全局关 → 503 LOG_UPLOAD_DISABLED + Retry-After 900', { status: r.status, code: r.json.error_code, ra: r.headers.get('retry-after'), ms: r.json.retry_after_ms }, { status: 503, code: 'LOG_UPLOAD_DISABLED', ra: '900', ms: 900000 });
  configStore.setGlobal(diag.SWITCH_CONFIG_KEY, true);
  configStore.setValue(SN, diag.SWITCH_CONFIG_KEY, false);
  eq('sw-2 全局开 + 本机覆盖关 → 本机 503', (await post(tk, batch([ev()]))).status, 503);
  eq('sw-2b 别的设备不受影响 200', (await post(tkOther, batch([ev()]))).status, 200);
  configStore.clearForSn(SN, diag.SWITCH_CONFIG_KEY);
  eq('sw-3 清覆盖 → 200', (await post(tk, batch([ev()]))).status, 200);
  const a1 = await admin('/api/admin/diagnostics/switch', { method: 'PUT', body: JSON.stringify({ enabled: false }) });
  eq('sw-4a admin 一键关', { ok: a1.json.ok, g: a1.json.switch?.global }, { ok: true, g: false });
  eq('sw-4b 关后设备 503', (await post(tk, batch([ev()]))).status, 503);
  const a2 = await admin('/api/admin/diagnostics/switch', { method: 'PUT', body: JSON.stringify({ enabled: true }) });
  eq('sw-4c admin 一键开', a2.json.switch?.global, true);
  eq('sw-4d 开后 200', (await post(tk, batch([ev()]))).status, 200);
  eq('sw-4e 非 boolean 400', (await admin('/api/admin/diagnostics/switch', { method: 'PUT', body: JSON.stringify({ enabled: 'no' }) })).status, 400);
}

// ---------- 限频 ----------
{
  process.env.DIAGLOG_BATCH_RPM = '3';
  resetRateLimitForTests();
  const s = [];
  for (let i = 0; i < 4; i += 1) s.push((await post(tk, batch([ev()]))).status);
  eq('rate-1 第 4 批 429', s, [200, 200, 200, 429]);
  const r = await post(tk, batch([ev()]));
  eq('rate-1b 429 带 Retry-After 60 + retry_after_ms', { ra: r.headers.get('retry-after'), ms: r.json.retry_after_ms, code: r.json.error_code }, { ra: '60', ms: 60000, code: 'rate_limited' });
  delete process.env.DIAGLOG_BATCH_RPM;
  resetRateLimitForTests();
  eq('rate-2 容量锚：默认限额 ≥ 2×Godot 声明节奏', diag.DIAGLOG_BATCH_RPM_DEFAULT >= 2 * diag.GODOT_DECLARED_BATCHES_PER_MIN, true);
  eq('rate-3 冻结值 30 批/分钟', diag.DIAGLOG_BATCH_RPM_DEFAULT, 30);
}

// ---------- 体积 ----------
{
  const r = await post(tk, batch([ev({ message: 'x'.repeat(70_000) })]));
  eq('size-1 body > 64 KiB → 413', { status: r.status, code: r.json.error_code }, { status: 413, code: 'batch_too_large' });
  const r2 = await post(tk, batch(Array.from({ length: 21 }, () => ev())));
  eq('size-2 21 条 → 413', { status: r2.status, code: r2.json.error_code }, { status: 413, code: 'batch_too_large' });
  const big: Record<string, string> = {};
  for (let i = 0; i < 32; i += 1) big[`k${i}`] = 'y'.repeat(512);
  const id = nid();
  const r3 = await post(tk, batch([ev({ client_event_id: id, data: big })]));
  eq('size-3 单条脱敏后 > 8 KiB → rejected event_too_large', { status: r3.status, rejected: r3.json.rejected }, { status: 200, rejected: [{ client_event_id: id, reason: 'event_too_large' }] });
  eq('size-4 限额常量', [diag.MAX_EVENTS_PER_BATCH, diag.MAX_BATCH_BYTES, diag.MAX_EVENT_BYTES], [20, 65536, 8192]);
}

// ---------- schema ----------
{
  eq('schema-1 坏 JSON → 400 invalid_json', (await post(tk, '{oops')).json.message, 'invalid_json');
  const r = await post(tk, { ...batch([ev()]), schema_version: 2 });
  eq('schema-2 schema_version≠1 → 400', { status: r.status, msg: String(r.json.message).startsWith('invalid_schema') }, { status: 400, msg: true });
  const r3 = await post(tk, batch([]));
  eq('schema-3 空批 400 empty_batch', { status: r3.status, msg: r3.json.message }, { status: 400, msg: 'empty_batch' });
  const { client: _c, ...noClient } = batch([ev()]);
  eq('schema-4 缺 client 400', (await post(tk, noClient)).status, 400);
  eq('schema-5 未知顶层键忽略 200', (await post(tk, batch([ev()], { future_field: 1 }))).status, 200);
  eq('schema-6 events 非数组 400', (await post(tk, batch([] as unknown[], { events: 'nope' }))).status, 400);
}

// ---------- 逐条 ----------
{
  const id = nid();
  const r = await post(tk, batch([ev({ client_event_id: id, event: 'not.registered' })]));
  eq('ev-1 未登记事件 → rejected event_not_allowed', { acc: r.json.accepted_event_ids, rej: r.json.rejected, ids: r.json.rejected_event_ids }, { acc: [], rej: [{ client_event_id: id, reason: 'event_not_allowed' }], ids: [id] });
  process.env.DIAGLOG_EVENT_ALLOWLIST_EXTRA = ' custom.one , not.registered ';
  const id2 = nid();
  eq('ev-2 env 扩展白名单后放行', (await post(tk, batch([ev({ client_event_id: id2, event: 'not.registered' })]))).json.accepted_event_ids, [id2]);
  delete process.env.DIAGLOG_EVENT_ALLOWLIST_EXTRA;
  const id3 = nid();
  eq('ev-3 level 非法 → invalid_event', (await post(tk, batch([ev({ client_event_id: id3, level: 'loud' })]))).json.rejected, [{ client_event_id: id3, reason: 'invalid_event' }]);
  const r4 = await post(tk, batch([{ ...ev(), client_event_id: undefined }]));
  eq('ev-4 无 ID 事件：只留档不进响应', { status: r4.status, acc: r4.json.accepted_event_ids, rej: r4.json.rejected }, { status: 200, acc: [], rej: [] });
  const id5 = nid();
  await post(tk, batch([ev({ client_event_id: id5, message: 'm'.repeat(700) })]));
  eq('ev-5 message 700 → 裁到 512+…', diagnosticsStore.getEvent(SN, id5)?.message.length, 513);
  const id6 = nid();
  eq('ev-6 trace_id > 96 → invalid_event', (await post(tk, batch([ev({ client_event_id: id6, trace_id: 't'.repeat(97) })]))).json.rejected, [{ client_event_id: id6, reason: 'invalid_event' }]);
  const id7 = nid();
  const r7 = await post(tk, batch([ev({ client_event_id: id7, event: 'runtime.error' }), ev({ client_event_id: nid(), event: 'nope.x' }), ev({ client_event_id: nid(), level: 'bad' })]));
  eq('ev-7 混合批：部分成功 200，各归各位', { status: r7.status, acc: r7.json.accepted_event_ids, rejN: r7.json.rejected.length }, { status: 200, acc: [id7], rejN: 2 });
}

// ---------- 幂等 ----------
{
  const id = nid();
  const b = batch([ev({ client_event_id: id })]);
  const rs = [];
  for (let i = 0; i < 3; i += 1) rs.push((await post(tk, b)).json.accepted_event_ids);
  eq('idem-1 同批重放 3 次都 accepted', rs, [[id], [id], [id]]);
  eq('idem-1b 只落一行', diagnosticsStore.listEvents({ sn: SN, limit: 200 }).filter((r) => r.client_event_id === id).length, 1);
  const r2 = await post(tk, batch([ev({ client_event_id: id, message: 'DIFFERENT' })]));
  eq('idem-2 同 ID 异载荷 → event_id_payload_conflict', r2.json.rejected, [{ client_event_id: id, reason: 'event_id_payload_conflict' }]);
  eq('idem-2b 原行不被覆盖', diagnosticsStore.getEvent(SN, id)?.message, 'RUNTIME_UNAVAILABLE');
  const r3 = await post(tkOther, batch([ev({ client_event_id: id })]));
  eq('idem-3 另一 SN 同 ID 各自成行', { acc: r3.json.accepted_event_ids, rows: [!!diagnosticsStore.getEvent(SN, id), !!diagnosticsStore.getEvent(SN_OTHER, id)] }, { acc: [id], rows: [true, true] });
  const id4 = nid();
  const e4 = ev({ client_event_id: id4 });
  eq('idem-4 同批内重复 ID 只回一次', (await post(tk, batch([e4, e4]))).json.accepted_event_ids, [id4]);
}

// ---------- 脱敏 ----------
{
  const id = nid();
  const RAW_SN = 'BJP00326060100777777';
  await post(tk, batch([ev({ client_event_id: id, message: `device ${RAW_SN} failed`, data: { wifi_password: 'hunter2', nested: { access_token: 'abc', ok: 1 }, jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlX3NpZ25hdHVyZQ', phone: 'call 13912344569 now', deep: { a: { b: { c: { d: { e: 1 } } } } }, arr: Array.from({ length: 40 }, (_, i) => i) } })]));
  const row = diagnosticsStore.getEvent(SN, id)!;
  const data = JSON.parse(row.data_json);
  eq('red-1 key 黑名单整值替换', data.wifi_password, '[redacted]');
  eq('red-2 message 里 SN 全文掩码', row.message, 'device ****7777 failed');
  eq('red-2b 负向锚：存储行任何字段都不含原 SN', JSON.stringify(row).includes(RAW_SN), false);
  eq('red-3 JWT 三段 → [redacted-jwt]', data.jwt, '[redacted-jwt]');
  eq('red-4 手机号中间打星', data.phone, 'call 139****4569 now');
  eq('red-5 深度超限裁剪', JSON.stringify(data.deep).includes('[depth-truncated]'), true);
  eq('red-6 数组 40 → 32', data.arr.length, 32);
  eq('red-7 嵌套 key 黑名单', data.nested, { access_token: '[redacted]', ok: 1 });
  eq('red-8 redacted_count 计数 ≥ 5', row.redacted_count >= 5, true);
  eq('red-9 纯函数负锚：无敏感键 → 0', sanitizeData({ ok: 'x', n: 1 }).redacted, 0);
  eq('red-9b 纯函数正锚：敏感键 → 1', sanitizeData({ wifi_password: 'x' }).redacted, 1);
  eq('red-10 redactString 对普通串零改动', redactString('hello 2026-09-19'), { value: 'hello 2026-09-19', hits: 0 });
  eq('red-11 拒绝留档摘录也脱敏', diagnosticsStore.listRejected({ sn: SN, limit: 200 }).some((r) => r.excerpt.includes(RAW_SN)), false);
}

// ---------- 时钟 ----------
{
  const id = nid();
  const r = await post(tk, batch([ev({ client_event_id: id })], { sent_at_ms: NOW - 30 * 3600_000 }));
  const row = diagnosticsStore.getEvent(SN, id)!;
  eq('skew-1 偏差 30h 不拒', { status: r.status, acc: r.json.accepted_event_ids }, { status: 200, acc: [id] });
  eq('skew-1b clock_skew_ms 记录 ≈30h', row.clock_skew_ms >= 30 * 3600_000 && row.clock_skew_ms < 30 * 3600_000 + 60_000, true);
  const id2 = nid();
  eq('skew-2 occurred_at_ms=0 可收', (await post(tk, batch([ev({ client_event_id: id2, occurred_at_ms: 0 })]))).json.accepted_event_ids, [id2]);
}

// ---------- 响应形状 ----------
{
  const r = await post(tk, batch([ev()]), { 'x-request-id': 'rid-abc-123' });
  eq('resp-1 成功体恰好 7 键', Object.keys(r.json).sort(), ['accepted_event_ids', 'ok', 'rejected', 'rejected_event_ids', 'request_id', 'retry_after_ms', 'server_time_ms'].sort());
  eq('resp-2 X-Request-Id 回显', r.json.request_id, 'rid-abc-123');
  eq('resp-3 server_time_ms 是数字 & retry_after_ms=0', { t: typeof r.json.server_time_ms, ra: r.json.retry_after_ms }, { t: 'number', ra: 0 });
  const e = await post(null, batch([ev()]));
  eq('resp-4 错误体键集 ⊆ openapi ErrorResponse', Object.keys(e.json).every((k) => ['ok', 'error_code', 'message', 'retry_after_ms', 'request_id'].includes(k)), true);
}

// ---------- 保留 ----------
{
  eq('purge-1 默认 14 天', DIAGLOG_RETENTION_DAYS_DEFAULT, 14);
  const oldMeta = { schemaVersion: 1, sentAtMs: NOW - 20 * 86_400_000, serverReceivedMs: NOW - 20 * 86_400_000, requestId: 'old', client: { product: 'p003', component: 'godot_g1', protocol_version: '1.0', content_version: '' } };
  diagnosticsStore.ingestEvent(SN, { client_event_id: 'old-1', occurred_at_ms: 1, level: 'info', component: 'godot', event: 'godot.startup', message: 'old', trace_id: '', data: {}, redacted_count: 0 }, oldMeta);
  diagnosticsStore.recordBatch(SN, { events_total: 1, accepted: 1, duplicated: 0, rejected: 0, redacted: 0 }, oldMeta);
  const before = !!diagnosticsStore.getEvent(SN, 'old-1');
  const p = diagnosticsStore.purge(14, NOW);
  eq('purge-2 20 天前的行被删、近期行保留', { before, deletedEvents: p.events, deletedBatches: p.batches, after: !!diagnosticsStore.getEvent(SN, 'old-1'), recentKept: diagnosticsStore.listEvents({ sn: SN, limit: 200 }).length > 0 }, { before: true, deletedEvents: 1, deletedBatches: 1, after: false, recentKept: true });
  eq('purge-3 一小时内不重复跑', diagnosticsStore.maybePurge(14, NOW + 1000), null);
}

// ---------- 注入 ----------
{
  process.env.DIAGLOG_ACCEPTANCE_OVERRIDE = '429';
  const r = await post(tk, batch([ev()]));
  eq('inj-1 注入 429 带 Retry-After 60', { status: r.status, ra: r.headers.get('retry-after'), code: r.json.error_code }, { status: 429, ra: '60', code: 'acceptance_override' });
  process.env.DIAGLOG_ACCEPTANCE_OVERRIDE = '503';
  const r2 = await post(tk, batch([ev()]));
  eq('inj-2 注入 503 带 Retry-After 900', { status: r2.status, ra: r2.headers.get('retry-after'), ms: r2.json.retry_after_ms }, { status: 503, ra: '900', ms: 900000 });
  delete process.env.DIAGLOG_ACCEPTANCE_OVERRIDE;
  eq('inj-3 删键后恢复 200', (await post(tk, batch([ev()]))).status, 200);
}

// ---------- 注入热开关（runtime_flag > env，带 TTL；2026-09-20）----------
{
  const put = (body: unknown) => admin('/api/admin/diagnostics/inject', { method: 'PUT', body: JSON.stringify(body) });
  const s500 = await put({ status: '500', ttl_min: 5, note: 'test' });
  eq('inj-4 后台设 500 → 响应形状', { ok: s500.json.ok, st: s500.json.injection.status, src: s500.json.injection.source, exp: typeof s500.json.injection.expires_at_ms }, { ok: true, st: '500', src: 'override', exp: 'number' });
  const r500 = await post(tk, batch([ev()]), { 'X-Request-Id': 'inj-rid-500' });
  eq('inj-5 注入 500 生效 + rid 回显 + 无 Retry-After', { status: r500.status, code: r500.json.error_code, rid: r500.json.request_id, ra: r500.headers.get('retry-after') }, { status: 500, code: 'acceptance_override', rid: 'inj-rid-500', ra: null });
  eq('inj-5b 无凭据请求也被注入（门 0 在凭据前）', (await post(null, batch([ev()]))).status, 500);
  process.env.DIAGLOG_ACCEPTANCE_OVERRIDE = '429';
  eq('inj-6 后台覆盖优先于 env', (await post(tk, batch([ev()]))).status, 500);
  delete process.env.DIAGLOG_ACCEPTANCE_OVERRIDE;
  const g = await admin('/api/admin/diagnostics/inject');
  eq('inj-7 GET inject 读回', { st: g.json.injection.status, by: typeof g.json.injection.set_by, sum: (await admin('/api/admin/diagnostics/summary')).json.config.injection_active }, { st: '500', by: 'string', sum: '500' });
  const s429 = await put({ status: '429', ttl_min: 5, retry_after_sec: 45 });
  const r429 = await post(tk, batch([ev()]));
  eq('inj-8 注入 429 自定义 Retry-After 45', { ok: s429.json.ok, status: r429.status, ra: r429.headers.get('retry-after'), ms: r429.json.retry_after_ms }, { ok: true, status: 429, ra: '45', ms: 45000 });
  eq('inj-9 非法 status 400', (await put({ status: '418' })).status, 400);
  eq('inj-9b 缺 status 400', (await put({ ttl_min: 5 })).status, 400);
  const cl = await put({ status: null });
  eq('inj-10 清除后恢复 200', { removed: cl.json.removed, status: (await post(tk, batch([ev()]))).status, after: cl.json.injection.status }, { removed: true, status: 200, after: null });
  configStore.setFlag(diag.INJECT_FLAG_KEY, JSON.stringify({ status: '403', expires_at_ms: Date.now() - 1000 }), 'test', '');
  eq('inj-11 过期覆盖忽略 → 200 且 summary 为 null', { status: (await post(tk, batch([ev()]))).status, sum: (await admin('/api/admin/diagnostics/summary')).json.config.injection_active }, { status: 200, sum: null });
  configStore.setFlag(diag.INJECT_FLAG_KEY, 'not-json', 'test', '');
  eq('inj-12 非法 JSON 覆盖忽略 → 200', (await post(tk, batch([ev()]))).status, 200);
  configStore.clearFlag(diag.INJECT_FLAG_KEY);
  const b = await admin(`/api/admin/diagnostics/batches?sn=${SN}&limit=5`);
  eq('adm-6 batches 列表含对账字段', { ok: b.json.ok, has: b.json.rows.length > 0, keys: ['request_id', 'accepted', 'duplicated', 'rejected', 'redacted', 'client_content_version', 'server_received_ms'].every((k) => k in (b.json.rows[0] ?? {})) }, { ok: true, has: true, keys: true });
  const rid = b.json.rows[0]?.request_id as string;
  const byRid = await admin(`/api/admin/diagnostics/batches?request_id=${encodeURIComponent(rid)}`);
  eq('adm-6b batches 按 request_id 过滤', { n: byRid.json.rows.length >= 1, all: byRid.json.rows.every((r: { request_id: string }) => r.request_id === rid) }, { n: true, all: true });
  eq('adm-6c batches 坏 SN 400', (await admin('/api/admin/diagnostics/batches?sn=nope')).status, 400);
}

// ---------- 注入作用域 + 一次性 + 401 三重锁（2026-09-20 401 演练准备）----------
{
  resetRateLimitForTests();
  const put = (body: unknown) => admin('/api/admin/diagnostics/inject', { method: 'PUT', body: JSON.stringify(body) });
  const getInj = async () => (await admin('/api/admin/diagnostics/inject')).json.injection;
  const suf = SN.slice(-8);
  // 401 三重锁（PUT 校验）
  eq('inj-13a 401 缺 scope/sn_suffix → 400 unsafe_401', { st: (await put({ status: '401' })).status, err: (await put({ status: '401' })).json.error }, { st: 400, err: 'unsafe_401' });
  eq('inj-13b 401 scope=endpoint → 400', (await put({ status: '401', scope: 'endpoint' })).status, 400);
  eq('inj-13c 401 allowlist 缺 sn_suffix → 400', (await put({ status: '401', scope: 'allowlist' })).status, 400);
  eq('inj-13d 401 once=false → 400', (await put({ status: '401', scope: 'allowlist', sn_suffix: suf, once: false })).status, 400);
  eq('inj-13e sn_suffix 7 位 → 400 bad_sn_suffix', (await put({ status: '500', scope: 'allowlist', sn_suffix: '1234567' })).json.error, 'bad_sn_suffix');
  eq('inj-13f sn_suffix 配 endpoint → 400', (await put({ status: '500', scope: 'endpoint', sn_suffix: suf })).json.error, 'sn_suffix_requires_allowlist_scope');
  eq('inj-13g 非法 scope → 400 bad_scope', (await put({ status: '500', scope: 'device' })).json.error, 'bad_scope');
  eq('inj-13h 三重锁未生效时 GET 为 null', (await getInj()).status, null);
  // allowlist 作用域：门 0 不再注入；名单外设备不受影响；sn_suffix 收窄
  process.env.DIAGLOG_SN_ALLOWLIST = SN;
  const s500 = await put({ status: '500', scope: 'allowlist', ttl_min: 5 });
  eq('inj-14 allowlist 作用域读回', { st: s500.json.injection.status, scope: s500.json.injection.scope, once: s500.json.injection.once, suf: s500.json.injection.sn_suffix }, { st: '500', scope: 'allowlist', once: false, suf: null });
  const bare = await post(null, batch([ev()]));
  eq('inj-14a 无凭据请求不再被注入（真实 401 unauthorized）', { status: bare.status, code: bare.json.error_code }, { status: 401, code: 'unauthorized' });
  const other = await post(tkOther, batch([ev()]));
  eq('inj-14b 名单外设备不被注入（403 device_not_allowed）', { status: other.status, code: other.json.error_code }, { status: 403, code: 'device_not_allowed' });
  const mine = await post(tk, batch([ev()]));
  eq('inj-14c 名单内设备被注入 500', { status: mine.status, code: mine.json.error_code }, { status: 500, code: 'acceptance_override' });
  await put({ status: '500', scope: 'allowlist', sn_suffix: SN_OTHER.slice(-8), ttl_min: 5 });
  eq('inj-14d sn_suffix 指向别台 → 名单内设备正常 200', (await post(tk, batch([ev()]))).status, 200);
  // once：命中一次即撤
  await put({ status: '429', scope: 'allowlist', sn_suffix: suf, once: true, ttl_min: 5 });
  const first = await post(tk, batch([ev()]));
  eq('inj-15 once 首命中 429 acceptance_override', { status: first.status, code: first.json.error_code }, { status: 429, code: 'acceptance_override' });
  eq('inj-15a once 命中后自动撤销（GET 为 null）', (await getInj()).status, null);
  eq('inj-15b once 第二次请求 200', (await post(tk, batch([ev()]))).status, 200);
  // 401 全链：三重锁合法设置 → 只有点名设备命中 → 与门 1 同形 → 一次即撤
  const s401 = await put({ status: '401', scope: 'allowlist', sn_suffix: suf, ttl_min: 5, note: 'drill' });
  eq('inj-16 401 合法设置读回（once 缺省即 true）', { ok: s401.json.ok, st: s401.json.injection.status, scope: s401.json.injection.scope, once: s401.json.injection.once, suf: s401.json.injection.sn_suffix }, { ok: true, st: '401', scope: 'allowlist', once: true, suf });
  const bare401 = await post(null, batch([ev()]));
  eq('inj-16a 无凭据 → 门 1 真实 401，不消耗 once', { status: bare401.status, code: bare401.json.error_code, still: (await getInj()).status }, { status: 401, code: 'unauthorized', still: '401' });
  const other401 = await post(tkOther, batch([ev()]));
  eq('inj-16b 名单外设备 → 403，不消耗 once', { status: other401.status, code: other401.json.error_code, still: (await getInj()).status }, { status: 403, code: 'device_not_allowed', still: '401' });
  const hit = await post(tk, batch([ev()]), { 'X-Request-Id': 'drill-401' });
  eq('inj-16c 点名设备命中：与门 1 真实 401 同形 + rid 回显 + 无 Retry-After', { status: hit.status, code: hit.json.error_code, msg: hit.json.message, rid: hit.json.request_id, ra: hit.headers.get('retry-after'), keys: Object.keys(hit.json).sort() }, { status: 401, code: 'unauthorized', msg: 'credential_missing_or_invalid', rid: 'drill-401', ra: null, keys: ['error_code', 'message', 'ok', 'request_id'] });
  eq('inj-16d 命中即撤销，下一请求 200', { after: (await getInj()).status, next: (await post(tk, batch([ev()]))).status }, { after: null, next: 200 });
  // 解析点强制三重锁：手工改库 / env 401 均忽略（到不了设备）
  configStore.setFlag(diag.INJECT_FLAG_KEY, JSON.stringify({ status: '401', expires_at_ms: Date.now() + 60_000 }), 'test', '');
  eq('inj-17 手工写入无锁 401 → 忽略（GET null + 200）', { g: (await getInj()).status, status: (await post(tk, batch([ev()]))).status }, { g: null, status: 200 });
  configStore.setFlag(diag.INJECT_FLAG_KEY, JSON.stringify({ status: '401', expires_at_ms: Date.now() + 60_000, scope: 'allowlist', sn_suffix: suf }), 'test', '');
  eq('inj-17a 手工写入缺 once 的 401 → 忽略（200）', (await post(tk, batch([ev()]))).status, 200);
  configStore.clearFlag(diag.INJECT_FLAG_KEY);
  process.env.DIAGLOG_ACCEPTANCE_OVERRIDE = '401';
  eq('inj-17b env 401 → 忽略（200）', { g: (await getInj()).status, status: (await post(tk, batch([ev()]))).status }, { g: null, status: 200 });
  delete process.env.DIAGLOG_ACCEPTANCE_OVERRIDE;
  eq('inj-18 inject401Locked 纯函数', [diag.inject401Locked({ status: '401', scope: 'allowlist', sn_suffix: suf, once: true }), diag.inject401Locked({ status: '401', scope: 'allowlist', sn_suffix: null, once: true }), diag.inject401Locked({ status: '429', scope: 'endpoint', sn_suffix: null, once: false })], [true, false, true]);
  process.env.DIAGLOG_SN_ALLOWLIST = '*';
}

// ---------- admin ----------
{
  const s = await admin('/api/admin/diagnostics/summary?hours=24');
  eq('adm-1 summary 形状', { ok: s.json.ok, hasEvents: s.json.summary.events_total > 0, key: s.json.switch.key, g: s.json.switch.global, mode: s.json.config.allowlist_mode, ret: s.json.config.retention_days, rpm: s.json.config.batch_rpm, devs: s.json.summary.devices.length >= 2 }, { ok: true, hasEvents: true, key: 'diagnostics.log_upload_enabled', g: true, mode: 'open', ret: 14, rpm: 30, devs: true });
  eq('adm-1b 拒绝原因统计含 event_not_allowed', s.json.summary.rejected_reasons.some((x: { reason: string }) => x.reason === 'event_not_allowed'), true);
  const e = await admin(`/api/admin/diagnostics/events?sn=${SN}&level=error&limit=10`);
  eq('adm-2 events 过滤 + data 已解析 + 无 data_json', { ok: e.json.ok, allMine: e.json.rows.every((r: any) => r.sn === SN && r.level === 'error'), parsed: typeof e.json.rows[0]?.data, noRaw: !('data_json' in (e.json.rows[0] ?? {})) }, { ok: true, allMine: true, parsed: 'object', noRaw: true });
  eq('adm-3 rejected 列表', (await admin(`/api/admin/diagnostics/rejected?sn=${SN}`)).json.rows.some((r: any) => r.reason === 'event_id_payload_conflict'), true);
  eq('adm-4 坏 SN 400', (await admin('/api/admin/diagnostics/events?sn=nope')).status, 400);
  eq('adm-5 坏 level 400', (await admin('/api/admin/diagnostics/events?level=loud')).status, 400);
}

console.log(`\ndiaglog tests: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
