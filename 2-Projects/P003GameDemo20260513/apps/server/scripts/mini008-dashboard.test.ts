/** Synthetic loopback HTTP + real SQLite. No production credentials, services or data. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const root = mkdtempSync(join(tmpdir(), 'mini008-http-'));
process.chdir(root); // Isolate default paths in transitive stores as well.
for (const key of ['TELEMETRY','DEVICES','ACCOUNTS','PROFILE','ARK','CONFIG','PAIRING','BLE_BINDINGS']) process.env[`${key}_DB_PATH`] = join(root, `${key.toLowerCase()}.db`);
process.env.AUTH_JWT_SECRET = 'isolated-mini008-test-only';
process.env.ARK_CONTEXT_SN_ALLOW = '';
delete process.env.TELEMETRY_SN_ALLOWLIST;
delete process.env.TELEMETRY_ACCEPTANCE_OVERRIDE;
const { Hono } = await import('hono');
const { serve } = await import('@hono/node-server');
const { SignJWT } = await import('jose');
const { deviceTelemetryRoute, parentTelemetryRoute } = await import('../src/routes/telemetry.js');
const { arkRoute } = await import('../src/routes/ark.js');
const { deviceRegistryStore: registry } = await import('../src/device-registry-store.js');
const { accountStore } = await import('../src/account-store.js');
const { arkStore } = await import('../src/ark/service.js');
const { dayOf } = await import('../src/telemetry-store.js');
const app = new Hono();
app.route('/v1/device/telemetry', deviceTelemetryRoute);
app.route('/v1/device/ark', arkRoute);
app.route('/v1/parent/devices', parentTelemetryRoute);
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
await new Promise<void>(resolve => server.listening ? resolve() : server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const tel = new DatabaseSync(process.env.TELEMETRY_DB_PATH!);
const accounts = new DatabaseSync(process.env.ACCOUNTS_DB_PATH!);
console.log(`ISOLATED_EVIDENCE_DIR=${root}`);
after(async () => { tel.close(); accounts.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
let serial = 0;
async function jwt(payload: Record<string, unknown>, parent = false) {
 let j = new SignJWT(payload).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('1h');
 if (parent) j = j.setIssuer('p003').setAudience('kidshub');
 return j.sign(new TextEncoder().encode(process.env.AUTH_JWT_SECRET));
}
async function fixture() {
 const sn = `BJP003260601${String(++serial).padStart(8, '0')}`, owner = `mini008-parent-${serial}`;
 registry.add(sn, 'synthetic'); registry.setParentAccountId(sn, owner);
 registry.setAccountId(sn, accountStore.createDeviceAccount(sn, 'synthetic').id);
 process.env.ARK_CONTEXT_SN_ALLOW += `,${sn}`;
 return { sn, owner, pub: registry.get(sn)!.public_id!, token: await jwt({ kind: 'p003-device', sub: sn }), parent: await jwt({ accountId: owner, role: 'parent' }, true) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function request(path: string, token: string, body?: unknown) {
 const r = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
 return { status: r.status, body: await r.json() as any };
}
const dash = (f: Fixture, token = f.parent) => request(`/v1/parent/devices/${f.pub}/dashboard?timezone=Asia/Shanghai`, token);
const batch = (f: Fixture, events: any[], snapshot?: any) => request('/v1/device/telemetry', f.token, { schema_version: 1, batch_id: `batch-${++serial}`, device_ts_ms: Date.now(), events, ...(snapshot ? { snapshot } : {}) });
const segment = (id: string, start: number, end: number) => ({ event_id: id, type: 'focus_segment', occurred_at_ms: end, data: { start_ms: start, end_ms: end } });
function snapshot(patch: any = {}) {
 const now = Date.now();
 return { schema_version: 1, snapshot_id: 'ark-1', boot_id: 'test-boot', boot_started_at_ms: now - 60000, sequence: 1, captured_at_ms: now, logical_day: dayOf(now), config_revision: 'test-rules', content_version: 'test-content', source_mode: 'normal', wallets: { family_coin: 120, stardust: 0 }, inventory: { 'M-CARD-001': 2 }, progress: { timer_state: 'unknown', next_reward: { status: 'unknown', kind: 'unknown', item_id: null, stage_id: null, remaining_seconds: null }, claimable_count: null }, ...patch };
}
function authorize(f: Fixture) { arkStore().authorize(registry.arkIdentity(f.sn)!, Date.now() - 1000); }
const upload = (f: Fixture, s: any) => request('/v1/device/ark/state', f.token, s);
function emptyArk(a: any, reason?: string) {
 assert.equal(a.available, false); if (reason) assert.equal(a.reason, reason);
 assert.deepEqual(a.wallets, { family_coin: null, stardust: null }); assert.deepEqual(a.inventory, { 'M-CARD-001': null });
 for (const k of ['source_mode', 'snapshot_id', 'captured_at_ms', 'received_at_ms']) assert.equal(a[k], null);
}
function noUsage(u: any) {
 assert.equal(u.source, 'telemetry.focus_segment'); assert.equal(u.timezone, 'Asia/Shanghai');
 assert.equal(u.daily.length, 7); assert.deepEqual(u.today, u.daily[6]);
 for (const d of u.daily) { assert.equal(d.available, false); assert.equal(d.focus_minutes, null); assert.equal(d.updated_at_ms, null); }
}
test('no focus: posture/presence/snapshot preserve old fields but never invent usage zero', async () => {
 const f = await fixture(), now = Date.now();
 const r = await batch(f, [{ event_id: 'posture', type: 'posture_round', occurred_at_ms: now, data: { result: 'correct' } }, { event_id: 'presence', type: 'presence_transition', occurred_at_ms: now, data: { present: true } }], { snapshot_id: 'state', captured_at_ms: now, present: true, brightness_level: 2 });
 assert.equal(r.status, 200); assert.equal(r.body.data.snapshot.accepted, true);
 const d = (await dash(f)).body.data;
 assert.deepEqual(d.today, { focus_minutes: 0, guarded_minutes: 0, posture_alert_count: null });
 assert.equal(d.week.daily.length, 7); assert.equal(d.device.present, true); assert.equal(d.device.brightness_level, 2);
 assert.equal(d.device.updated_at_ms, r.body.data.server_received_ms); assert.deepEqual(d.availability, { night_reward: false, percentile: false });
 noUsage(d.usage); emptyArk(d.ark, 'not_enabled');
});
test('HTTP focus ACK -> SQLite -> dashboard; replay/conflict never recount or renew', async () => {
 const f = await fixture(), end = Date.now() - 1000, ev = segment('focus-one', end - 60000, end);
 const r = await batch(f, [ev]); assert.equal(r.status, 200); assert.equal(r.body.data.snapshot, null); assert.deepEqual(r.body.data.acked_event_ids, ['focus-one']);
 const row = tel.prepare('SELECT * FROM device_telemetry_event WHERE sn=?').get(f.sn)!;
 assert.equal(row.server_received_ms, r.body.data.server_received_ms);
 assert.equal(tel.prepare('SELECT focus_ms FROM device_telemetry_daily WHERE sn=?').get(f.sn)!.focus_ms, 60000);
 const d = (await dash(f)).body.data; assert.equal(d.usage.today.focus_minutes, 1); assert.equal(d.usage.today.available, true);
 assert.equal(d.usage.today.updated_at_ms, row.server_received_ms); assert.equal(d.device.updated_at_ms, null);
 await new Promise(resolve => setTimeout(resolve, 15));
 const replay = await batch(f, [ev]); assert.deepEqual(replay.body.data.duplicated_event_ids, ['focus-one']); assert.deepEqual((await dash(f)).body.data.usage, d.usage);
 const conflict = await batch(f, [{ ...ev, data: { ...ev.data, end_ms: end + 1 } }, segment('focus-next', end, end + 1000)]);
 assert.deepEqual(conflict.body.data.rejected, [{ event_id: 'focus-one', reason: 'event_id_payload_conflict' }]); assert.deepEqual(conflict.body.data.acked_event_ids, ['focus-next']);
 assert.equal(tel.prepare('SELECT focus_ms FROM device_telemetry_daily WHERE sn=?').get(f.sn)!.focus_ms, 61000);
});
test('late cross-CST-midnight splits milliseconds; short round0 available; heartbeat cannot renew usage', async () => {
 const f = await fixture(), midnight = Date.parse(`${dayOf(Date.now())}T00:00:00+08:00`);
 const r = await batch(f, [segment('cross-day', midnight - 20000, midnight + 20000)]); assert.equal(r.status, 200);
 assert.deepEqual(tel.prepare('SELECT focus_ms FROM device_telemetry_daily WHERE sn=? ORDER BY date').all(f.sn).map(x => x.focus_ms), [20000, 20000]);
 const d = (await dash(f)).body.data;
 for (const p of d.usage.daily.slice(-2)) { assert.equal(p.available, true); assert.equal(p.focus_minutes, 0); assert.equal(p.updated_at_ms, r.body.data.server_received_ms); }
 assert.ok(d.usage.daily.slice(0, 5).every((x: any) => x.focus_minutes === null));
 await batch(f, [], { snapshot_id: 'later-state', captured_at_ms: Date.now(), present: true }); assert.deepEqual((await dash(f)).body.data.usage, d.usage);
});
test('invalid focus shape/time individually rejected while unrelated events remain accepted', async () => {
 const f = await fixture(), now = Date.now();
 const invalid = [{}, { start_ms: '1', end_ms: 2 }, { start_ms: null, end_ms: 2 }, { start_ms: -1, end_ms: 2 }, { start_ms: 1.5, end_ms: 2 }, { start_ms: 2, end_ms: 2 }, { start_ms: 3, end_ms: 2 }, { start_ms: 0, end_ms: 86400001 }, { start_ms: now, end_ms: Number.MAX_SAFE_INTEGER }];
 const r = await batch(f, [...invalid.map((data, i) => ({ event_id: `bad-${i}`, type: 'focus_segment', occurred_at_ms: now, data })), { event_id: 'old-presence', type: 'presence_transition', occurred_at_ms: now, data: { original_extra: 'kept' } }]);
 assert.equal(r.status, 200); assert.deepEqual(r.body.data.acked_event_ids, ['old-presence']); assert.equal(r.body.data.rejected.length, invalid.length);
 assert.ok(r.body.data.rejected.every((x: any) => x.reason === 'invalid_event_data')); assert.equal(tel.prepare('SELECT COUNT(*) AS n FROM device_telemetry_event WHERE sn=? AND type=?').get(f.sn, 'focus_segment')!.n, 0); noUsage((await dash(f)).body.data.usage);
});
test('different-ID overlap rejected; adjacent and out-of-order disjoint segments count', async () => {
 const f = await fixture(), t = Date.now() - 120000;
 const r = await batch(f, [segment('first', t, t + 60000), segment('overlap', t + 30000, t + 90000), segment('adjacent', t + 60000, t + 120000), segment('earlier', t - 60000, t)]);
 assert.deepEqual(r.body.data.acked_event_ids, ['first', 'adjacent', 'earlier']); assert.deepEqual(r.body.data.rejected, [{ event_id: 'overlap', reason: 'focus_segment_overlap' }]);
 assert.equal((await dash(f)).body.data.usage.today.focus_minutes, 3); assert.equal(tel.prepare('SELECT focus_ms FROM device_telemetry_daily WHERE sn=?').get(f.sn)!.focus_ms, 180000);
});
test('legacy malformed/overlapping raw focus and old daily numbers cannot inflate usage', async () => {
 const f = await fixture(), t = Date.now() - 120000;
 const put = tel.prepare('INSERT INTO device_telemetry_event VALUES(?,?,?,?,?,?,?,?,?,?)');
 for (const [id, data, received] of [['legacy-string', { start_ms: String(t), end_ms: t + 60000 }, 1], ['legacy-valid', { start_ms: t, end_ms: t + 60000 }, 2], ['legacy-overlap', { start_ms: t + 30000, end_ms: t + 90000 }, 3]] as const) put.run(f.sn, id, 'focus_segment', t + 90000, JSON.stringify(data), id, 1, received, 0, '');
 tel.prepare('INSERT INTO device_telemetry_daily(sn,date,focus_ms) VALUES(?,?,?)').run(f.sn, dayOf(t), 180000);
 const u = (await dash(f)).body.data.usage; assert.equal(u.today.focus_minutes, 1); assert.equal(u.today.updated_at_ms, 2);
});
test('normal Ark HTTP/ACK/SQLite metadata, partial/null/0; duplicate preserves first receive', async () => {
 const f = await fixture(); authorize(f); const s = snapshot({ wallets: { family_coin: 0, stardust: null }, inventory: { 'M-CARD-001': null } });
 const r = await upload(f, s); assert.equal(r.status, 200); assert.equal(r.body.status, 'accepted');
 assert.equal(JSON.parse(String(arkStore().db.prepare('SELECT body FROM ark_current WHERE sn=?').get(f.sn)!.body)).snapshot_id, s.snapshot_id);
 const a = (await dash(f)).body.data.ark;
 assert.deepEqual(a, { available: true, reason: null, source_mode: 'normal', snapshot_id: s.snapshot_id, captured_at_ms: s.captured_at_ms, received_at_ms: r.body.received_at_ms, wallets: s.wallets, inventory: s.inventory, reported_state: {source:'device.ark.state',source_mode:s.source_mode,snapshot_id:s.snapshot_id,logical_day:s.logical_day,captured_at_ms:s.captured_at_ms,received_at_ms:r.body.received_at_ms,wallets:s.wallets,inventory:s.inventory,progress:s.progress} });
 await new Promise(resolve => setTimeout(resolve, 15));
 const replay = await upload(f, s); assert.equal(replay.body.status, 'duplicate'); assert.equal(replay.body.received_at_ms, r.body.received_at_ms); assert.deepEqual((await dash(f)).body.data.ark, a);
 const s2 = { ...s, sequence: 2, snapshot_id: 'ark-2', wallets: { family_coin: null, stardust: null } }; assert.equal((await upload(f, s2)).body.status, 'accepted');
 const n = (await dash(f)).body.data.ark; assert.equal(n.available, true); assert.deepEqual(n.wallets, s2.wallets);
});
test('GM/unknown snapshot replaces reported facts without becoming normal assets after normal', async () => {
 for (const mode of ['gm', 'unknown']) { const f = await fixture(); authorize(f); const s = snapshot(); assert.equal((await upload(f, s)).body.status, 'accepted');const next={...s,snapshot_id:mode,sequence:2,source_mode:mode,logical_day:'2026-11-01',wallets:{family_coin:42,stardust:0},progress:{timer_state:'paused',next_reward:{status:'day_complete',kind:'unknown',item_id:null,stage_id:null,remaining_seconds:null},claimable_count:0}}; assert.equal((await upload(f,next)).body.status, 'accepted');const a=(await dash(f)).body.data.ark;emptyArk(a,'non_normal');assert.equal(a.reported_state.snapshot_id,mode);assert.equal(a.reported_state.source_mode,mode);assert.equal(a.reported_state.logical_day,'2026-11-01');assert.deepEqual(a.reported_state.wallets,next.wallets);assert.deepEqual(a.reported_state.progress,next.progress); }
});
test('two owners get reciprocal 404; ownership change cannot expose previous-epoch assets', async () => {
 const a = await fixture(), b = await fixture(); authorize(a); assert.equal((await upload(a, snapshot())).body.status, 'accepted');
 assert.equal((await dash(a, b.parent)).status, 404); assert.equal((await dash(b, a.parent)).status, 404);
 registry.setParentAccountId(a.sn, b.owner); assert.equal((await dash(a)).status, 404); emptyArk((await dash(a, b.parent)).body.data.ark, 'identity_mismatch');
});
test('disabled/epoch/account-role/grant/scope/master invalidation hides Ark assets', async () => {
 for (const change of ['disabled', 'epoch', 'account', 'grant', 'scope', 'master']) {
  const f = await fixture(); authorize(f); assert.equal((await upload(f, snapshot())).body.status, 'accepted');
  if (change === 'disabled') registry.setStatus(f.sn, 'disabled');
  if (change === 'epoch') { registry.setParentAccountId(f.sn, 'other'); registry.setParentAccountId(f.sn, f.owner); }
  if (change === 'account') accounts.prepare("UPDATE account SET role='parent' WHERE id=?").run(registry.get(f.sn)!.account_id!);
  if (change === 'grant') arkStore().db.prepare("UPDATE ark_grant SET grant_id='replaced' WHERE sn=?").run(f.sn);
  if (change === 'scope') process.env.ARK_CONTEXT_SN_ALLOW = process.env.ARK_CONTEXT_SN_ALLOW!.replace(f.sn, '');
  if (change === 'master') arkStore().db.exec('UPDATE ark_settings SET enabled=0');
  const d = await dash(f); assert.equal(d.status, 200); emptyArk(d.body.data.ark);
 }
});
test('authorized but missing snapshot stays empty; another device cannot fill it', async () => {
 const a = await fixture(), b = await fixture(); authorize(a); authorize(b); assert.equal((await upload(b, snapshot())).body.status, 'accepted'); emptyArk((await dash(a)).body.data.ark, 'no_snapshot');
});
test('late event updates historical day only; exact midnight end never marks next day', async () => {
 const f = await fixture(), midnight = Date.parse(`${dayOf(Date.now())}T00:00:00+08:00`);
 const r = await batch(f, [segment('late-yesterday', midnight - 60000, midnight)]); const u = (await dash(f)).body.data.usage;
 assert.equal(u.today.available, false); assert.equal(u.today.focus_minutes, null); assert.equal(u.daily[5].focus_minutes, 1); assert.equal(u.daily[5].updated_at_ms, r.body.data.server_received_ms);
 writeFileSync(join(root, 'late-event-evidence.json'), JSON.stringify({ synthetic: true, ack: r.body, usage: u }, null, 2));
});

test('snapshot-only focus_active and HTTP auth/timezone errors preserve contract', async () => {
 const f = await fixture();
 const ack = await batch(f, [], { snapshot_id: 'active-without-segment', captured_at_ms: Date.now(), present: true, focus_active: true });
 assert.equal(ack.body.data.snapshot.accepted, true); noUsage((await dash(f)).body.data.usage);
 assert.equal((await request(`/v1/parent/devices/${f.pub}/dashboard`, 'invalid')).status, 401);
 const badTimezone = await request(`/v1/parent/devices/${f.pub}/dashboard?timezone=America/New_York`, f.parent);
 assert.equal(badTimezone.status, 400); assert.equal(badTimezone.body.error, 'invalid_timezone');
 const nullSnapshot = await request('/v1/device/telemetry', f.token, { schema_version: 1, batch_id: 'null-snapshot', device_ts_ms: Date.now(), snapshot: null, events: [] });
 assert.equal(nullSnapshot.status, 400);
});

test('later received disjoint segment updates usage; replay of earlier receipt cannot replace it', async () => {
 const f = await fixture(), midnight = Date.parse(`${dayOf(Date.now())}T00:00:00+08:00`);
 const first = segment('late-one', midnight - 180000, midnight - 120000);
 const r1 = await batch(f, [first]); await new Promise(resolve => setTimeout(resolve, 15));
 const r2 = await batch(f, [segment('late-two', midnight - 120000, midnight - 60000)]);
 assert.ok(r2.body.data.server_received_ms > r1.body.data.server_received_ms);
 const before = (await dash(f)).body.data.usage;
 assert.equal(before.daily[5].focus_minutes, 2); assert.equal(before.daily[5].updated_at_ms, r2.body.data.server_received_ms);
 assert.equal(before.today.updated_at_ms, null);
 await batch(f, [first]); assert.deepEqual((await dash(f)).body.data.usage, before);
});

test('normal assets do not expire at countdown 30s threshold, and brain-account replacement invalidates them', async () => {
 const f = await fixture();
 arkStore().authorize(registry.arkIdentity(f.sn)!, Date.now() - 120000);
 const s = snapshot({ captured_at_ms: Date.now() - 60000, boot_started_at_ms: Date.now() - 180000 });
 assert.equal((await upload(f, s)).body.status, 'accepted');
 const a = (await dash(f)).body.data.ark; assert.equal(a.available, true); assert.equal(a.wallets.family_coin, 120); assert.equal(a.inventory['M-CARD-001'], 2);
 registry.setAccountId(f.sn, accountStore.createDeviceAccount('BJP00326060199999998', 'synthetic-other').id);
 emptyArk((await dash(f)).body.data.ark, 'identity_mismatch');
});

test('invalid-only legacy focus plus posture daily row remains unavailable and is not rewritten', async () => {
 const f = await fixture(), now = Date.now();
 tel.prepare('INSERT INTO device_telemetry_event VALUES(?,?,?,?,?,?,?,?,?,?)').run(f.sn, 'legacy-invalid-only', 'focus_segment', now, JSON.stringify({ start_ms: now, end_ms: now }), 'old-hash', 1, now, 0, '');
 tel.prepare('INSERT INTO device_telemetry_daily(sn,date,focus_ms,correct_rounds) VALUES(?,?,0,1)').run(f.sn, dayOf(now));
 noUsage((await dash(f)).body.data.usage);
 assert.equal(tel.prepare('SELECT COUNT(*) AS n FROM device_telemetry_event WHERE sn=?').get(f.sn)!.n, 1);
});

test('telemetry light modes survive HTTP ACK, SQLite and parent projection; unknown is not guessed', async () => {
 for (const [i, mode] of ['cool', 'normal', 'warm', 'future_mode', null].entries()) {
  const f = await fixture(), now = Date.now();
  const state = { snapshot_id: `light-${i}`, captured_at_ms: now, led_enabled: false,
   brightness_level: 3, color_mode: mode, focus_active: false, presence_state: 'absent', presence_source: 'camera' };
  const r = await batch(f, [], state);
  assert.equal(r.status, 200); assert.equal(r.body.data.snapshot.accepted, true);
  const stored = JSON.parse(String(tel.prepare('SELECT payload_json FROM device_telemetry_snapshot WHERE sn=?').get(f.sn)!.payload_json));
  assert.deepEqual(stored, state, 'ACK keeps the original reported values in SQLite');
  const d = (await dash(f)).body.data.device;
  assert.equal(d.color_mode, i < 3 ? mode : null, 'no cool/normal inversion or numeric-channel guessing');
  assert.equal(d.led_enabled, false); assert.equal(d.brightness_level, 3); assert.equal(d.focus_active, false);
  assert.equal(d.presence_state, 'absent'); assert.equal(d.presence_source, 'camera');
  assert.equal(d.captured_at_ms, now); assert.equal(d.updated_at_ms, r.body.data.server_received_ms);
 }
 const empty = (await dash(await fixture())).body.data.device;
 for (const key of ['color_mode', 'led_enabled', 'brightness_level', 'captured_at_ms', 'focus_active', 'presence_state', 'presence_source']) assert.equal(empty[key], null);
});

const reminder=(id:string,at:number,outcome:unknown='played')=>({event_id:id,type:'posture_reminder',occurred_at_ms:at,data:{focus_id:null,kind:'generic_deviation',outcome}});
test('posture reminders count exact played once by event ID, not rounds or mixed batch size',async()=>{
 const f=await fixture(),now=Date.now(),played=reminder('played',now);
 const r=await batch(f,[played,reminder('cooled',now,'suppressed_cooldown'),reminder('unknown',now,'future_outcome'),reminder('array-not-played',now,['played']),{event_id:'deviated-only',type:'posture_round',occurred_at_ms:now,data:{result:'deviated'}}]);
 assert.equal(r.status,200);assert.equal(r.body.data.snapshot,null);assert.equal(r.body.data.acked_event_ids.length,5);assert.deepEqual(r.body.data.rejected,[]);
 for(let i=0;i<3;i++){const replay=await batch(f,[played]);assert.deepEqual(replay.body.data.acked_event_ids,[]);assert.deepEqual(replay.body.data.duplicated_event_ids,['played']);}
 const d=(await dash(f)).body.data,p=d.posture_reminders;
 assert.equal(p.source,'telemetry.posture_reminder');assert.equal(p.timezone,'Asia/Shanghai');
 assert.equal(p.today.played_count,1);assert.equal(p.today.suppressed_count,1);assert.equal(p.today.unknown_count,2);assert.equal(p.today.available,true);assert.equal(p.today.updated_at_ms,r.body.data.server_received_ms);assert.equal(d.today.posture_alert_count,1);
 assert.equal(p.history.played_count,1);assert.equal(p.coverage.complete,false);assert.equal(p.daily.length,1);
 assert.equal(tel.prepare('SELECT reminder_played FROM device_telemetry_daily WHERE sn=?').get(f.sn)!.reminder_played,1);
 assert.equal(tel.prepare('SELECT reminder_suppressed FROM device_telemetry_daily WHERE sn=?').get(f.sn)!.reminder_suppressed,1,'unknown outcomes are not cooldown');
 assert.equal(JSON.stringify(p).includes('"event_id"'),false,'aggregate DTO does not disclose raw event IDs');
});
test('posture missing, unsupported and observed zero remain distinct; raw history repairs query without rewriting daily',async()=>{
 const f=await fixture(),now=Date.now();
 let d=(await dash(f)).body.data;assert.equal(d.posture_reminders.today.available,false);assert.equal(d.posture_reminders.today.played_count,null);assert.equal(d.today.posture_alert_count,null);
 await batch(f,[{event_id:'round',type:'posture_round',occurred_at_ms:now,data:{result:'deviated'}},reminder('unknown',now,{toString:'played'})]);
 d=(await dash(f)).body.data;assert.equal(d.posture_reminders.today.played_count,null);assert.equal(d.posture_reminders.today.unknown_count,1);
 await batch(f,[reminder('cooled',now,'suppressed_cooldown')]);d=(await dash(f)).body.data;assert.equal(d.posture_reminders.today.available,true);assert.equal(d.posture_reminders.today.played_count,0);assert.equal(d.posture_reminders.today.suppressed_count,1);
 tel.prepare('INSERT INTO device_telemetry_event VALUES(?,?,?,?,?,?,?,?,?,?)').run(f.sn,'historic-raw-only','posture_reminder',now,JSON.stringify({focus_id:null,kind:'generic_deviation',outcome:'played'}),'legacy-test',1,now,0,'legacy-trace');
 d=(await dash(f)).body.data;assert.equal(d.posture_reminders.today.played_count,1);assert.equal(d.today.posture_alert_count,1);assert.equal(tel.prepare('SELECT reminder_played FROM device_telemetry_daily WHERE sn=?').get(f.sn)!.reminder_played,0,'no business history repair writes');
});
test('late posture upload belongs to original Beijing day, midnight is today, and received time is separate',async()=>{
 const f=await fixture(),now=Date.now(),midnight=Date.parse(dayOf(now)+'T00:00:00+08:00');
 const r=await batch(f,[reminder('prior-day',midnight-1),reminder('old-queue',midnight-86400000*20)]);
 let p=(await dash(f)).body.data.posture_reminders;assert.equal(p.today.played_count,null);assert.equal(p.history.played_count,2);assert.equal(p.history.from_day,dayOf(midnight-86400000*20));assert.equal(p.history.to_day,dayOf(midnight-1));assert.equal(p.history.updated_at_ms,r.body.data.server_received_ms);assert.equal(p.coverage.clock_suspect_count,0,'late occurred time is not clock skew');
 const next=await batch(f,[reminder('at-midnight',midnight)]);p=(await dash(f)).body.data.posture_reminders;assert.equal(p.today.played_count,1);assert.equal(p.today.updated_at_ms,next.body.data.server_received_ms);assert.equal(p.history.played_count,3);
});
test('posture raw event and daily increment are atomic and safe to retry after storage failure',async()=>{
 const f=await fixture(),now=Date.now(),event=reminder('atomic-played',now);
 tel.exec(`CREATE TRIGGER fail_posture_daily BEFORE INSERT ON device_telemetry_daily WHEN NEW.sn='${f.sn}' BEGIN SELECT RAISE(ABORT,'synthetic-write-failure'); END;`);
 try{const failed=await fetch(base+'/v1/device/telemetry',{method:'POST',headers:{authorization:'Bearer '+f.token,'content-type':'application/json'},body:JSON.stringify({schema_version:1,batch_id:'failed-posture',device_ts_ms:now,events:[event]})});assert.equal(failed.status,500);assert.equal(tel.prepare('SELECT COUNT(*) n FROM device_telemetry_event WHERE sn=?').get(f.sn)!.n,0,'failed aggregation must not leave an ACKable raw row');}finally{tel.exec('DROP TRIGGER fail_posture_daily');}
 assert.deepEqual((await batch(f,[event])).body.data.acked_event_ids,['atomic-played']);assert.equal((await dash(f)).body.data.posture_reminders.today.played_count,1);
});

test('posture clock quality is labelled separately and invalid historical times do not invent a day',async()=>{
 const f=await fixture(),now=Date.now();
 const row=(id:string,at:number,skew:number)=>tel.prepare('INSERT INTO device_telemetry_event VALUES(?,?,?,?,?,?,?,?,?,?)').run(f.sn,id,'posture_reminder',at,JSON.stringify({focus_id:null,kind:'generic_deviation',outcome:'played'}),'old-'+id,1,now,skew,'legacy-trace');
 row('clock-skew',now,400000);row('invalid-time',9e15,0);
 const p=(await dash(f)).body.data.posture_reminders;
 assert.equal(p.today.played_count,1);assert.equal(p.history.played_count,1);assert.equal(p.today.clock_suspect_count,1);assert.equal(p.coverage.invalid_time_count,1);assert.equal(p.coverage.clock_suspect_count,1);assert.equal(p.coverage.complete,false);assert.equal(p.daily.length,1);
});
test('posture read failure degrades only reminder counts and retains device, usage and other domains',async()=>{
 const {telemetryStore}=await import('../src/telemetry-store.js');const f=await fixture(),now=Date.now();
 await batch(f,[reminder('one',now)],{snapshot_id:'state',captured_at_ms:now,led_enabled:false});const before=(await dash(f)).body.data;
 const original=telemetryStore.postureReminders;
 telemetryStore.postureReminders=()=>{throw Error('synthetic-read-failure');};
 try{const d=(await dash(f)).body.data;assert.equal(d.posture_reminders.reason,'dependency_unavailable');assert.equal(d.posture_reminders.today.played_count,null);assert.equal(d.today.posture_alert_count,null);assert.deepEqual(d.device,before.device);assert.deepEqual(d.usage,before.usage);assert.deepEqual(d.ark,before.ark);}finally{telemetryStore.postureReminders=original;}
 const other=await fixture();assert.equal((await dash(f,other.parent)).status,404);
});


test('accepted reminder with an invalid calendar time is durable without a fake day or endless retry',async()=>{
 const f=await fixture(),event=reminder('invalid-calendar',9e15),r=await batch(f,[event]);
 assert.equal(r.status,200);assert.equal(r.body.data.snapshot,null);assert.deepEqual(r.body.data.acked_event_ids,['invalid-calendar']);assert.deepEqual(r.body.data.rejected,[]);
 assert.equal(tel.prepare('SELECT occurred_at_ms FROM device_telemetry_event WHERE sn=?').get(f.sn)!.occurred_at_ms,9e15);
 assert.equal(tel.prepare('SELECT COUNT(*) n FROM device_telemetry_daily WHERE sn=?').get(f.sn)!.n,0);
 const p=(await dash(f)).body.data.posture_reminders;assert.equal(p.available,false);assert.equal(p.history.reason,'invalid_event_time');assert.equal(p.history.played_count,null);assert.equal(p.coverage.invalid_time_count,1);assert.equal(p.coverage.clock_suspect_count,0);assert.deepEqual(p.daily,[]);
 assert.deepEqual((await batch(f,[event])).body.data.duplicated_event_ids,['invalid-calendar']);
});
