/**
 * Worker Brain 单测：设备↔brain 账号开通/幂等/聚合视图/prompt 预览/解绑/admin 加记忆/门控。
 * 跑法：cd apps/server && npx tsx scripts/device-brain.test.ts
 * 隔离：devices/accounts/profile 三库全部指向临时路径，绝不碰生产库。
 */
import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { Hono } from 'hono';

const TMP = '/private/tmp/claude-501/-Users-rayman-chen-mycc/410a354a-ee50-4c8b-9b06-02a639743e97/scratchpad';
for (const f of ['brain-devices.db', 'brain-accounts.db', 'brain-profile.db']) {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(`${TMP}/${f}${suffix}`);
    } catch {
      /* 不存在即干净 */
    }
  }
}

process.env.DEVICES_DB_PATH = `${TMP}/brain-devices.db`;
process.env.ACCOUNTS_DB_PATH = `${TMP}/brain-accounts.db`;
process.env.PROFILE_DB_PATH = `${TMP}/brain-profile.db`;
process.env.AUTH_JWT_SECRET = 'test-auth-secret';
process.env.STUDIO_USER = 'test-admin';
process.env.STUDIO_PASS = 'test-pass';

const { deviceRegistryStore } = await import('../src/device-registry-store.js');
const { memoryItemStore } = await import('../src/memory-item-store.js');
const { profileStore } = await import('../src/profile-store.js');
const { verifyAuthToken } = await import('../src/auth-jwt.js');
const { adminDataRoute } = await import('../src/routes/admin-data.js');
const { authRoute } = await import('../src/routes/auth.js');

const SN = 'BJP00326060100200011';

const app = new Hono();
app.route('/api/auth', authRoute);
app.route('/api/admin', adminDataRoute);

async function adminReq(token: string, method: string, path: string, body?: unknown): Promise<Response> {
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

const adminLogin = await app.request('/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'test-admin', password: 'test-pass' }),
});
const adminToken = ((await adminLogin.json()) as { token: string }).token;
const guestLogin = await app.request('/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'guest', password: '123456' }),
});
const guestToken = ((await guestLogin.json()) as { token: string }).token;
assert.ok(adminToken && guestToken, '登录失败');

deviceRegistryStore.add(SN, '脑测试机');
let brainToken = '';
let accountId = '';

await t('G1 开通：自动建 device-<SN> 账号 + token 可验出身份 + registry 落库', async () => {
  const r = await adminReq(adminToken, 'POST', `/devices/${SN}/brain`, {});
  assert.equal(r.status, 200);
  const j = (await r.json()) as Record<string, any>;
  assert.equal(j.account_id, `device-${SN}`);
  assert.ok(j.brain_token);
  brainToken = j.brain_token;
  accountId = j.account_id;
  const auth = await verifyAuthToken(brainToken);
  assert.equal(auth?.accountId, accountId);
  assert.equal(auth?.role, 'device');
  assert.equal(deviceRegistryStore.get(SN)!.account_id, accountId);
});

await t('G2 幂等：重复开通同账号不重建，重签 token 身份一致', async () => {
  const r = await adminReq(adminToken, 'POST', `/devices/${SN}/brain`, {});
  const j = (await r.json()) as Record<string, any>;
  assert.equal(j.account_id, accountId);
  // 同秒重签 iat 相同 → JWT 可能逐字节相同（等值 token，无危害）；断言身份而非字节差异。
  const auth = await verifyAuthToken(j.brain_token);
  assert.equal(auth?.accountId, accountId);
});

await t('G3 聚合视图：画像 + 记忆 + prompt 预览含记忆内容', async () => {
  profileStore.upsertBasics(accountId, { nickname: '朵朵大', birthday: '2013-06', gender: '男' });
  const add = await adminReq(adminToken, 'POST', `/memory/${accountId}`, {
    type: 'preference',
    content: '不喜欢小可说太长的话',
  });
  assert.equal(add.status, 200);
  await adminReq(adminToken, 'POST', `/memory/${accountId}`, {
    type: 'event',
    content: '在Minecraft里建了个学校',
  });
  const r = await adminReq(adminToken, 'GET', `/devices/${SN}/brain`);
  assert.equal(r.status, 200);
  const j = (await r.json()) as Record<string, any>;
  assert.equal(j.bound, true);
  assert.equal(j.profile.nickname, '朵朵大');
  assert.ok(j.items.some((it: any) => it.type === 'preference' && it.content.includes('太长的话')));
  assert.ok(j.items.some((it: any) => it.type === 'event' && it.content.includes('Minecraft')));
  assert.ok(j.prompt_preview.includes('【关于这个孩子（长期记忆·数据）】'), '预览缺记忆区块');
  assert.ok(j.prompt_preview.includes('朵朵大'), '预览缺昵称');
  assert.ok(j.prompt_preview.includes('Minecraft'), '预览缺事件记忆');
});

await t('G4 admin 加记忆校验：非法 type 400 / 超长 400 / 账号不存在 404', async () => {
  assert.equal((await adminReq(adminToken, 'POST', `/memory/${accountId}`, { type: 'nope', content: 'x' })).status, 400);
  assert.equal(
    (await adminReq(adminToken, 'POST', `/memory/${accountId}`, { type: 'event', content: 'x'.repeat(61) })).status,
    400,
  );
  assert.equal((await adminReq(adminToken, 'POST', '/memory/acct-nope', { type: 'event', content: 'x' })).status, 404);
});

await t('G5 解绑：bound=false，账号与记忆保留，重绑恢复', async () => {
  const r = await adminReq(adminToken, 'DELETE', `/devices/${SN}/brain`);
  assert.equal(r.status, 200);
  const view = (await (await adminReq(adminToken, 'GET', `/devices/${SN}/brain`)).json()) as Record<string, any>;
  assert.equal(view.bound, false);
  assert.ok(memoryItemStore.listByAccount(accountId).items.length >= 2, '解绑后记忆被误删');
  const rebind = (await (
    await adminReq(adminToken, 'POST', `/devices/${SN}/brain`, { account_id: accountId })
  ).json()) as Record<string, any>;
  assert.equal(rebind.account_id, accountId);
  const view2 = (await (await adminReq(adminToken, 'GET', `/devices/${SN}/brain`)).json()) as Record<string, any>;
  assert.equal(view2.bound, true);
  assert.equal(view2.profile.nickname, '朵朵大');
});

await t('G6 绑定不存在账号 404；设备不在台账 404', async () => {
  assert.equal(
    (await adminReq(adminToken, 'POST', `/devices/${SN}/brain`, { account_id: 'acct-ghost' })).status,
    404,
  );
  assert.equal((await adminReq(adminToken, 'POST', '/devices/BJP00326060100299998/brain', {})).status, 404);
});

await t('G7 门控：guest 打 brain 端点 403', async () => {
  assert.equal((await adminReq(guestToken, 'GET', `/devices/${SN}/brain`)).status, 403);
  assert.equal((await adminReq(guestToken, 'POST', `/devices/${SN}/brain`, {})).status, 403);
});

await t('G8 记忆删除后预览同步消失（管理动作影响 prompt）', async () => {
  const view = (await (await adminReq(adminToken, 'GET', `/devices/${SN}/brain`)).json()) as Record<string, any>;
  const ev = view.items.find((it: any) => it.type === 'event' && it.content.includes('Minecraft'));
  assert.ok(ev, '前置事件缺失');
  const del = await adminReq(adminToken, 'DELETE', `/memory/${ev.id}`);
  assert.equal(del.status, 200);
  const view2 = (await (await adminReq(adminToken, 'GET', `/devices/${SN}/brain`)).json()) as Record<string, any>;
  assert.ok(!view2.prompt_preview.includes('Minecraft'), '删除后预览仍含该记忆');
});

// ═══ H. per-device prompt 配置（编辑/拼接可视化的数据层） ═══

const { getDevicePromptConfig, buildDeviceBase, deviceAddendum, buildDeviceLayers } = await import(
  '../src/device-brain-prompt.js'
);

await t('H1 世界观 override：layers 标注自定义 + final 含自定义不含默认开头', async () => {
  const r = await adminReq(adminToken, 'PUT', `/devices/${SN}/prompt-config`, {
    worldview_override: '你是测试专用人设小艾，来自单测星球。',
  });
  assert.equal(r.status, 200);
  const view = (await (await adminReq(adminToken, 'GET', `/devices/${SN}/brain`)).json()) as Record<string, any>;
  const wv = view.prompt_layers.find((l: any) => l.key === 'worldview');
  assert.ok(wv.source.includes('自定义'), 'source 未标注自定义');
  assert.ok(view.prompt_preview.includes('小艾'), 'final 缺自定义人设');
  assert.ok(!view.prompt_preview.includes('方舟数字伙伴'), 'final 仍含默认世界观正文');
  assert.equal(view.prompt_config.worldview_override.includes('小艾'), true);
});

await t('H2 附加规则：final 末尾追加 + 安全基座层恒在', async () => {
  await adminReq(adminToken, 'PUT', `/devices/${SN}/prompt-config`, {
    prompt_addendum: '【测试附加】每轮回复末尾加一颗星星。',
  });
  const view = (await (await adminReq(adminToken, 'GET', `/devices/${SN}/brain`)).json()) as Record<string, any>;
  assert.ok(view.prompt_preview.trimEnd().endsWith('每轮回复末尾加一颗星星。'), 'addendum 不在最末');
  const safety = view.prompt_layers.find((l: any) => l.key === 'safety');
  assert.ok(safety && safety.editable === false && safety.chars > 0, '安全基座层缺失或可编辑');
  assert.ok(view.prompt_preview.includes(safety.text.slice(0, 20)), '安全基座未进 final');
});

await t('H3 热路径同源：buildDeviceBase/deviceAddendum 与聚合端点完全一致', async () => {
  const cfg = getDevicePromptConfig(accountId);
  assert.ok(cfg, '反查配置为空');
  const base = buildDeviceBase(cfg);
  assert.ok(base.startsWith('你是测试专用人设小艾'), '热路径 base 未用 override');
  assert.equal(deviceAddendum(cfg), '【测试附加】每轮回复末尾加一颗星星。');
  const { final } = buildDeviceLayers({ accountId, role: 'device' });
  const view = (await (await adminReq(adminToken, 'GET', `/devices/${SN}/brain`)).json()) as Record<string, any>;
  assert.equal(final, view.prompt_preview, '分层 final 与端点 preview 不一致');
  assert.ok(final.startsWith(base), '热路径 base 不是 final 前缀（组装分叉）');
});

await t('H4 清空恢复默认 + 校验（超长 400 / 非字符串 400）', async () => {
  await adminReq(adminToken, 'PUT', `/devices/${SN}/prompt-config`, { worldview_override: '', prompt_addendum: '' });
  const view = (await (await adminReq(adminToken, 'GET', `/devices/${SN}/brain`)).json()) as Record<string, any>;
  assert.ok(view.prompt_layers.find((l: any) => l.key === 'worldview').source.includes('默认'), '未恢复默认');
  assert.ok(view.prompt_preview.includes('方舟'), '默认世界观未回归');
  assert.equal(
    (await adminReq(adminToken, 'PUT', `/devices/${SN}/prompt-config`, { worldview_override: 'x'.repeat(8001) })).status,
    400,
  );
  assert.equal(
    (await adminReq(adminToken, 'PUT', `/devices/${SN}/prompt-config`, { prompt_addendum: 123 })).status,
    400,
  );
});

await t('H5 非设备账号反查为 null（Web 家长零影响）', async () => {
  assert.equal(getDevicePromptConfig('acct-01'), null);
  assert.equal(deviceAddendum(null), '');
  assert.ok(buildDeviceBase(null).includes('方舟'), '匿名 base 应为默认世界观');
});

// ═══ I. per-device 身份路由（多设备防串号） ═══

const { resolveDeviceIdentity } = await import('../src/device-brain-prompt.js');
const WORKER_AUTH = { accountId, role: 'device' };

await t('I1 设备房 room → 该 SN 自己的 brain 账号（token 只当通行证）', async () => {
  const SN2 = 'BJP00326060100200015';
  deviceRegistryStore.add(SN2, '第二台设备');
  await adminReq(adminToken, 'POST', `/devices/${SN2}/brain`, {});
  const r = resolveDeviceIdentity(WORKER_AUTH, `sn-${SN2}-1786980000`);
  assert.equal(r?.accountId, `device-${SN2}`, '未路由到第二台设备自己的账号');
  const r2 = resolveDeviceIdentity(WORKER_AUTH, `sn-${SN}-1786980001`);
  assert.equal(r2?.accountId, accountId, '第一台设备路由错');
});

await t('I2 未开通 brain 的 SN → 匿名（绝不串到 token 兜底账号）', async () => {
  const SN3 = 'BJP00326060100200019';
  deviceRegistryStore.add(SN3, '未开通 brain 的设备');
  assert.equal(resolveDeviceIdentity(WORKER_AUTH, `sn-${SN3}-1786980002`), null);
  assert.equal(resolveDeviceIdentity(WORKER_AUTH, 'sn-BJP00326060100299997-1786980003'), null, '台账外 SN 应匿名');
});

await t('I3 非设备房 room / 无 room → 原 token 身份（Web 零影响）', async () => {
  assert.equal(resolveDeviceIdentity(WORKER_AUTH, 'my-web-room')?.accountId, accountId);
  assert.equal(resolveDeviceIdentity(WORKER_AUTH, undefined)?.accountId, accountId);
  assert.equal(resolveDeviceIdentity(WORKER_AUTH, '')?.accountId, accountId);
});

await t('I4 token 无效 → room 冒充无效（防公网伪造）', async () => {
  assert.equal(resolveDeviceIdentity(null, `sn-${SN}-1786980004`), null);
});

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
