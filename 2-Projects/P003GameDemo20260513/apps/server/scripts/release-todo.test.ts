/**
 * 「版本与 One-shot」下一版待办（2026-09-14 川哥：v1.2 待更新内容清单，每次版本更新有来源）。
 * 跑法：cd apps/server && npm run test:release-todo
 * 零端口 Hono app.request()；临时 config.db；admin / guest 两种角色真登录。
 * 负锚：guest 403、text 空/过长 400、owner/status 非法 400、不存在 404、DELETE=软删（dropped 仍可查）。
 */
import assert from 'node:assert';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';

process.env.CONFIG_DB_PATH = `${tmpdir()}/p003-release-todo-test-${process.pid}.db`;
process.env.DEVICES_DB_PATH = `${tmpdir()}/p003-release-todo-devices-${process.pid}.db`;
process.env.STUDIO_USER = 't-admin';
process.env.STUDIO_PASS = 't-pass-123456';
process.env.STUDIO_GUEST_USER = 'guest';
process.env.STUDIO_GUEST_PASS = '123456';
process.env.RELEASE_JSON_PATH = new URL('../release.json', import.meta.url).pathname;
delete process.env.ONESHOT_FIRST_TURN_POLICY;

const { authRoute } = await import('../src/routes/auth.js');
const { adminDataRoute } = await import('../src/routes/admin-data.js');
const { configStore } = await import('../src/config-store.js');

const logLines: string[] = [];
const origLog = console.log;
console.log = (...a: unknown[]) => { logLines.push(a.map(String).join(' ')); };

const app = new Hono();
app.route('/api/auth', authRoute);
app.route('/api/admin', adminDataRoute);

let pass = 0, fail = 0;
async function t(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); pass++; origLog(`  ok  ${name}`); }
  catch (e) { fail++; origLog(`  FAIL ${name}: ${(e as Error).message}`); }
}
async function login(username: string, password: string): Promise<string> {
  const r = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  const j = (await r.json()) as Record<string, any>;
  assert.equal(r.status, 200, `login ${username}: ${JSON.stringify(j)}`);
  return j.token as string;
}
function api(token: string | null, path: string, method = 'GET', body?: unknown): Promise<Response> {
  return app.request(path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
const admin = await login('t-admin', 't-pass-123456');
const guest = await login('guest', '123456');

await t('GET /oneshot/todos：未登录 401、guest 403、admin 200 空表', async () => {
  assert.equal((await api(null, '/api/admin/oneshot/todos')).status, 401);
  assert.equal((await api(guest, '/api/admin/oneshot/todos')).status, 403);
  const r = await api(admin, '/api/admin/oneshot/todos');
  assert.equal(r.status, 200);
  assert.deepEqual(((await r.json()) as any).todos, []);
});

let id1 = 0, id2 = 0;
await t('POST 新增：带 target/source/owner，回 todo + 全表；日志留痕', async () => {
  const r = await api(admin, '/api/admin/oneshot/todos', 'POST', { text: 'worker 附和词不打断上 One-shot 池', source: '2026-09-14 排查稿 + 分支 p003/story-truncation-20260914', owner: 'cc', target: 'v1.2' });
  const j = (await r.json()) as any;
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(j.ok, true); id1 = j.todo.id;
  assert.equal(j.todo.status, 'open'); assert.equal(j.todo.owner, 'cc'); assert.equal(j.todo.target, 'v1.2');
  assert.equal(j.todo.created_by, 't-admin');
  assert.equal(j.todos.length, 1);
  assert.ok(logLines.some((l) => l.includes('[admin-oneshot] todo added') && l.includes(`id=${id1}`)), '日志锚');
});
await t('POST 缺省：target 默认 v1.2、owner 默认 cc', async () => {
  const r = await api(admin, '/api/admin/oneshot/todos', 'POST', { text: '投机轮生成结果不落库不抽记忆' });
  const j = (await r.json()) as any; id2 = j.todo.id;
  assert.equal(r.status, 200); assert.equal(j.todo.target, 'v1.2'); assert.equal(j.todo.owner, 'cc'); assert.equal(j.todo.source, '');
});
await t('POST 负锚：text 空 400、text >300 字 400、owner 非法 400、target >20 字 400、guest 403', async () => {
  assert.equal((await api(admin, '/api/admin/oneshot/todos', 'POST', { text: '   ' })).status, 400);
  assert.equal((await api(admin, '/api/admin/oneshot/todos', 'POST', { text: 'x'.repeat(301) })).status, 400);
  assert.equal((await api(admin, '/api/admin/oneshot/todos', 'POST', { text: 'ok', owner: 'someone' })).status, 400);
  assert.equal((await api(admin, '/api/admin/oneshot/todos', 'POST', { text: 'ok', target: 'v'.repeat(21) })).status, 400);
  assert.equal((await api(guest, '/api/admin/oneshot/todos', 'POST', { text: 'ok' })).status, 403);
  assert.equal(configStore.listTodos({ includeClosed: true }).length, 2, '负锚请求一条都没写进去');
});
await t('PATCH 完成：status=done 记 done_at、updated_by；再改回 open 清 done_at', async () => {
  let r = await api(admin, `/api/admin/oneshot/todos/${id1}`, 'PATCH', { status: 'done' });
  assert.equal(r.status, 200);
  let j = (await r.json()) as any;
  assert.equal(j.todo.status, 'done'); assert.ok(j.todo.done_at > 0); assert.equal(j.todo.updated_by, 't-admin');
  r = await api(admin, `/api/admin/oneshot/todos/${id1}`, 'PATCH', { status: 'open' });
  j = (await r.json()) as any;
  assert.equal(j.todo.status, 'open'); assert.equal(j.todo.done_at, null);
});
await t('PATCH 改文本/来源/owner；负锚：空 patch 400、status 非法 400、不存在 404', async () => {
  const r = await api(admin, `/api/admin/oneshot/todos/${id2}`, 'PATCH', { text: '投机轮不落库（server persistTurn 识别投机标记）', source: '排查稿 §顺手发现 1', owner: 'codex' });
  const j = (await r.json()) as any;
  assert.equal(r.status, 200); assert.equal(j.todo.owner, 'codex'); assert.match(j.todo.text, /投机标记/); assert.equal(j.todo.source, '排查稿 §顺手发现 1');
  assert.equal((await api(admin, `/api/admin/oneshot/todos/${id2}`, 'PATCH', {})).status, 400);
  assert.equal((await api(admin, `/api/admin/oneshot/todos/${id2}`, 'PATCH', { status: 'nope' })).status, 400);
  assert.equal((await api(admin, `/api/admin/oneshot/todos/99999`, 'PATCH', { status: 'done' })).status, 404);
});
await t('DELETE=软删：status=dropped，默认列表不见、all=1 仍可追', async () => {
  const r = await api(admin, `/api/admin/oneshot/todos/${id2}`, 'DELETE');
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as any).todo.status, 'dropped');
  const open = (await (await api(admin, '/api/admin/oneshot/todos')).json()) as any;
  assert.deepEqual(open.todos.map((x: any) => x.id), [id1]);
  const all = (await (await api(admin, '/api/admin/oneshot/todos?all=1')).json()) as any;
  assert.deepEqual(all.todos.map((x: any) => x.status), ['open', 'dropped'], 'open 在前、已关闭在后');
  assert.equal((await api(admin, `/api/admin/oneshot/todos/99999`, 'DELETE')).status, 404);
});
await t('GET /oneshot 载荷带 todos（含已关闭），前端一次拉全', async () => {
  const j = (await (await api(admin, '/api/admin/oneshot')).json()) as any;
  assert.equal(j.ok, true);
  assert.equal(j.todos.length, 2);
  assert.equal(j.todos[0].id, id1);
});

origLog(`release-todo: pass=${pass} fail=${fail}`);
if (fail > 0) process.exit(1);
origLog('🎉 下一版待办 全部通过');
