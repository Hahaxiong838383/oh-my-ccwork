/** Real Hono + SQLite; only the external paid SMS transport is replaced. No real SMS. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const tmp = mkdtempSync(join(tmpdir(), 'p003-sms-hardening-'));
process.env.ACCOUNTS_DB_PATH = join(tmp, 'accounts.db');
process.env.SMS_DB_PATH = join(tmp, 'sms.db');
process.env.AUTH_JWT_SECRET = 'isolated-sms-test-secret-at-least-32-bytes';
process.env.SMS_PROVIDER = 'spug';
process.env.SPUG_SMS_TEMPLATE_CODE = 'ISOLATED_TEST_TEMPLATE';
delete process.env.SMS_TEST_PHONE_ALLOWLIST;
const { Hono } = await import('hono');
const { smsAuthRoute } = await import('../src/routes/sms-auth.js');
const { setSpugTransportForTest } = await import('../src/spug-sms.js');
const { smsLimitStore } = await import('../src/sms-limit-store.js');
const { verifyCodeStore } = await import('../src/verify-code-store.js');
const { accountStore } = await import('../src/account-store.js');
const { verifyAuthToken } = await import('../src/auth-jwt.js');
const app = new Hono().route('/api/auth', smsAuthRoute);
let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; console.log('PASS ' + name); }
  catch (e) { failed++; console.error('FAIL ' + name + ': ' + (e as Error).message); }
}
async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await app.request('/api/auth/sms/' + path, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.10', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() as any, headers: res.headers };
}
const codes = new Map<string, string>();
function acceptedTransport() {
  setSpugTransportForTest(async (_url, body) => {
    codes.set(body.to!, body.code!);
    return { code: 200, msg: '请求成功', request_id: 'isolated-provider-' + body.to };
  });
}
acceptedTransport();

await test('same-phone concurrent sends charge once and return one 429', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const enteredProvider = new Promise<void>(resolve => { entered = resolve; });
  let calls = 0;
  setSpugTransportForTest(async (_url, body) => {
    calls++; entered(); await gate; codes.set(body.to!, body.code!);
    return { code: 200, msg: '请求成功', request_id: 'race-request' };
  });
  const a = post('send', { phone: '13800009001' });
  await enteredProvider;
  const b = post('send', { phone: '13800009001' });
  await new Promise(resolve => setTimeout(resolve, 20));
  release();
  const results = await Promise.all([a, b]);
  assert.deepEqual(results.map(x => x.status).sort(), [200, 429]);
  assert.equal(calls, 1);
  acceptedTransport();
});
acceptedTransport();

await test('send response documents lifetime, cooldown, request ID and no-store without exposing code', async () => {
  const r = await post('send', { phone: '13800009002' });
  assert.equal(r.status, 200);
  assert.equal(r.json.expires_in, 300);
  assert.equal(r.json.resend_after_s, 60);
  assert.match(r.json.request_id, /^smsreq-/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(JSON.stringify(r.json).includes(codes.get('13800009002')!), false);
});
await test('cooldown returns same Retry-After header and JSON value', async () => {
  const r = await post('send', { phone: '13800009002' });
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('retry-after'), String(r.json.retry_after_s));
});
await test('spoofed forwarded-for cannot bypass nginx real-IP daily quota', async () => {
  for (let i = 0; i < 20; i++) smsLimitStore.record('13900008' + String(i).padStart(3, '0'), '203.0.113.44', 'seed', Date.now() - 120000);
  const r = await post('send', { phone: '13800009003' }, { 'x-real-ip': '203.0.113.44', 'x-forwarded-for': '198.51.100.200' });
  assert.equal(r.status, 429); assert.equal(r.json.reason, 'ip_day');
});
await test('weak auth configuration fails before a paid send', async () => {
  const original = process.env.AUTH_JWT_SECRET;
  let calls = 0;
  setSpugTransportForTest(async () => { calls++; return { code: 200, request_id: 'must-not-send' }; });
  process.env.AUTH_JWT_SECRET = 'dev-secret-change-me';
  try {
    const r = await post('send', { phone: '13800009004' });
    assert.equal(r.status, 503); assert.equal(r.json.error, 'auth_not_configured'); assert.equal(calls, 0);
  } finally { process.env.AUTH_JWT_SECRET = original; acceptedTransport(); }
});
await test('weak auth config never consumes an otherwise valid code', async () => {
  verifyCodeStore.issue('13800009005', '457891');
  const original = process.env.AUTH_JWT_SECRET; process.env.AUTH_JWT_SECRET = '';
  try { assert.equal((await post('verify', { phone: '13800009005', code: '457891' })).status, 503); }
  finally { process.env.AUTH_JWT_SECRET = original; }
  assert.equal(verifyCodeStore.verify('13800009005', '457891'), 'ok');
});
await test('exact expiry instant is expired, not one extra accepted millisecond', () => {
  verifyCodeStore.issue('13800009006', '457891', 1_000_000);
  assert.equal(verifyCodeStore.verify('13800009006', '457891', 1_300_000), 'expired');
});
await test('stored six-digit code uses keyed digest, not enumerable phone+code SHA', () => {
  verifyCodeStore.issue('13800009007', '457891');
  const db = new DatabaseSync(process.env.SMS_DB_PATH!);
  const row = db.prepare('SELECT code_hash FROM verify_code WHERE phone=?').get('13800009007') as { code_hash: string };
  db.close();
  assert.notEqual(row.code_hash, createHash('sha256').update('13800009007:457891').digest('hex'));
  assert.equal(row.code_hash.includes('457891'), false);
});
await test('successful login reuses original account and returns existing auth-compatible Bearer', async () => {
  const a = accountStore.upsertPhoneAccount('13800009008');
  verifyCodeStore.issue('13800009008', '457891');
  const r = await post('verify', { phone: '13800009008', code: '457891' });
  assert.equal(r.status, 200); assert.equal(r.json.account.id, a.id); assert.equal(r.json.is_new, false);
  assert.equal(r.json.token_type, 'Bearer'); assert.equal(r.json.expires_in, 2592000);
  assert.equal(r.json.account.role, 'parent'); assert.equal(r.json.account.phone_masked, '138****9008');
  assert.deepEqual(await verifyAuthToken(r.json.token), { accountId: a.id, role: 'parent' });
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal((await post('verify', { phone: '13800009008', code: '457891' })).status, 401);
});
await test('first verified phone creates one account; second login preserves identity', async () => {
  assert.equal(accountStore.findByPhone('13800009009'), null);
  verifyCodeStore.issue('13800009009', '457891');
  const a = await post('verify', { phone: '13800009009', code: '457891' });
  assert.equal(a.status, 200); assert.equal(a.json.is_new, true);
  verifyCodeStore.issue('13800009009', '457892');
  const b = await post('verify', { phone: '13800009009', code: '457892' });
  assert.equal(b.json.is_new, false); assert.equal(b.json.account.id, a.json.account.id);
});
await test('non-parent account cannot be silently issued a parent token', async () => {
  const a = accountStore.upsertPhoneAccount('13800009010');
  const db = new DatabaseSync(process.env.ACCOUNTS_DB_PATH!);
  db.prepare('UPDATE account SET role=? WHERE id=?').run('device', a.id); db.close();
  verifyCodeStore.issue('13800009010', '457891');
  const r = await post('verify', { phone: '13800009010', code: '457891' });
  assert.equal(r.status, 500); assert.equal(r.json.error, 'account_login_failed'); assert.equal(r.json.token, undefined);
});
await test('provider exception never logs credential URL or code', async () => {
  const lines: string[] = []; const original = console.error;
  console.error = (...v) => { lines.push(v.map(String).join(' ')); };
  setSpugTransportForTest(async () => { throw new Error('network https://push.spug.cc/sms/ISOLATED_TEST_TEMPLATE code=457891'); });
  try {
    const r = await post('send', { phone: '13800009011' });
    assert.equal(r.status, 502);
    assert.equal(lines.join('\n').includes('ISOLATED_TEST_TEMPLATE'), false);
    assert.equal(lines.join('\n').includes('457891'), false);
  } finally { console.error = original; acceptedTransport(); }
});
await test('body bound rejects oversized request before paid transport', async () => {
  let calls = 0; setSpugTransportForTest(async () => { calls++; return { code: 200, request_id: 'oversized' }; });
  try {
    const r = await post('send', { phone: '13800009012', ignored: 'x'.repeat(8192) });
    assert.equal(r.status, 400); assert.equal(calls, 0);
  } finally { acceptedTransport(); }
});
await test('uncertain provider results remain in durable hourly quota after reservation expiry', async () => {
  const now = Date.now, start = now();
  setSpugTransportForTest(async () => { throw new Error('isolated timeout'); });
  try {
    for (let i = 0; i < 5; i++) {
      Date.now = () => start + i * 61000;
      assert.equal((await post('send', { phone: '13800009013' }, { 'x-real-ip': '203.0.113.71' })).status, 502);
    }
    Date.now = () => start + 5 * 61000;
    const r = await post('send', { phone: '13800009013' }, { 'x-real-ip': '203.0.113.71' });
    assert.equal(r.status, 429); assert.equal(r.json.reason, 'phone_hour');
    assert.equal(verifyCodeStore.verify('13800009013', '457891'), 'not_found');
  } finally { Date.now = now; acceptedTransport(); }
});
await test('provider success missing receipt ID is uncertain and cannot release send quota', async () => {
  setSpugTransportForTest(async () => ({ code: 200, msg: '请求成功' }));
  try {
    assert.equal((await post('send', { phone: '13800009014' })).status, 502);
    assert.equal((await post('send', { phone: '13800009014' })).status, 429);
  } finally { acceptedTransport(); }
});
await test('crash before provider completion cannot erase attempted sends after lease expiry', () => {
  const start = Date.now();
  for (let i = 0; i < 5; i++) {
    assert.equal(smsLimitStore.reserve('13800009015', '203.0.113.72', start + i * 61000).ok, true);
  }
  const denied = smsLimitStore.reserve('13800009015', '203.0.113.72', start + 5 * 61000);
  assert.equal(denied.ok, false);
  assert.equal('reason' in denied && denied.reason, 'phone_hour');
});
await test('storage reservation failure returns safe JSON before any paid send', async () => {
  const original = smsLimitStore.reserve;
  let calls = 0;
  smsLimitStore.reserve = () => { throw new Error('SQLITE_BUSY private-detail'); };
  setSpugTransportForTest(async () => { calls++; return { code: 200, request_id: 'must-not-send' }; });
  try {
    const r = await post('send', { phone: '13800009016' });
    assert.equal(r.status, 503); assert.equal(r.json.error, 'sms_unavailable');
    assert.equal(calls, 0); assert.equal(JSON.stringify(r.json).includes('private-detail'), false);
  } finally { smsLimitStore.reserve = original; acceptedTransport(); }
});
console.log('sms-login-hardening: pass=' + passed + ' fail=' + failed);
if (failed) process.exitCode = 1;
