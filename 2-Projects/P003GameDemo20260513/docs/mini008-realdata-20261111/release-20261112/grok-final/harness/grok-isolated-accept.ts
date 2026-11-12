/**
 * Grok isolated acceptance for mini008 dashboard ark/usage.
 * Synthetic tokens + temp DBs only. Never talks to production.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.env.GROK_SERVER_ROOT;
const OUT_DIR = process.env.GROK_OUT_DIR || process.cwd();
if (!ROOT) {
  console.error('GROK_SERVER_ROOT required');
  process.exit(2);
}

const tmp = mkdtempSync(join(tmpdir(), 'grok-mini008-'));
process.env.TELEMETRY_DB_PATH = join(tmp, 'telemetry.db');
process.env.DEVICES_DB_PATH = join(tmp, 'devices.db');
process.env.ACCOUNTS_DB_PATH = join(tmp, 'accounts.db');
process.env.PROFILE_DB_PATH = join(tmp, 'profile.db');
process.env.ARK_DB_PATH = join(tmp, 'ark.db');
process.env.CONFIG_DB_PATH = join(tmp, 'config.db');
process.env.AUTH_JWT_SECRET = 'grok-isolated-secret';
delete process.env.TELEMETRY_SN_ALLOWLIST;
delete process.env.TELEMETRY_ACCEPTANCE_OVERRIDE;

const SN_EMPTY = 'BJP00326991100000001';
const SN_USE = 'BJP00326991100000002';
const SN_NONE = 'BJP00326991100000003';
const SN_NOSNAP = 'BJP00326991100000004';
const SN_UNK = 'BJP00326991100000005';
const SN_GM = 'BJP00326991100000006';
const SN_OK = 'BJP00326991100000007';
const SN_EPOCH = 'BJP00326991100000008';
const SN_B = 'BJP00326991100000009';
const ALL_A = [SN_EMPTY, SN_USE, SN_NONE, SN_NOSNAP, SN_UNK, SN_GM, SN_OK, SN_EPOCH];
process.env.ARK_CONTEXT_SN_ALLOW = [SN_NOSNAP, SN_UNK, SN_GM, SN_OK, SN_EPOCH].join(',');

const results: Array<{ id: string; ok: boolean; detail: unknown }> = [];
function check(id: string, ok: boolean, detail?: unknown): void {
  results.push({ id, ok, detail: detail ?? null });
  if (!ok) console.error(`FAIL ${id} ${JSON.stringify(detail)}`);
  else console.log(`PASS ${id}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function shanghaiDay(ms: number): string {
  return new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
}
function dateAdd(day: string, delta: number): string {
  return new Date(Date.parse(`${day}T00:00:00+08:00`) + delta * 86400_000 + 8 * 3600_000)
    .toISOString()
    .slice(0, 10);
}

function leak(body: unknown, sn: string): boolean {
  const s = JSON.stringify(body);
  return s.includes(sn) || s.includes('1400');
}

function arkProgress() {
  return {
    timer_state: 'unknown',
    next_reward: {
      status: 'unknown',
      kind: 'unknown',
      item_id: null,
      stage_id: null,
      remaining_seconds: null,
    },
    claimable_count: null,
  };
}

function arkSnap(patch: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    schema_version: 1,
    snapshot_id: 'grok-' + Math.random().toString(16).slice(2),
    boot_id: 'boot-grok-1',
    boot_started_at_ms: now - 60_000,
    sequence: 1,
    captured_at_ms: now,
    logical_day: shanghaiDay(now),
    config_revision: 'grok-rule-1',
    content_version: 'grok-content-1',
    source_mode: 'normal',
    wallets: { family_coin: 0, stardust: null },
    inventory: { 'M-CARD-001': 2 },
    progress: arkProgress(),
    ...patch,
  };
}

function arkEmpty(a: any, reason: string): boolean {
  if (!a || a.available !== false || a.reason !== reason || a.snapshot_id != null || a.source_mode != null) return false;
  const coins = a.wallets == null ? null : a.wallets.family_coin;
  const dust = a.wallets == null ? null : a.wallets.stardust;
  const card = a.inventory == null ? null : a.inventory['M-CARD-001'];
  if (coins != null || dust != null || card != null) return false;
  const s = JSON.stringify(a);
  return !s.includes('1400') && !/family_coin":[1-9]/.test(s);
}

const src = (rel: string) => pathToFileURL(join(ROOT, rel)).href;

async function main(): Promise<void> {
const { Hono } = await import('hono');
const { SignJWT } = await import('jose');
const { deviceTelemetryRoute, parentTelemetryRoute } = await import(src('src/routes/telemetry.ts'));
const { deviceRegistryStore } = await import(src('src/device-registry-store.ts'));
const { snapshotSchema } = await import(src('src/ark/contracts.ts'));
const { arkStore } = await import(src('src/ark/service.ts'));
const { accountStore } = await import(src('src/account-store.ts'));

const app = new Hono();
app.route('/v1/device/telemetry', deviceTelemetryRoute);
app.route('/v1/parent/devices', parentTelemetryRoute);

const secret = new TextEncoder().encode('grok-isolated-secret');
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
    .setIssuer('p003')
    .setAudience('kidshub')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(secret);
}

for (const sn of [...ALL_A, SN_B]) deviceRegistryStore.add(sn, 'grok-isolated');
for (const sn of ALL_A) {
  deviceRegistryStore.setParentAccountId(sn, 'acct-a');
  deviceRegistryStore.setAccountId(sn, accountStore.createDeviceAccount(sn, 'grok-isolated').id);
}
deviceRegistryStore.setParentAccountId(SN_B, 'acct-b');
deviceRegistryStore.setAccountId(SN_B, accountStore.createDeviceAccount(SN_B, 'grok-isolated-b').id);

const pubs: Record<string, string> = {};
for (const sn of [...ALL_A, SN_B]) pubs[sn] = deviceRegistryStore.get(sn)!.public_id!;

const tokA = await parentJwt('acct-a');
const tokB = await parentJwt('acct-b');
const now = Date.now();
const today = shanghaiDay(now);

function mkBatch(extra: Record<string, unknown>): Record<string, unknown> {
  return { schema_version: 1, batch_id: 'grok-' + Math.random().toString(16).slice(2), device_ts_ms: Date.now(), ...extra };
}
function snap(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    snapshot_id: id,
    captured_at_ms: Date.now(),
    lid_open: true,
    present: true,
    focus_active: true,
    brightness_level: 2,
    color_mode: 'warm',
    image_distance_m: 2,
    image_distance_state: 'valid',
    ...extra,
  };
}
function seg(id: string, start: number, end: number) {
  return { event_id: id, type: 'focus_segment', occurred_at_ms: end, data: { start_ms: start, end_ms: end } };
}

async function postTel(sn: string, body: unknown) {
  const res = await app.request('/v1/device/telemetry', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (await deviceJwt(sn)) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
async function dash(pub: string, token: string, tz = 'Asia/Shanghai') {
  const res = await app.request(`/v1/parent/devices/${pub}/dashboard?timezone=${tz}`, {
    headers: { authorization: 'Bearer ' + token },
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

function seedArk(sn: string, patch: Record<string, unknown> | null, authorize = true) {
  const identity = deviceRegistryStore.arkIdentity(sn);
  if (!identity) throw new Error('no identity ' + sn);
  const store = arkStore();
  if (authorize) store.authorize(identity, Date.now() - 5_000);
  if (patch) {
    const parsed = snapshotSchema.parse(arkSnap(patch));
    return store.accept(identity, parsed, Date.now());
  }
  return null;
}

// ---------- dashboard compatibility / isolation ----------
{
  const r = await dash(pubs[SN_EMPTY], tokA);
  check('DASH-OLD', r.status === 200 && r.json?.data?.device && r.json?.data?.today && r.json?.data?.week && r.json?.data?.availability?.night_reward === false && r.json?.data?.availability?.percentile === false, { status: r.status, keys: r.json?.data ? Object.keys(r.json.data) : null });
  check('CONTRACT-ARK', r.json?.data?.ark != null, { has_ark: r.json?.data?.ark != null });
  check('CONTRACT-USAGE', r.json?.data?.usage != null, { has_usage: r.json?.data?.usage != null });
  const u = r.json?.data?.usage;
  const daily = u?.daily;
  const emptyDays = Array.isArray(daily) && daily.length === 7 && daily.every((d: any) => d.available === false && d.focus_minutes === null && d.updated_at_ms === null);
  check('USE-EMPTY', u?.source === 'telemetry.focus_segment' && u?.timezone === 'Asia/Shanghai' && u?.today?.available === false && u?.today?.focus_minutes === null && u?.today?.date === today && emptyDays && u?.today?.date === daily?.[6]?.date, { usage: u, today_old: r.json?.data?.today });
  check('USE-OLD-ZERO', r.json?.data?.today?.focus_minutes === 0, r.json?.data?.today);
  const tz = await dash(pubs[SN_EMPTY], tokA, 'America/New_York');
  check('DASH-TZ', tz.status === 400 && tz.json?.error === 'invalid_timezone', { status: tz.status, error: tz.json?.error });
  const b = await dash(pubs[SN_EMPTY], tokB);
  check('PARENT-B-404', b.status === 404 && b.json?.error === 'not_found' && !leak(b.json, SN_EMPTY) && b.json?.data?.ark == null, { status: b.status, json: b.json });
}

// ---------- snapshot / presence are not usage ----------
{
  const p = await postTel(SN_USE, mkBatch({ snapshot: snap('sep-1') }));
  check('TEL-SEP-1-ACK', p.status === 200 && p.json?.data?.snapshot?.accepted === true, p.json);
  const r = await dash(pubs[SN_USE], tokA);
  check('TEL-SEP-1', r.json?.data?.device?.present === true && r.json?.data?.device?.lid_open === true && r.json?.data?.usage?.today?.available === false && r.json?.data?.usage?.today?.focus_minutes === null, { device: r.json?.data?.device, usage: r.json?.data?.usage?.today });
  const ev = await postTel(SN_USE, mkBatch({ events: [{ event_id: 'pres-1', type: 'presence_transition', occurred_at_ms: Date.now(), data: { from: 'absent', to: 'present' } }] }));
  check('TEL-SEP-2-ACK', ev.status === 200 && Array.isArray(ev.json?.data?.acked_event_ids) && ev.json.data.acked_event_ids.includes('pres-1') && ev.json?.data?.snapshot === null, ev.json?.data);
  const r2 = await dash(pubs[SN_USE], tokA);
  check('TEL-SEP-2', r2.json?.data?.usage?.today?.available === false && r2.json?.data?.usage?.today?.focus_minutes === null, r2.json?.data?.usage?.today);
  const pr = await postTel(SN_USE, mkBatch({ events: [{ event_id: 'posture-1', type: 'posture_round', occurred_at_ms: Date.now(), data: { result: 'correct' } }] }));
  check('USE-POSTURE-ACK', pr.status === 200, pr.json?.data);
  const r3 = await dash(pubs[SN_USE], tokA);
  check('USE-POSTURE', r3.json?.data?.usage?.today?.available === false && r3.json?.data?.usage?.today?.focus_minutes === null && r3.json?.data?.today?.focus_minutes === 0, { usage: r3.json?.data?.usage?.today, today: r3.json?.data?.today });
}

// ---------- ACK, short zero, 7 days, duplicate first-receive, conflict ----------
const start20 = Date.parse(`${today}T12:00:00+08:00`);
const seg20 = seg('focus-short-20', start20, start20 + 20_000);
{
  const r = await postTel(SN_USE, mkBatch({ events: [seg20] }));
  check('TEL-ACK-1', r.status === 200 && r.json?.data?.snapshot === null && r.json?.data?.acked_event_ids?.[0] === 'focus-short-20', r.json?.data);
  const firstRecv = r.json?.data?.server_received_ms;
  const d = await dash(pubs[SN_USE], tokA);
  const u = d.json?.data?.usage;
  check('USE-SHORT0', u?.today?.available === true && u?.today?.focus_minutes === 0 && typeof u?.today?.updated_at_ms === 'number', u?.today);
  check('USE-7DAYS', Array.isArray(u?.daily) && u.daily.length === 7 && u.daily.slice(0, 6).every((x: any) => x.available === false && x.focus_minutes === null) && u.daily[6]?.available === true && u.daily[6]?.focus_minutes === 0, u?.daily);
  check('USE-DUP-TIME-FIRST', u?.today?.updated_at_ms === firstRecv, { updated: u?.today?.updated_at_ms, firstRecv });
  await sleep(40);
  const dup = await postTel(SN_USE, mkBatch({ events: [seg20] }));
  check('TEL-IDEM-1', dup.status === 200 && dup.json?.data?.duplicated_event_ids?.[0] === 'focus-short-20', dup.json?.data);
  const d2 = await dash(pubs[SN_USE], tokA);
  check('USE-DUP-TIME', d2.json?.data?.usage?.today?.updated_at_ms === firstRecv && d2.json?.data?.usage?.today?.focus_minutes === 0, { updated: d2.json?.data?.usage?.today?.updated_at_ms, firstRecv, dupRecv: dup.json?.data?.server_received_ms });
  const bad = await postTel(SN_USE, mkBatch({ events: [{ ...seg20, data: { start_ms: start20, end_ms: start20 + 90_000 } }] }));
  check('TEL-IDEM-2', bad.status === 200 && bad.json?.data?.rejected?.[0]?.event_id === 'focus-short-20' && bad.json?.data?.rejected?.[0]?.reason === 'event_id_payload_conflict', bad.json?.data?.rejected);
  const d3 = await dash(pubs[SN_USE], tokA);
  check('USE-CONFLICT', d3.json?.data?.usage?.today?.focus_minutes === 0 && d3.json?.data?.usage?.today?.updated_at_ms === firstRecv, d3.json?.data?.usage?.today);
  const beforeDev = d3.json?.data?.device?.updated_at_ms;
  const combo = await postTel(SN_USE, mkBatch({ snapshot: snap('combo-1'), events: [seg('focus-combo', start20 + 3_600_000, start20 + 3_660_000)] }));
  check('TEL-ACK-2', combo.status === 200 && combo.json?.data?.snapshot?.accepted === true && combo.json?.data?.acked_event_ids?.includes('focus-combo'), combo.json?.data);
  const afterCombo = await dash(pubs[SN_USE], tokA);
  const usageAfterCombo = afterCombo.json?.data?.usage?.today?.updated_at_ms;
  const deviceAfterCombo = afterCombo.json?.data?.device?.updated_at_ms;
  const snap2 = await postTel(SN_USE, mkBatch({ snapshot: snap('sep-3') }));
  check('TEL-SEP-3-SNAP', snap2.status === 200 && snap2.json?.data?.snapshot?.accepted === true, snap2.json?.data?.snapshot);
  const d4 = await dash(pubs[SN_USE], tokA);
  check('TEL-SEP-3', d4.json?.data?.usage?.today?.updated_at_ms === usageAfterCombo && d4.json?.data?.device?.updated_at_ms !== deviceAfterCombo && d4.json?.data?.device?.updated_at_ms != null, { usage: d4.json?.data?.usage?.today?.updated_at_ms, usageAfterCombo, device: d4.json?.data?.device?.updated_at_ms, deviceAfterCombo });
}

// ---------- illegal times ----------
{
  const illegal = [
    seg('bad-end', start20 + 1000, start20),
    { event_id: 'bad-missing', type: 'focus_segment', occurred_at_ms: Date.now(), data: { end_ms: start20 + 1000 } },
    { event_id: 'bad-nan', type: 'focus_segment', occurred_at_ms: Date.now(), data: { start_ms: 'x', end_ms: start20 } },
  ];
  const r = await postTel(SN_EMPTY, mkBatch({ events: illegal }));
  check('USE-ILLEGAL-HTTP', r.status === 200, r.json?.data);
  const d = await dash(pubs[SN_EMPTY], tokA);
  check('USE-ILLEGAL', d.json?.data?.usage?.today?.available === false && d.json?.data?.usage?.today?.focus_minutes === null, d.json?.data?.usage?.today);
}

// ---------- cross-day ----------
{
  const midnight = Date.parse(`${today}T00:00:00+08:00`);
  const cross = seg('focus-cross', midnight - 600_000, midnight + 600_000);
  const r = await postTel(SN_EMPTY, mkBatch({ events: [cross] }));
  check('USE-CROSS-ACK', r.status === 200 && r.json?.data?.acked_event_ids?.[0] === 'focus-cross', r.json?.data);
  const recv = r.json?.data?.server_received_ms;
  const d = await dash(pubs[SN_EMPTY], tokA);
  const y = dateAdd(today, -1);
  const yd = d.json?.data?.usage?.daily?.find((x: any) => x.date === y);
  const td = d.json?.data?.usage?.today;
  check('USE-CROSS', yd?.available === true && yd?.focus_minutes === 10 && td?.available === true && td?.focus_minutes === 10 && yd?.updated_at_ms === recv && td?.updated_at_ms === recv, { yesterday: yd, today: td, recv });
}

try {
// ---------- Ark ----------
{
  const none = await dash(pubs[SN_NONE], tokA);
  const a0 = none.json?.data?.ark;
  check('ARK-NONE', none.status === 200 && arkEmpty(a0, 'not_enabled'), a0);

  seedArk(SN_NOSNAP, null, true);
  const ns = await dash(pubs[SN_NOSNAP], tokA);
  check('ARK-NOSNAP', arkEmpty(ns.json?.data?.ark, 'no_snapshot'), ns.json?.data?.ark);

  seedArk(SN_UNK, { source_mode: 'unknown', wallets: { family_coin: null, stardust: null }, inventory: { 'M-CARD-001': null } }, true);
  const uk = await dash(pubs[SN_UNK], tokA);
  const s = JSON.stringify(uk.json?.data?.ark ?? {});
  check('ARK-UNKNOWN', arkEmpty(uk.json?.data?.ark, 'non_normal') && !s.includes('"family_coin":0'), uk.json?.data?.ark);

  seedArk(SN_GM, { source_mode: 'gm', wallets: { family_coin: 1400, stardust: 0 }, inventory: { 'M-CARD-001': 1 } }, true);
  const gm = await dash(pubs[SN_GM], tokA);
  check('ARK-GM', arkEmpty(gm.json?.data?.ark, 'non_normal') && !JSON.stringify(gm.json).includes('1400'), gm.json?.data?.ark);

  seedArk(SN_OK, { source_mode: 'normal', wallets: { family_coin: 0, stardust: null }, inventory: { 'M-CARD-001': 2 } }, true);
  const ok = await dash(pubs[SN_OK], tokA);
  const aok = ok.json?.data?.ark;
  check('ARK-NORMAL', ok.status === 200 && aok?.available === true && aok?.reason == null && aok?.source_mode === 'normal' && aok?.wallets?.family_coin === 0 && aok?.wallets?.stardust === null && aok?.inventory?.['M-CARD-001'] === 2 && typeof aok?.captured_at_ms === 'number' && typeof aok?.received_at_ms === 'number', aok);

  seedArk(SN_EPOCH, { source_mode: 'normal', wallets: { family_coin: 7, stardust: 1 }, inventory: { 'M-CARD-001': 3 } }, true);
  const before = await dash(pubs[SN_EPOCH], tokA);
  check('ARK-EPOCH-BEFORE', before.json?.data?.ark?.available === true && before.json?.data?.ark?.wallets?.family_coin === 7, before.json?.data?.ark);
  deviceRegistryStore.setAccountId(SN_EPOCH, 'brain-epoch-new');
  const after = await dash(pubs[SN_EPOCH], tokA);
  check('ARK-EPOCH', after.status === 200 && arkEmpty(after.json?.data?.ark, 'identity_mismatch') && !JSON.stringify(after.json?.data?.ark ?? {}).includes('7'), { status: after.status, ark: after.json?.data?.ark, parent: after.json?.data?.device });

  const iso = await dash(pubs[SN_OK], tokB);
  check('ARK-ISOLATION', iso.status === 404 && iso.json?.error === 'not_found' && iso.json?.data?.ark == null && !JSON.stringify(iso.json).includes('family_coin') && !leak(iso.json, SN_OK), iso.json);
}

} catch (err) {
  check('ARK-HARNESS', false, String(err));
  console.error(err);
}

const pass = results.filter((x) => x.ok).length;
const fail = results.filter((x) => !x.ok).length;
const incomplete = results.some((x) => ['CONTRACT-ARK', 'CONTRACT-USAGE'].includes(x.id) && !x.ok);
const report = {
  runner: 'grok-isolated-accept.ts',
  tmp,
  today,
  pass,
  fail,
  incomplete,
  verdict: fail === 0 ? 'PASS' : incomplete ? 'CANDIDATE_INCOMPLETE' : 'FAIL',
  results,
};
writeFileSync(join(OUT_DIR, 'GROK-ISOLATED.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ verdict: report.verdict, pass, fail, incomplete, out: join(OUT_DIR, 'GROK-ISOLATED.json') }));
if (fail > 0) process.exit(1);

}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
