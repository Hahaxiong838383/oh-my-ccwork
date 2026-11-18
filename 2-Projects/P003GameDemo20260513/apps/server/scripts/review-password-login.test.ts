import assert from 'node:assert/strict';
import { randomBytes, scryptSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';

const tmp = mkdtempSync(join(tmpdir(), 'p003-review-login-'));
process.chdir(tmp);
for (const name of ['ACCOUNTS', 'SMS', 'DEVICES', 'PROFILE', 'TELEMETRY', 'PAIRING', 'MEMORY', 'CONFIG']) {
  process.env[name + '_DB_PATH'] = join(tmp, name.toLowerCase() + '.db');
}
process.env.AUTH_JWT_SECRET = randomBytes(32).toString('hex');
const phone = '13800001234', other = '13800001235';
const password = randomBytes(24).toString('base64url') + '#';
const salt = randomBytes(16);
const hash = scryptSync(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const configured = salt.toString('hex') + ':' + hash.toString('hex');
process.env.PARENT_REVIEW_PHONE = phone;
process.env.PARENT_REVIEW_PASSWORD_HASH = configured;

const { smsAuthRoute } = await import('../src/routes/sms-auth.js');
const { verifyCodeStore } = await import('../src/verify-code-store.js');
const { accountStore } = await import('../src/account-store.js');
const { verifyAuthToken } = await import('../src/auth-jwt.js');
const { parentTelemetryRoute } = await import('../src/routes/telemetry.js');
const { deviceRegistryStore } = await import('../src/device-registry-store.js');
const app = new Hono().route('/api/auth', smsAuthRoute).route('/v1/parent/devices', parentTelemetryRoute);
const { reviewPasswordAuthRoute } = await import('../src/routes/review-password-auth.js');
app.route('/api/auth', reviewPasswordAuthRoute);
function post(body: Record<string, unknown>, ip = '203.0.113.1', path = '/api/auth/password/login') {
  return app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': ip }, body: JSON.stringify(body) });
}

const account = accountStore.upsertPhoneAccount(phone);
const correctBody = { phone, password };
const login = await post(correctBody);
assert.equal(login.status, 200, 'review phone logs in independently of SMS or WeChat');
assert.equal(login.headers.get('cache-control'), 'no-store');
const session = await login.json();
assert.equal(session.is_new, false);
assert.equal(session.account.id, account.id);
assert.equal(session.account.phone_masked, '138****1234');
assert.equal(session.token_type, 'Bearer');
assert.equal(session.expires_in, 2592000);
assert.deepEqual(await verifyAuthToken(session.token), { accountId: account.id, role: 'parent' });
verifyCodeStore.issue(phone, '192831');
const sms = await post({ phone, code: '192831' }, undefined, '/api/auth/sms/verify');
assert.equal(sms.status, 200);
assert.equal((await sms.json()).account.id, account.id);

const sn = 'BJP00326110300000001';
deviceRegistryStore.add(sn, 'ACL test');
const foreign = accountStore.upsertPhoneAccount('13800001236');
deviceRegistryStore.setParentAccountId(sn, foreign.id);
const devicePath = '/v1/parent/devices/' + deviceRegistryStore.get(sn)!.public_id + '/dashboard';
const headers = { authorization: 'Bearer ' + session.token };
assert.equal((await app.request(devicePath, { headers })).status, 404);
deviceRegistryStore.setParentAccountId(sn, account.id);
assert.equal((await app.request(devicePath, { headers })).status, 200);

for (const body of [{ phone: other, password }, { phone, password: password + '!' }]) {
  const r = await post(body);
  const reply = await r.json();
  assert.equal(r.status, 401);
  assert.equal(reply.error, 'invalid_credentials');
  assert.equal(reply.token, undefined);
}
assert.equal(accountStore.findByPhone(other), null);
assert.equal((await post({ ...correctBody, role: 'admin' })).status, 400);
assert.equal((await post({ ...correctBody, password: 'x'.repeat(5000) })).status, 400);
delete process.env.PARENT_REVIEW_PASSWORD_HASH;
assert.equal((await post(correctBody)).status, 503);
process.env.PARENT_REVIEW_PASSWORD_HASH = 'unusable';
assert.equal((await post(correctBody)).status, 503);
process.env.PARENT_REVIEW_PASSWORD_HASH = configured;
process.env.PARENT_REVIEW_PHONE = other;
const first = await post({ phone: other, password }, '203.0.113.2');
assert.equal((await first.json()).is_new, true);
const db = new DatabaseSync(process.env.ACCOUNTS_DB_PATH!);
db.prepare("UPDATE account SET role='device' WHERE phone=?").run(other);
const mismatch = await post({ phone: other, password }, '203.0.113.2');
assert.equal(mismatch.status, 500);
assert.equal((await mismatch.json()).token, undefined);
db.close();
process.env.PARENT_REVIEW_PHONE = phone;
for (let i = 0; i < 8; i++) assert.equal((await post({ phone, password: 'wrong' }, '203.0.113.3')).status, 401);
const blocked = await post(correctBody, '203.0.113.3');
assert.equal(blocked.status, 429);
assert.ok(Number(blocked.headers.get('retry-after')) > 0);
assert.equal((await post(correctBody, '203.0.113.4')).status, 200);
console.log('review-password-login: PASS – credentials, SMS identity, device ACL, rate limit');
