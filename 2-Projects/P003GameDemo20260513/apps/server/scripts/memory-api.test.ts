// 记忆面板用户 API 单测(routes/memory.ts):鉴权 401 / 越权删除与 resolve(红线) /
// 增→查→删→resolve 全链路 / POST 校验拒绝 / 兴趣删除 / GET 过滤 retracted + profile 隐私四字段。
// 跑法:cd apps/server && npx tsx scripts/memory-api.test.ts
// (node22.14 + tsx 实测直跑可用,仅有 SQLite ExperimentalWarning;若环境报缺 node:sqlite 再加 NODE_OPTIONS=--experimental-sqlite)
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { SignJWT } from 'jose';

// ⚠️ DB 隔离铁律:两个 store 都是模块加载时按 PROFILE_DB_PATH 定库的单例,
// 必须先指到独立临时文件、再动态 import,绝不碰 ./data/profile.db 真实数据。
const tmpDir = mkdtempSync(join(tmpdir(), 'memory-api-test-'));
process.env.PROFILE_DB_PATH = join(tmpDir, 'profile.db');
// auth-jwt.ts 的 SECRET 也在模块加载时求值:清掉环境里可能的自定义值,两边同用 dev fallback
delete process.env.AUTH_JWT_SECRET;

const { memoryRoute } = await import('../src/routes/memory.js');
const { memoryItemStore } = await import('../src/memory-item-store.js');
const { profileStore } = await import('../src/profile-store.js');

// 与 index.ts 真实挂载同形,直接 app.request() 走全路径,不起 HTTP 服务
const app = new Hono();
app.route('/api/memory', memoryRoute);

// 与 routes/invite-auth.ts 同参数自签 JWT(dev fallback secret / issuer p003 / audience kidshub)
const SECRET = new TextEncoder().encode('dev-secret-change-me');
async function signToken(accountId: string): Promise<string> {
  return new SignJWT({ accountId, role: 'parent' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer('p003')
    .setAudience('kidshub')
    .setExpirationTime('7d')
    .sign(SECRET);
}

type JsonBody = Record<string, unknown> & { items?: Array<Record<string, unknown>> };
async function call(
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<{ status: number; json: JsonBody }> {
  // Hono 默认 strict 路由:挂载出的根是 /api/memory(无尾斜杠),path='/' 归一为 ''(与前端真实请求一致)
  const res = await app.request(`/api/memory${path === '/' ? '' : path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json()) as JsonBody };
}

const ACCT_A = 'test-memory-api-a';
const ACCT_B = 'test-memory-api-b';
const tokenA = await signToken(ACCT_A);
const tokenB = await signToken(ACCT_B);

// 1. 鉴权:无 token / 坏 token → 401 unauthorized
{
  const noToken = await call('GET', '/');
  assert.equal(noToken.status, 401);
  assert.equal(noToken.json.error, 'unauthorized');
  const badToken = await call('GET', '/', 'not-a-jwt');
  assert.equal(badToken.status, 401);
  const noTokenPost = await call('POST', '/', undefined, { type: 'event', content: 'x' });
  assert.equal(noTokenPost.status, 401);
  console.log('✅ 1 无 token / 坏 token 全端点 401');
}

// 2. 增→查:POST 写入(subject 默认归一 / manual 来源字段) + GET 返回结构
{
  const add = await call('POST', '/', tokenA, { type: 'promise', content: '一起看恐龙纪录片', due_text: '明天' });
  assert.equal(add.status, 200);
  assert.equal(add.json.added, 1, 'POST 返回 added=1');
  const get = await call('GET', '/', tokenA);
  assert.equal(get.status, 200);
  assert.equal(get.json.ok, true);
  assert.equal(typeof get.json.server_now, 'number', 'server_now 是服务器时钟');
  assert.equal(get.json.archived_emotion_count, 0);
  const items = get.json.items!;
  assert.equal(items.length, 1);
  const it = items[0];
  assert.equal(it.type, 'promise');
  assert.equal(it.subject, 'xiaoke', 'promise 未传 subject 默认 xiaoke');
  assert.equal(it.source, 'manual');
  assert.equal(it.session_id, 'manual-panel');
  assert.equal(it.source_role, 'user');
  assert.equal(it.due_granularity, 'day', 'due_text=明天 由 store 解析');
  console.log('✅ 2 增→查:manual 写入字段齐全 + due 解析生效');
}

// 3. 越权红线:账号 B 删 / resolve 账号 A 的条目 → false 且数据原样还在
{
  const before = await call('GET', '/', tokenA);
  const target = before.json.items![0];
  const delByB = await call('DELETE', `/${target.id}`, tokenB);
  assert.equal(delByB.status, 200);
  assert.equal(delByB.json.deleted, false, '越权删除 deleted=false');
  const resolveByB = await call('POST', `/${target.id}/resolve`, tokenB);
  assert.equal(resolveByB.json.resolved, false, '越权 resolve resolved=false');
  const after = await call('GET', '/', tokenA);
  const still = after.json.items!.find((i) => i.id === target.id);
  assert.ok(still, '数据还在');
  assert.equal(still!.status, 'active', '状态未被越权改动');
  console.log('✅ 3 越权红线:B 删/resolve A 的条目全部 false,数据不动');
}

// 4. resolve→删 全链路收尾(账号 A 本人操作)
{
  const get = await call('GET', '/', tokenA);
  const target = get.json.items![0];
  const resolved = await call('POST', `/${target.id}/resolve`, tokenA);
  assert.equal(resolved.json.resolved, true, '本人 resolve 成功');
  const afterResolve = await call('GET', '/', tokenA);
  assert.equal(afterResolve.json.items![0].status, 'resolved', 'GET 里状态已 resolved(resolved 条目保留给面板)');
  const again = await call('POST', `/${target.id}/resolve`, tokenA);
  assert.equal(again.json.resolved, false, '重复 resolve 幂等返回 false');
  const del = await call('DELETE', `/${target.id}`, tokenA);
  assert.equal(del.json.deleted, true, '本人删除成功');
  const afterDel = await call('GET', '/', tokenA);
  assert.equal(afterDel.json.items!.length, 0, '删除后 GET 不再返回');
  console.log('✅ 4 全链路:resolve 成功→幂等→物理删干净');
}

// 5. POST 校验拒绝:坏 type / 超长 content / 空 content / promise subject 非法;其余类型 subject 忽略
{
  const badType = await call('POST', '/', tokenA, { type: 'secret', content: '不该进来' });
  assert.equal(badType.status, 400);
  assert.equal(badType.json.error, 'bad_request');
  const tooLong = await call('POST', '/', tokenA, { type: 'event', content: '长'.repeat(61) });
  assert.equal(tooLong.status, 400, 'content 61 字拒绝');
  const empty = await call('POST', '/', tokenA, { type: 'event', content: '   ' });
  assert.equal(empty.status, 400, 'content trim 后为空拒绝');
  const badSubject = await call('POST', '/', tokenA, { type: 'promise', content: '约定', subject: 'stranger' });
  assert.equal(badSubject.status, 400, 'promise subject 非 xiaoke/child 拒绝');
  const notJson = await call('POST', '/', tokenA);
  assert.equal(notJson.status, 400, '非 JSON body 拒绝');
  const ignoreSubject = await call('POST', '/', tokenA, { type: 'event', content: '去了海洋馆', subject: '随便填' });
  assert.equal(ignoreSubject.json.added, 1);
  const get = await call('GET', '/', tokenA);
  assert.equal(get.json.items![0].subject, '', '非 promise/relation 的 subject 忽略传空');
  console.log('✅ 5 POST 校验:坏 type/超长/空/非法 subject 全拒,event subject 归一为空');
}

// 6. GET 过滤 retracted(淘汰条目不给面板;admin 端点不受影响)
{
  memoryItemStore.addItems(ACCT_A, [{ type: 'preference', content: '喜欢白鲸' }]);
  const { items } = memoryItemStore.listByAccount(ACCT_A);
  const pref = items.find((i) => i.content === '喜欢白鲸')!;
  memoryItemStore.retract(ACCT_A, pref.id);
  const get = await call('GET', '/', tokenA);
  assert.ok(!get.json.items!.some((i) => i.id === pref.id), '面板 GET 不含 retracted');
  assert.ok(
    memoryItemStore.listByAccount(ACCT_A).items.some((i) => i.id === pref.id),
    'store 全量(admin 用)仍保留审计',
  );
  console.log('✅ 6 GET 过滤 retracted,admin 全量不受影响');
}

// 7. 兴趣删除 + profile 隐私四字段(红线:不泄漏 personality_notes 等内部字段)
{
  profileStore.upsertProfile(ACCT_A, { nickname: '天天', birthday: '2019-01', gender: '男孩' });
  profileStore.updateMemoryFields(ACCT_A, {
    personality_notes: '内部观察不许外泄',
    interests: [
      { value: '恐龙', confidence: 0.9, last_updated: Date.now(), source: 'voice' },
      { value: '奥特曼', confidence: 0.8, last_updated: Date.now(), source: 'voice' },
    ],
  });
  const get = await call('GET', '/', tokenA);
  const profile = get.json.profile as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(profile).sort(),
    ['birthday', 'gender', 'interests', 'nickname'],
    'profile 只回四字段',
  );
  const interests = profile.interests as Array<Record<string, unknown>>;
  assert.equal(interests.length, 2);
  assert.deepEqual(Object.keys(interests[0]), ['value', 'state', 'evidence'], 'interests 元素只留 value/state/evidence,裁掉 confidence/source');
  const del = await call('DELETE', `/interest/${encodeURIComponent('恐龙')}`, tokenA);
  assert.equal(del.json.removed, true, 'URL 编码中文兴趣删除成功');
  const after = await call('GET', '/', tokenA);
  const left = (after.json.profile as { interests: Array<{ value: string }> }).interests;
  assert.deepEqual(left.map((i) => i.value), ['奥特曼'], '只删指定项');
  const again = await call('DELETE', `/interest/${encodeURIComponent('恐龙')}`, tokenA);
  assert.equal(again.json.removed, false, '重复删除返回 false');
  console.log('✅ 7 兴趣删除 + profile 隐私四字段红线');
}

// 8. 无档案账号:GET profile=null(不影响 items 返回)
{
  const get = await call('GET', '/', tokenB);
  assert.equal(get.json.profile, null, '无档案 profile=null');
  assert.deepEqual(get.json.items, [], 'B 账号无条目');
  console.log('✅ 8 无档案账号 profile=null');
}

// 清理临时 DB
rmSync(tmpDir, { recursive: true, force: true });
console.log('🎉 memory-api 8/8 全过(独立临时 DB 已清理)');
