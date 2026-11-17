import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { SignJWT } from 'jose';

// Only external WeChat HTTP is simulated. SQLite migrations, routes, JWT and account conflicts are real.
const tmp = mkdtempSync(join(tmpdir(), 'p003-wechat-identity-'));
process.env.ACCOUNTS_DB_PATH = join(tmp, 'accounts.db');
process.env.AUTH_JWT_SECRET = 'isolated-wechat-identity-jwt-secret-at-least-32';
process.env.WECHAT_APP_ID = 'wx1111111111111111';
process.env.WECHAT_APP_SECRET = 'isolated-wechat-secret-never-return';
const old = new DatabaseSync(process.env.ACCOUNTS_DB_PATH);
old.exec("CREATE TABLE account (id TEXT PRIMARY KEY,nickname TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'parent',created_at INTEGER NOT NULL); INSERT INTO account VALUES ('acct-01','existing parent','parent',1)");
old.close();
const { accountStore } = await import('../src/account-store.js');
const { WechatPhoneClient } = await import('../src/wechat-phone.js');
const { createWechatAuthRoute } = await import('../src/routes/wechat-auth.js');
const phoneA = '13800009001', phoneB = '13800009002', phoneC = '13800009003';
const A = accountStore.upsertPhoneAccount(phoneA), B = accountStore.upsertPhoneAccount(phoneB);
const loginFixtures = new Map<string, Record<string, unknown>>();
const phoneFixtures = new Map<string, string>();
let upstreamCalls = 0, n = 0, requests = 0, assertions = 0;
const upstream: typeof fetch = async (input, init) => {
  upstreamCalls++;
  const url = new URL(String(input));
  if (url.pathname === '/sns/jscode2session') {
    assert.equal(init?.method, 'GET');
    assert.equal(url.searchParams.get('appid'), 'wx1111111111111111');
    assert.equal(url.searchParams.get('secret'), process.env.WECHAT_APP_SECRET);
    assert.equal(url.searchParams.get('grant_type'), 'authorization_code');
    const code = url.searchParams.get('js_code')!;
    if (code === 'network-error') throw new Error('secret=isolated-wechat-secret-never-return&session_key=private-session');
    return Response.json(loginFixtures.get(code) ?? { errcode: 40029, errmsg: 'private-upstream-error' });
  }
  if (url.pathname === '/cgi-bin/stable_token') return Response.json({ access_token: 'private-access-token', expires_in: 7200 });
  if (url.pathname === '/wxa/business/getuserphonenumber') {
    const phone = phoneFixtures.get(JSON.parse(String(init?.body)).code);
    return Response.json(phone ? { errcode: 0, phone_info: { purePhoneNumber: phone, phoneNumber: `+86${phone}`, countryCode: '86', watermark: { appid: 'wx1111111111111111', timestamp: 1 } } } : { errcode: 40029 });
  }
  throw new Error('unexpected upstream URL');
};
const client = new WechatPhoneClient({ fetchImpl: upstream });
const app = new Hono().route('/api/auth', createWechatAuthRoute({ client }));
const eq = (actual: unknown, expected: unknown, label: string) => { assert.deepEqual(actual, expected, label); assertions++; };
function codes(phone: string, openid: string, unionid?: string) {
  const login_code = `login-${++n}`, phone_code = `phone-${n}`;
  loginFixtures.set(login_code, { openid, session_key: 'private-session', ...(unionid ? { unionid } : {}) });
  phoneFixtures.set(phone_code, phone);
  return { login_code, phone_code, app_id: 'wx1111111111111111' };
}
async function jwt(accountId: string, role = 'parent') {
  return new SignJWT({ accountId, role }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setIssuer('p003').setAudience('kidshub').setExpirationTime('1h').sign(new TextEncoder().encode(process.env.AUTH_JWT_SECRET));
}
async function req(path: string, body?: unknown, token?: string) {
  const r = await app.request('/api/auth/wechat/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': `192.0.2.${++requests}`, ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await r.json() as any;
  const wire = JSON.stringify(data);
  for (const secret of ['private-session', 'private-access-token', 'isolated-wechat-secret', 'private-upstream-error']) eq(wire.includes(secret), false, 'response hides credentials and upstream details');
  return { status: r.status, body: data };
}

const configurationResponse = await app.request('/api/auth/wechat/config');
eq(configurationResponse.status, 200, 'anonymous users can check configuration before phone authorization');
eq(await configurationResponse.json(), { ok: true, app_id: 'wx1111111111111111', configured: true, configuration_status: 'ready' }, 'configuration exposes no user identity or secret');
const first = await req('phone', codes(phoneA, 'fixture-open-a', 'fixture-union-a'));
eq(first.status, 200, 'new wx.login code exchange must support existing phone account');
eq(first.body.account.id, A.id, 'wechat phone reuses original account');
eq(first.body.is_new, false, 'existing account stays existing');
eq(first.body.wechat_identity.openid, 'fixture-open-a', 'trusted exchanged openid persisted');
eq(first.body.wechat_identity.unionid, 'fixture-union-a', 'trusted unionid persisted');
eq(first.body.wechat_identity.state, 'linked', 'identity reports linked');
const read = await req('identity', undefined, first.body.token);
eq(read.body.wechat_identity.openid, 'fixture-open-a', 'authenticated read resolves current account');
eq(read.body.wechat_identity.configured, true, 'configured status');
const noUnion = await req('phone', codes(phoneA, 'fixture-open-a'));
eq(noUnion.body.wechat_identity.unionid, 'fixture-union-a', 'missing unionid cannot erase validated historical identity');
const b = await req('phone', codes(phoneB, 'fixture-open-b'));
eq(b.body.wechat_identity.unionid, null, 'no fabricated unionid');
eq(b.body.wechat_identity.unionid_status, 'not_returned', 'missing unionid has explicit status');

eq((await req('phone', codes(phoneB, 'fixture-open-a'))).status, 409, 'openid cannot migrate across accounts');
eq((await req('phone', codes(phoneA, 'fixture-open-other'))).status, 409, 'account cannot silently replace bound openid');
eq((await req('phone', codes(phoneA, 'fixture-open-a', 'fixture-union-other'))).status, 409, 'unionid change rejected');
eq((await req('phone', codes(phoneC, 'fixture-open-c', 'fixture-union-a'))).status, 409, 'unionid collision rejected before creating orphan account');
eq(accountStore.findByPhone(phoneC), null, 'failed identity transaction does not create a phone account');
const before = upstreamCalls;
eq((await req('phone', { ...codes(phoneC, 'fixture-open-c'), app_id: 'wx2222222222222222' })).status, 401, 'client app mismatch fails before consuming codes');
eq(upstreamCalls, before, 'app mismatch makes no upstream request');
eq((await req('phone', { ...codes(phoneC, 'fixture-open-c'), openid: 'client-spoof' })).status, 400, 'client cannot submit raw identity');
eq((await req('phone', { phone_code: 'any', login_code: 'any' })).status, 400, 'identity login requires app id consistency check');
eq((await req('phone', { phone_code: 'unused', login_code: 'bad-code', app_id: 'wx1111111111111111' })).body.error, 'wechat_login_code_invalid', 'invalid login code has a specific error');
eq((await req('phone', { phone_code: 'unused', login_code: 'network-error', app_id: 'wx1111111111111111' })).status, 502, 'upstream failure is sanitized');
const replay = codes(phoneA, 'fixture-open-a');
eq((await req('phone', replay)).status, 200, 'fresh login codes accepted');
eq((await req('phone', replay)).status, 401, 'consumed login code cannot replay');
const concurrent = codes(phoneA, 'fixture-open-a');
const results = await Promise.all([req('phone', concurrent), req('phone', concurrent)]);
eq(results.map(r => r.status).sort(), [200, 401], 'concurrent reuse has one winner');

const tokenA = await jwt(A.id), tokenB = await jwt(B.id);
eq((await req('link', codes(phoneA, 'fixture-open-a'), tokenA)).status, 200, 'authenticated account can refresh its own identity');
eq((await req('link', codes(phoneA, 'fixture-open-a'), tokenB)).body.error, 'wechat_phone_mismatch', 'backfill cannot attach another account phone');
eq((await req('link', codes(phoneA, 'fixture-open-a'))).status, 401, 'link requires a session');
const device = accountStore.createDeviceAccount('TEST-WECHAT-DEVICE', 'fixture');
eq((await req('identity', undefined, await jwt(device.id, 'device'))).status, 403, 'device role cannot read parent identity');
eq((await req('link', codes(phoneA, 'fixture-open-a'), await jwt(device.id, 'device'))).status, 403, 'device role cannot bind identity');
const legacy = codes(phoneA, 'not-consumed');
eq((await req('phone', { phone_code: legacy.phone_code })).body.account.id, A.id, 'old phone-only clients remain compatible');
eq((await req('identity', undefined, tokenA)).body.wechat_identity.openid, 'fixture-open-a', 'all failed conflicts preserve old identity');
eq(accountStore.findAccount('acct-01')?.nickname, 'existing parent', 'migration preserves existing pre-phone account');
const db = new DatabaseSync(process.env.ACCOUNTS_DB_PATH, { readOnly: true });
eq(db.prepare('SELECT COUNT(*) n FROM account_wechat_identity').get()?.n, 2, 'only verified identities persisted');
db.close();
delete process.env.WECHAT_APP_SECRET;
const unavailable = await req('identity', undefined, tokenA);
eq(unavailable.body.wechat_identity.configured, false, 'configuration gaps are visible without breaking authenticated identity read');
eq(unavailable.body.wechat_identity.configuration_status, 'missing_app_secret', 'operators can distinguish missing secret from missing app id');
eq(unavailable.body.wechat_identity.openid, 'fixture-open-a', 'saved identity remains visible if secret is missing');
eq((await req('phone', codes(phoneA, 'fixture-open-a'))).status, 503, 'new exchange cannot bypass missing configuration');
delete process.env.WECHAT_APP_ID;
eq((await req('identity', undefined, tokenA)).body.wechat_identity.app_id, null, 'missing app config never trusts a client-reported app id');
console.log(`wechat-identity: PASS ${assertions} assertions; real SQLite/JWT/routes, only upstream WeChat HTTP simulated`);
