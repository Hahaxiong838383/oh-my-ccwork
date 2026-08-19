/**
 * 租户隔离白盒单测：GET /devices/:sn/isolation 五跳真值/身份路由自检/邻居对照/门控/不泄 key。
 * 跑法：cd apps/server && NODE_OPTIONS=--experimental-sqlite npx tsx scripts/isolation.test.ts
 * 隔离：devices/accounts/profile(含 memory_item)/conversation 四库全部指向临时路径，绝不碰生产库。
 */
import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { Hono } from 'hono';

const TMP = '/private/tmp/claude-501/-Users-rayman-chen-mycc/410a354a-ee50-4c8b-9b06-02a639743e97/scratchpad';
for (const f of ['iso-devices.db', 'iso-accounts.db', 'iso-profile.db', 'iso-conversation.db']) {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(`${TMP}/${f}${suffix}`);
    } catch {
      /* 不存在即干净 */
    }
  }
}

process.env.DEVICES_DB_PATH = `${TMP}/iso-devices.db`;
process.env.ACCOUNTS_DB_PATH = `${TMP}/iso-accounts.db`;
process.env.PROFILE_DB_PATH = `${TMP}/iso-profile.db`;
process.env.CONVERSATION_DB_PATH = `${TMP}/iso-conversation.db`;
process.env.AUTH_JWT_SECRET = 'test-auth-secret';
process.env.STUDIO_USER = 'test-admin';
process.env.STUDIO_PASS = 'test-pass';
process.env.LLM_PROVIDER = 'race';
process.env.DEEPSEEK_API_KEY = 'sk-test-deepseek-key-0000';
delete process.env.DEVICE_SN_ALLOW;

const { deviceRegistryStore } = await import('../src/device-registry-store.js');
const { memoryItemStore } = await import('../src/memory-item-store.js');
const { conversationStore } = await import('../src/conversation-store.js');
const { accountStore } = await import('../src/account-store.js');
const { extractLlmStore } = await import('../src/extract-llm-store.js');
const { adminDataRoute } = await import('../src/routes/admin-data.js');
const { authRoute } = await import('../src/routes/auth.js');

const SN = 'BJP00326060100200077';

const app = new Hono();
app.route('/api/auth', authRoute);
app.route('/api/admin', adminDataRoute);

async function req(token: string, method: string, path: string, body?: unknown): Promise<Response> {
  return app.request(`/api/admin${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

let pass = 0;
let fail = 0;
async function t(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    pass++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}: ${(e as Error).message}`);
  }
}

const adminToken = (
  (await (
    await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'test-admin', password: 'test-pass' }),
    })
  ).json()) as { token: string }
).token;
const guestToken = (
  (await (
    await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'guest', password: '123456' }),
    })
  ).json()) as { token: string }
).token;
assert.ok(adminToken && guestToken, '登录失败');

type IsoView = {
  ok: boolean;
  bound: boolean;
  chain: {
    access: Record<string, any>;
    identity: Record<string, any>;
    prompt: Array<Record<string, any>>;
    data: Record<string, any>;
    llm: Record<string, any>;
  };
  config_matrix: Array<Record<string, string>>;
};

await t('I1 门控：guest 读 isolation 403（devices 前缀 admin 专属）', async () => {
  deviceRegistryStore.add(SN, '隔离测试机');
  assert.equal((await req(guestToken, 'GET', `/devices/${SN}/isolation`)).status, 403);
});

await t('I2 台账外设备 404', async () => {
  assert.equal((await req(adminToken, 'GET', '/devices/BJP00326060100299999/isolation')).status, 404);
});

await t('I3 未开通：bound=false + 身份路由必须匿名（match=true）+ 接入判定 db_active', async () => {
  const r = await req(adminToken, 'GET', `/devices/${SN}/isolation`);
  assert.equal(r.status, 200);
  const j = (await r.json()) as IsoView;
  assert.equal(j.bound, false);
  assert.equal(j.chain.access.sn_valid, true);
  assert.equal(j.chain.access.allow_source, 'db_active');
  assert.equal(j.chain.identity.resolved_account, null, '未开通必须匿名，绝不串到 token 兜底账号');
  assert.equal(j.chain.identity.match, true);
  assert.equal(j.chain.prompt.length, 0);
});

let accountId = '';
await t('I4 开通后：身份路由自检 resolved==registry 且 ≠ probe token 身份；prompt 四层齐', async () => {
  const open = await req(adminToken, 'POST', `/devices/${SN}/brain`, {});
  assert.equal(open.status, 200);
  accountId = ((await open.json()) as { account_id: string }).account_id;
  const j = (await (await req(adminToken, 'GET', `/devices/${SN}/isolation`)).json()) as IsoView;
  assert.equal(j.bound, true);
  assert.equal(j.chain.identity.resolved_account, accountId);
  assert.equal(j.chain.identity.registry_account, accountId);
  assert.notEqual(j.chain.identity.resolved_account, j.chain.identity.probe_token_account, 'token 身份必须被丢弃');
  assert.equal(j.chain.identity.resolved_role, 'device');
  assert.equal(j.chain.identity.match, true);
  const keys = j.chain.prompt.map((l) => l.key);
  assert.deepEqual(keys, ['worldview', 'safety', 'memory', 'addendum']);
  const safety = j.chain.prompt.find((l) => l.key === 'safety')!;
  assert.equal(safety.editable, false, '安全基座必须不可编辑');
});

let neighborId = '';
await t('I5 邻居对照：本账号 2 条 vs 邻居 3 条，mine/global/accounts 三数对撞', async () => {
  // 邻居必须是账号表里的真账号——否则它本身就是孤儿，会把 O 组不变量检查搅红
  neighborId = accountStore.createInvite('隔离测试邻居').account_id;
  const n1 = memoryItemStore.addItems(accountId, [
    { type: 'preference', content: '喜欢恐龙', confidence: 0.9, source: 'test' },
    { type: 'event', content: '今天搭了积木塔', confidence: 0.9, source: 'test' },
  ] as any);
  const n2 = memoryItemStore.addItems(neighborId, [
    { type: 'preference', content: '喜欢画画', confidence: 0.9, source: 'test' },
    { type: 'preference', content: '喜欢唱歌', confidence: 0.9, source: 'test' },
    { type: 'event', content: '昨天去了动物园', confidence: 0.9, source: 'test' },
  ] as any);
  assert.equal(n1 + n2, 5, '预置写入必须全部成功（锚：期望非零）');
  conversationStore.add({ account_id: accountId, session_id: 'iso-test', role: 'user', text: '你好' });
  conversationStore.add({ account_id: neighborId, session_id: 'iso-test', role: 'user', text: '邻居消息' });

  const j = (await (await req(adminToken, 'GET', `/devices/${SN}/isolation`)).json()) as IsoView;
  assert.equal(j.chain.data.memory_mine_active, 2);
  assert.equal(j.chain.data.memory_global_active, 5);
  assert.equal(j.chain.data.memory_accounts, 2);
  assert.equal(j.chain.data.conversation_mine, 1);
  assert.equal(j.chain.data.conversation_global, 2);
  // 数据边界实证：邻居账号查不到本设备内容（store 层 account_id 谓词）
  const neighborItems = memoryItemStore.listByAccount(neighborId).items.map((it) => it.content);
  assert.ok(!neighborItems.includes('喜欢恐龙'), '邻居账号读到了本设备记忆=隔离破了');
});

await t('I6 disabled 设备：allow_source=db_disabled（DB 压制 env）', async () => {
  deviceRegistryStore.setStatus(SN, 'disabled');
  const j = (await (await req(adminToken, 'GET', `/devices/${SN}/isolation`)).json()) as IsoView;
  assert.equal(j.chain.access.allow_source, 'db_disabled');
  deviceRegistryStore.setStatus(SN, 'active');
});

await t('I7 不泄 key：配置抽取 LLM 后响应全文无原文，掩码只见尾 4 位', async () => {
  extractLlmStore.set({ provider: 'volc-ark', base_url: '', model: 'doubao-x', api_key: 'ak-secret-key-9876' });
  const j = (await (await req(adminToken, 'GET', `/devices/${SN}/isolation`)).json()) as IsoView;
  assert.ok(!JSON.stringify(j).includes('ak-secret-key-9876'), '响应泄露了 key 原文');
  assert.equal(j.chain.llm.extract.api_key_masked, '****9876');
  assert.equal(j.chain.llm.extract.source, 'admin');
  extractLlmStore.clear();
});

await t('I8 配置矩阵：安全基座「不可编辑」+ 抽取 LLM「热生效」+ 主对话 race 显性化', async () => {
  const j = (await (await req(adminToken, 'GET', `/devices/${SN}/isolation`)).json()) as IsoView;
  const safety = j.config_matrix.find((r) => r.item === 'AI 安全基座');
  assert.ok(safety && safety.effect!.includes('不可编辑'), '矩阵缺安全基座锁定行');
  const exRow = j.config_matrix.find((r) => r.item === '记忆抽取 LLM');
  assert.equal(exRow?.effect, '热生效');
  assert.ok(j.chain.llm.chat_provider.includes('race'), '主对话 provider 判定路径未显性化');
});

// ═══ O 组：全局隔离总览 /isolation-overview ═══

type Overview = {
  ok: boolean;
  tenants: Array<Record<string, any>>;
  invariants: Array<{ key: string; label: string; checked: number; violations: number; detail: string }>;
  coverage: Record<string, any>;
  traffic_24h: Record<string, number>;
  llm: Record<string, any>;
  safety: Record<string, any>;
};
const inv = (o: Overview, key: string) => o.invariants.find((i) => i.key === key)!;

await t('O1 门控：guest 读 overview 403', async () => {
  assert.equal((await req(guestToken, 'GET', '/isolation-overview')).status, 403);
});

await t('O2 租户矩阵：每台一行，逐台现场路由自检全过', async () => {
  const o = (await (await req(adminToken, 'GET', '/isolation-overview')).json()) as Overview;
  assert.ok(o.tenants.length >= 1, '至少含测试设备');
  const me = o.tenants.find((tn) => tn.sn === SN)!;
  assert.equal(me.account_id, accountId);
  assert.equal(me.route_match, true);
  assert.equal(me.profile_exists, true);
  assert.equal(me.memory_active, 2);
  assert.equal(me.conversation_count, 1);
  for (const tn of o.tenants) assert.equal(tn.route_match, true, `设备 ${tn.sn} 路由自检失败`);
});

await t('O3 不变量：violations 全 0 且 checked 锚非零（0/0 是没执行不是通过）', async () => {
  const o = (await (await req(adminToken, 'GET', '/isolation-overview')).json()) as Overview;
  assert.equal(o.invariants.length, 4);
  for (const i of o.invariants) assert.equal(i.violations, 0, `${i.key}: ${i.detail}`);
  assert.ok(inv(o, 'unique_binding').checked >= 1, 'unique_binding 没检查任何绑定');
  assert.ok(inv(o, 'no_orphan_memory').checked >= 2, '孤儿检查应覆盖 2 个账号');
});

await t('O4 负向锚：制造双绑违例 → checker 必须变红且点名', async () => {
  const SN2 = 'BJP00326060100200078';
  deviceRegistryStore.add(SN2, '双绑违例注入');
  deviceRegistryStore.setAccountId(SN2, accountId); // 两台共绑同一账号
  const o = (await (await req(adminToken, 'GET', '/isolation-overview')).json()) as Overview;
  const u = inv(o, 'unique_binding');
  assert.equal(u.violations, 1, '双绑没被检出=checker 是恒绿摆设');
  assert.ok(u.detail.includes(SN) && u.detail.includes(SN2), '违例明细必须点名两台 SN');
  const naming = inv(o, 'device_account_naming');
  assert.ok(naming.violations >= 1, `SN2 绑 device-${SN} 命名不一致也该检出`);
  deviceRegistryStore.setAccountId(SN2, null); // 恢复现场
});

await t('O5 负向锚：注入孤儿记忆 → no_orphan_memory 变红', async () => {
  memoryItemStore.addItems('acct-ghost-404', [
    { type: 'preference', content: '孤儿数据探针', confidence: 0.9, source: 'test' },
  ] as any);
  const o = (await (await req(adminToken, 'GET', '/isolation-overview')).json()) as Overview;
  const i = inv(o, 'no_orphan_memory');
  assert.equal(i.violations, 1, '孤儿账号没被检出');
  assert.ok(i.detail.includes('acct-ghost-404'));
  memoryItemStore.deleteByAccountId('acct-ghost-404'); // 恢复现场
  const o2 = (await (await req(adminToken, 'GET', '/isolation-overview')).json()) as Overview;
  assert.equal(inv(o2, 'no_orphan_memory').violations, 0, '清理后应回绿');
});

await t('O6 覆盖面：env 独有 SN 与 disabled 压制 env 都被点名', async () => {
  process.env.DEVICE_SN_ALLOW = `${SN},BJP00326060100200099`;
  deviceRegistryStore.setStatus(SN, 'disabled');
  const o = (await (await req(adminToken, 'GET', '/isolation-overview')).json()) as Overview;
  assert.deepEqual(o.coverage.env_only_sns, ['BJP00326060100200099']);
  assert.deepEqual(o.coverage.db_disabled_suppressing_env, [SN]);
  deviceRegistryStore.setStatus(SN, 'active');
  delete process.env.DEVICE_SN_ALLOW;
});

await t('O7 可靠性与安全区：traffic 结构齐 + 不泄 key + 安全基座字数非零', async () => {
  const o = (await (await req(adminToken, 'GET', '/isolation-overview')).json()) as Overview;
  for (const k of ['ok', 'rejected_403', 'rejected_429', 'prefetch', 'total']) {
    assert.ok(typeof o.traffic_24h[k] === 'number', `traffic_24h 缺 ${k}`);
  }
  assert.ok(o.safety.baseline_chars > 0);
  assert.ok(!JSON.stringify(o).includes('sk-test-deepseek-key-0000'), 'overview 泄露了 env key');
});

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
