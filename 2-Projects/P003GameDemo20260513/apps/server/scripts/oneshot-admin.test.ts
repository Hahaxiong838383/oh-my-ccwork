/**
 * B89 后台「版本与 One-shot」端点单测（/api/admin/oneshot*）。
 * 跑法：cd apps/server && npm run test:oneshot-admin
 * 零端口：Hono app.request()。临时 config.db；token 走真实 /api/auth/login（admin / guest 两种角色）。
 */
import assert from 'node:assert';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';

process.env.CONFIG_DB_PATH = `${tmpdir()}/p003-oneshot-admin-test-${process.pid}.db`;
process.env.STUDIO_USER = 't-admin';
process.env.STUDIO_PASS = 't-pass-123456';
process.env.STUDIO_GUEST_USER = 'guest';
process.env.STUDIO_GUEST_PASS = '123456';
process.env.RELEASE_JSON_PATH = new URL('../release.json', import.meta.url).pathname;
delete process.env.ONESHOT_FIRST_TURN_POLICY;
process.env.ONESHOT_FIRST_TURN_AGENT_NAME = 'rust-worker-firstturn';
process.env.ONESHOT_FIRST_TURN_SN_ALLOW = 'BJP00326060100200003';

const { authRoute } = await import('../src/routes/auth.js');
const { adminDataRoute } = await import('../src/routes/admin-data.js');
const { configStore } = await import('../src/config-store.js');
const { FIRST_TURN_POLICY_FLAG, resolveFirstTurnPolicy } = await import('../src/routes/device-session.js');

const logLines: string[] = [];
const origLog = console.log;
console.log = (...a: unknown[]) => {
  logLines.push(a.map(String).join(' '));
};

const app = new Hono();
app.route('/api/auth', authRoute);
app.route('/api/admin', adminDataRoute);

let pass = 0;
let fail = 0;
async function t(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    pass++;
    origLog(`  ok  ${name}`);
  } catch (e) {
    fail++;
    origLog(`  FAIL ${name}: ${(e as Error).message}`);
  }
}
async function login(username: string, password: string): Promise<string> {
  const r = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const j = (await r.json()) as Record<string, any>;
  assert.equal(r.status, 200, `login ${username}: ${JSON.stringify(j)}`);
  return j.token as string;
}
function api(token: string | null, path: string, method = 'GET', body?: unknown): Promise<Response> {
  return app.request(path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const admin = await login('t-admin', 't-pass-123456');
const guest = await login('guest', '123456');
configStore.clearFlag(FIRST_TURN_POLICY_FLAG);

await t('GET /oneshot：未登录 401、guest 403（admin 专属）、admin 200', async () => {
  assert.equal((await api(null, '/api/admin/oneshot')).status, 401);
  assert.equal((await api(guest, '/api/admin/oneshot')).status, 403);
  const r = await api(admin, '/api/admin/oneshot');
  assert.equal(r.status, 200);
  const j = (await r.json()) as Record<string, any>;
  assert.equal(j.ok, true);
  assert.equal(j.policy.effective, 'allowlist');
  assert.equal(j.policy.source, 'default');
  assert.equal(j.policy.override, null);
  assert.deepEqual(j.policy.valid, ['capability', 'allowlist', 'off']);
  assert.equal(j.agent_name, 'rust-worker-firstturn');
  assert.equal(j.allowlist_count, 1);
  assert.equal(j.release.ok, true, JSON.stringify(j.release));
  assert.equal(j.release.data.current.label, 'V1.1 正式版');
  assert.equal(j.release.data.current.oneshot, true);
  assert.equal(j.release.data.history[0].label, 'V1.0 正式版');
  assert.ok(j.caveat.includes('first_turn_not_granted'), 'B87 边界必须随载荷下发');
});

await t('PUT /oneshot/policy off：admin 生效、带操作人、日志留痕；GET 与签发解析同源', async () => {
  const r = await api(admin, '/api/admin/oneshot/policy', 'PUT', { policy: 'off', note: '演练' });
  assert.equal(r.status, 200);
  const j = (await r.json()) as Record<string, any>;
  assert.equal(j.ok, true);
  assert.equal(j.changed, true);
  assert.deepEqual(j.before, { policy: 'allowlist', source: 'default' });
  assert.equal(j.policy.effective, 'off');
  assert.equal(j.policy.source, 'override');
  assert.equal(j.policy.override.updated_by, 't-admin');
  assert.equal(j.policy.override.note, '演练');
  assert.equal(resolveFirstTurnPolicy().policy, 'off', '签发路由用的解析函数必须同步看到');
  assert.ok(logLines.some((l) => l.includes('[admin-oneshot] policy allowlist(default) → off(override) by=t-admin')));
});

await t('PUT 非法值 400 不落库；大小写/空白容错；guest 写 403', async () => {
  assert.equal((await api(admin, '/api/admin/oneshot/policy', 'PUT', { policy: 'capabilty' })).status, 400);
  assert.equal(resolveFirstTurnPolicy().policy, 'off', '非法请求不得改动现值');
  const r = await api(admin, '/api/admin/oneshot/policy', 'PUT', { policy: ' Capability ' });
  assert.equal(((await r.json()) as Record<string, any>).policy.effective, 'capability');
  assert.equal((await api(guest, '/api/admin/oneshot/policy', 'PUT', { policy: 'off' })).status, 403);
  assert.equal(resolveFirstTurnPolicy().policy, 'capability', 'guest 的写不得生效');
});

await t('DELETE /oneshot/policy：清除覆盖回落 env/默认，幂等', async () => {
  let r = await api(admin, '/api/admin/oneshot/policy', 'DELETE');
  let j = (await r.json()) as Record<string, any>;
  assert.equal(j.ok, true);
  assert.equal(j.removed, true);
  assert.equal(j.policy.effective, 'allowlist');
  assert.equal(j.policy.source, 'default');
  r = await api(admin, '/api/admin/oneshot/policy', 'DELETE');
  j = (await r.json()) as Record<string, any>;
  assert.equal(j.removed, false, '第二次删是幂等 no-op');
  assert.equal(j.policy.effective, 'allowlist');
});

await t('日志敏感扫描：本文件所有路由日志不含 token', async () => {
  const leaked = logLines.filter((l) => l.includes(admin) || l.includes(guest));
  assert.equal(leaked.length, 0);
  assert.ok(logLines.some((l) => l.includes('[admin-oneshot]')), '正锚：至少有一条 admin-oneshot 日志');
});

console.log = origLog;
origLog(`\n${pass} passed / ${fail} failed`);
if (fail > 0) process.exit(1);
