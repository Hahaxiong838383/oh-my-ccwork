import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';

const tmp = mkdtempSync(join(tmpdir(), 'p003-sms-http-'));
process.chdir(tmp);
for (const name of ['ACCOUNTS', 'SMS', 'DEVICES', 'PROFILE', 'TELEMETRY', 'PAIRING', 'MEMORY', 'CONFIG']) {
  process.env[name + '_DB_PATH'] = join(tmp, name.toLowerCase() + '.db');
}
process.env.AUTH_JWT_SECRET = 'isolated-http-sms-secret-at-least-32-bytes';
process.env.SMS_PROVIDER = 'spug';
process.env.SPUG_SMS_TEMPLATE_CODE = 'ISOLATED_TEMPLATE';
delete process.env.SMS_TEST_PHONE_ALLOWLIST;
const { smsAuthRoute } = await import('../src/routes/sms-auth.js');
const { profileRoute } = await import('../src/routes/profile.js');
const { parentTelemetryRoute } = await import('../src/routes/telemetry.js');
const { bleBindingsRoute } = await import('../src/routes/ble-bindings.js');
const { setSpugTransportForTest } = await import('../src/spug-sms.js');
const { accountStore } = await import('../src/account-store.js');
const { deviceRegistryStore } = await import('../src/device-registry-store.js');
const { verifyCodeStore } = await import('../src/verify-code-store.js');
const codes = new Map<string, string>();
setSpugTransportForTest(async (_url, body) => {
  codes.set(body.to!, body.code!);
  return { code: 200, msg: '请求成功', request_id: 'isolated-' + body.to };
});
const A = accountStore.upsertPhoneAccount('13800009101'), B = accountStore.upsertPhoneAccount('13800009102');
const sn = 'BJP00326110300000001';
deviceRegistryStore.add(sn, 'isolated SMS ACL fixture');
deviceRegistryStore.setParentAccountId(sn, A.id);
const publicId = deviceRegistryStore.get(sn)!.public_id;
const app = new Hono().route('/api/auth', smsAuthRoute).route('/api/profile', profileRoute)
  .route('/v1/parent/devices', parentTelemetryRoute).route('/api/parent/ble-bindings', bleBindingsRoute);
let listening!: () => void;
const ready = new Promise<void>(resolve => { listening = resolve; });
const server = serve({ hostname: '127.0.0.1', port: 0, fetch: app.fetch }, () => listening());
await ready;
const port = (server.address() as { port: number }).port;
let assertions = 0;
async function req(path: string, body?: unknown, token?: string) {
  const r = await fetch('http://127.0.0.1:' + port + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.111', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: await r.json() as any, headers: r.headers };
}
function eq(actual: unknown, expected: unknown, msg: string) { assert.deepEqual(actual, expected, msg); assertions++; }
async function login(phone: string) {
  eq((await req('/api/auth/sms/send', { phone })).status, 200, 'real HTTP send accepted');
  return req('/api/auth/sms/verify', { phone, code: codes.get(phone) });
}
try {
  const a = await login('13800009101'), b = await login('13800009102');
  eq(a.body.account.id, A.id, 'A original account'); eq(b.body.account.id, B.id, 'B original account');
  eq(a.body.is_new, false, 'A is existing'); eq(b.body.is_new, false, 'B is existing');
  eq((await req('/api/profile/bound-devices', undefined, a.body.token)).body.devices.map((d: any) => d.public_id), [publicId], 'A device preserved');
  eq((await req('/api/profile/bound-devices', undefined, b.body.token)).body.devices.length, 0, 'B no A devices');
  eq((await req('/v1/parent/devices/' + publicId + '/dashboard', undefined, a.body.token)).status, 200, 'A dashboard authorized');
  eq((await req('/v1/parent/devices/' + publicId + '/dashboard', undefined, b.body.token)).status, 404, 'B dashboard denied');
  eq((await req('/api/profile/bound-devices')).status, 401, 'anonymous denied');
  eq((await req('/api/parent/ble-bindings/not-a-binding', undefined, a.body.token)).status, 404, 'SMS token passes existing BLE parent authentication');
  eq(deviceRegistryStore.get(sn)!.parent_account_id, A.id, 'login never rebinds device');
  const newLogin = await login('13800009103');
  eq(newLogin.body.is_new, true, 'first phone auto creates');
  eq((await req('/api/profile/bound-devices', undefined, newLogin.body.token)).body.devices.length, 0, 'new account inherits no devices');
  eq((await req('/v1/parent/devices/' + publicId + '/dashboard', undefined, newLogin.body.token)).status, 404, 'new account cannot read A device');
  eq((await req('/api/auth/sms/verify', { phone: '13800009103', code: codes.get('13800009103') })).status, 401, 'used OTP cannot replay');
  verifyCodeStore.issue('13800009104', '456789');
  const concurrent = await Promise.all([req('/api/auth/sms/verify', { phone: '13800009104', code: '456789' }), req('/api/auth/sms/verify', { phone: '13800009104', code: '456789' })]);
  eq(concurrent.map(r => r.status).sort(), [200, 401], 'concurrent verification has one winner');
  const malformed = await fetch('http://127.0.0.1:' + port + '/api/auth/sms/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  eq(malformed.status, 400, 'malformed JSON does not throw');
  const spoof = await req('/api/auth/sms/verify', { phone: '13800009103', code: '456789', accountId: A.id, role: 'admin' });
  eq(spoof.status, 400, 'body cannot select another identity');
  console.log('sms-login-http: PASS ' + assertions + ' assertions; actual localhost HTTP, SQLite and JWT; SMS provider simulated');
} finally { await new Promise<void>(resolve => server.close(() => resolve())); }
