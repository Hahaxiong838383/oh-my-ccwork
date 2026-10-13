/**
 * Worker Brain 单测：设备↔brain 账号开通/幂等/聚合视图/prompt 预览/解绑/admin 加记忆/门控。
 * 跑法：cd apps/server && npx tsx scripts/device-brain.test.ts
 * 隔离：devices/accounts/profile 三库全部指向临时路径，绝不碰生产库。
 */
import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { Hono } from 'hono';

const TMP = '/private/tmp/claude-501/-Users-rayman-chen-mycc/410a354a-ee50-4c8b-9b06-02a639743e97/scratchpad';
for (const f of ['brain-devices.db', 'brain-accounts.db', 'brain-profile.db', 'brain-conversation.db']) {
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
process.env.CONVERSATION_DB_PATH = `${TMP}/brain-conversation.db`;
process.env.AUTH_JWT_SECRET = 'test-auth-secret';
process.env.STUDIO_USER = 'test-admin';
process.env.STUDIO_PASS = 'test-pass';

const { deviceRegistryStore } = await import('../src/device-registry-store.js');
const { memoryItemStore } = await import('../src/memory-item-store.js');
const { traitStore } = await import('../src/trait-store.js');
const { profileStore } = await import('../src/profile-store.js');
const { adminDataRoute } = await import('../src/routes/admin-data.js');
const { authRoute } = await import('../src/routes/auth.js');
const { profileRoute } = await import('../src/routes/profile.js');

const SN = 'BJP00326060100200011';

const app = new Hono();
app.route('/api/auth', authRoute);
app.route('/api/admin', adminDataRoute);
app.route('/api/profile', profileRoute); // J 组（bind-sn 预留接口）用；Hono matcher 构建后不可再挂，须在首个请求前

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
let accountId = '';

await t('G1 开通：自动建 device-<SN> 账号 + registry 落库 + 不再分发 brain_token（2026-08-20 取消）', async () => {
  const r = await adminReq(adminToken, 'POST', `/devices/${SN}/brain`, {});
  assert.equal(r.status, 200);
  const j = (await r.json()) as Record<string, any>;
  assert.equal(j.account_id, `device-${SN}`);
  assert.equal(j.brain_token, undefined, 'brain_token 分发已取消，响应不得再携带');
  accountId = j.account_id;
  assert.equal(deviceRegistryStore.get(SN)!.account_id, accountId);
});

await t('G2 幂等：重复开通同账号不重建', async () => {
  const r = await adminReq(adminToken, 'POST', `/devices/${SN}/brain`, {});
  const j = (await r.json()) as Record<string, any>;
  assert.equal(j.account_id, accountId);
});

await t('G2b 设备身份只能来自设备房：role=device 的 token 在非 sn- 房必须匿名（probe 污染堵洞）', async () => {
  const { resolveDeviceIdentity } = await import('../src/device-brain-prompt.js');
  const workerPass = { accountId: 'worker-service', role: 'device' };
  assert.equal(resolveDeviceIdentity(workerPass, 't1787000000'), null, 'probe 房不得落 token 身份');
  assert.equal(resolveDeviceIdentity(workerPass, undefined), null, '无房名同样匿名');
  // 对照：parent role 在非 sn- 房保持原身份（Web 体验台/家长端行为不变）
  const parent = { accountId: 'acct-p1', role: 'parent' };
  assert.deepEqual(resolveDeviceIdentity(parent, 't1787000000'), parent);
  // 对照：设备房里 token 身份照旧被 SN 路由覆盖（既有语义不变）
  assert.equal(resolveDeviceIdentity(workerPass, `sn-${SN}-123`)?.accountId, accountId);
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

await t('I3 非设备房语义（2026-08-20 收紧）：role=device 匿名（堵 probe 污染）；parent 原身份（Web 零影响）', async () => {
  // role=device（worker 通行证）：非 sn- 房一律匿名——旧行为会把 probe/测试页对话写进 token 账号
  assert.equal(resolveDeviceIdentity(WORKER_AUTH, 'my-web-room'), null);
  assert.equal(resolveDeviceIdentity(WORKER_AUTH, undefined), null);
  assert.equal(resolveDeviceIdentity(WORKER_AUTH, ''), null);
  // parent（体验台/家长端登录 token）：行为不变
  const parentAuth = { accountId: 'acct-web-1', role: 'parent' };
  assert.equal(resolveDeviceIdentity(parentAuth, 'my-web-room')?.accountId, 'acct-web-1');
  assert.equal(resolveDeviceIdentity(parentAuth, undefined)?.accountId, 'acct-web-1');
});

await t('I4 token 无效 → room 冒充无效（防公网伪造）', async () => {
  assert.equal(resolveDeviceIdentity(null, `sn-${SN}-1786980004`), null);
});

// ── J 组：自动建档 + 孩子档案编辑 + 家长关联（建档下发链）+ 小程序 bind-sn 预留（2026-08-19）──
const { SignJWT } = await import('jose');
const { accountStore } = await import('../src/account-store.js');

async function parentJwt(acctId: string): Promise<string> {
  return new SignJWT({ accountId: acctId, role: 'parent' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer('p003')
    .setAudience('kidshub')
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.AUTH_JWT_SECRET));
}
async function parentReq(jwt: string, method: string, path: string, body?: unknown): Promise<Response> {
  return app.request(`/api/profile${path}`, {
    method,
    headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

await t('J1 开通即自动建档（空档兜底）——记忆抽取的「没建档不抽」门解除', async () => {
  const SNJ = 'BJP00326060100200023';
  deviceRegistryStore.add(SNJ, 'J1 建档机');
  const res = await adminReq(adminToken, 'POST', `/devices/${SNJ}/brain`, {});
  assert.equal(res.status, 200);
  const profile = profileStore.getProfile(`device-${SNJ}`);
  assert.ok(profile, '开通后应有档案行（空档也算档）');
  assert.equal(profile!.nickname, '');
});

await t('J2d memory-whitebox：返回 extraction_log / inactive_items / ledger 三段', async () => {
  const SNJ = 'BJP00326060100200023';
  const res = await adminReq(adminToken, 'GET', `/devices/${SNJ}/memory-whitebox`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; extraction_log: unknown[]; inactive_items: unknown[]; ledger: unknown[] };
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.extraction_log) && Array.isArray(body.inactive_items) && Array.isArray(body.ledger));
});

await t('J2c trait-snapshots / trait-rollback：列表、退回、坏 day 400、无快照 404', async () => {
  const SNJ = 'BJP00326060100200023';
  const acct = `device-${SNJ}`;
  traitStore.applyDeltas(acct, [{ dim: 'playfulness', delta: 0.02, rule: 'mirror_playful', theory: 'social_mirror', note: 'x' }]);
  const day = traitStore.snapshotDaily(acct);
  const list = (await (await adminReq(adminToken, 'GET', `/devices/${SNJ}/trait-snapshots`)).json()) as { ok: boolean; snapshots: { day: string }[] };
  assert.equal(list.ok && list.snapshots.some((s) => s.day === day), true);
  assert.equal((await adminReq(adminToken, 'POST', `/devices/${SNJ}/trait-rollback`, { day: 'bad' })).status, 400);
  assert.equal((await adminReq(adminToken, 'POST', `/devices/${SNJ}/trait-rollback`, { day: '2000-01-01' })).status, 404);
  traitStore.applyDeltas(acct, [{ dim: 'storytelling', delta: 0.02, rule: 'reinforce_story_pos', theory: 'reinforcement', note: 'x' }]);
  const res = await adminReq(adminToken, 'POST', `/devices/${SNJ}/trait-rollback`, { day });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; moved: number };
  assert.equal(body.ok && body.moved >= 1, true);
});

await t('J2b interest-veto：否决后 state=retracted/parent，再提不升；空 value 400', async () => {
  const SNJ = 'BJP00326060100200023';
  profileStore.updateMemoryFields(`device-${SNJ}`, { interests: [{ value: '冷光', confidence: 0.5, last_updated: 1, source: 'voice', state: 'unverified', mention_days: ['2026-09-01'] }] });
  const bad = await adminReq(adminToken, 'POST', `/devices/${SNJ}/interest-veto`, { value: '' });
  assert.equal(bad.status, 400);
  const res = await adminReq(adminToken, 'POST', `/devices/${SNJ}/interest-veto`, { value: '冷光' });
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { vetoed: boolean }).vetoed, true);
  const it = profileStore.getProfile(`device-${SNJ}`)!.interests.find((i) => i.value === '冷光')!;
  assert.equal(it.state, 'retracted');
  assert.equal(it.retracted_by, 'parent');
  profileStore.updateMemoryFields(`device-${SNJ}`, { interests: [{ value: '冷光', confidence: 0.5, last_updated: 2, source: 'voice', state: 'unverified', mention_days: ['2026-09-02'] }] });
  assert.equal(profileStore.getProfile(`device-${SNJ}`)!.interests.find((i) => i.value === '冷光')!.state, 'retracted', '否决后再提不升');
  const agg = (await (await adminReq(adminToken, 'GET', `/devices/${SNJ}/brain`)).json()) as { profile: { interests: { value: string; state: string }[] } };
  assert.equal(agg.profile.interests.find((i) => i.value === '冷光')!.state, 'retracted', 'GET 聚合带 state');
});

await t('J2 child-profile 编辑：PATCH 部分更新 + 校验 + GET 聚合可见', async () => {
  const SNJ = 'BJP00326060100200023';
  const bad = await adminReq(adminToken, 'PATCH', `/devices/${SNJ}/child-profile`, { birthday: '2019/06' });
  assert.equal(bad.status, 400, '错误生日格式应 400');
  const res = await adminReq(adminToken, 'PATCH', `/devices/${SNJ}/child-profile`, { nickname: '朵朵', gender: '男', birthday: '2013-05' });
  assert.equal(res.status, 200);
  const agg = (await (await adminReq(adminToken, 'GET', `/devices/${SNJ}/brain`)).json()) as {
    profile: { nickname: string; gender: string } | null;
    parent_account_id: string | null;
    recent_conversation: unknown[];
  };
  assert.equal(agg.profile?.nickname, '朵朵');
  assert.equal(agg.profile?.gender, '男');
  assert.ok(Array.isArray(agg.recent_conversation), '聚合应带 recent_conversation 数组');
  assert.equal(agg.parent_account_id, null);
});

await t('J3 admin 绑家长 + 建档下发（存量无档设备场景）', async () => {
  const SNJ = 'BJP00326060100200027';
  deviceRegistryStore.add(SNJ, 'J3 存量机');
  await adminReq(adminToken, 'POST', `/devices/${SNJ}/brain`, {});
  profileStore.deleteByAccountId(`device-${SNJ}`); // 模拟存量：开通过但无档
  const inv = accountStore.createInvite();
  profileStore.upsertProfile(inv.account_id, { nickname: '小雨', birthday: '2018-09', gender: '女' });
  const res = await adminReq(adminToken, 'PATCH', `/devices/${SNJ}/parent`, { parent_account_id: inv.account_id });
  const data = (await res.json()) as { ok: boolean; synced_profile: boolean };
  assert.equal(data.synced_profile, true, '无档设备绑家长应同步建档');
  assert.equal(profileStore.getProfile(`device-${SNJ}`)?.nickname, '小雨');
  const bad = await adminReq(adminToken, 'PATCH', `/devices/${SNJ}/parent`, { parent_account_id: `device-${SNJ}` });
  assert.equal(bad.status, 400, '设备账号不可当家长');
});

await t('J4 先绑家长再开通 → 开通时直接从家长档建档', async () => {
  const SNJ = 'BJP00326060100200031';
  deviceRegistryStore.add(SNJ, 'J4 顺序机');
  const inv = accountStore.createInvite();
  profileStore.upsertProfile(inv.account_id, { nickname: '天天', birthday: '2017-01', gender: '男' });
  await adminReq(adminToken, 'PATCH', `/devices/${SNJ}/parent`, { parent_account_id: inv.account_id });
  await adminReq(adminToken, 'POST', `/devices/${SNJ}/brain`, {});
  assert.equal(profileStore.getProfile(`device-${SNJ}`)?.nickname, '天天', '开通建档应走家长档同步');
});

await t('J5 已有档不被家长绑定覆盖（运营台配置优先）', async () => {
  const SNJ = 'BJP00326060100200023'; // J2 已配「朵朵」
  const inv = accountStore.createInvite();
  profileStore.upsertProfile(inv.account_id, { nickname: '别人家孩子', birthday: '', gender: '女' });
  const res = await adminReq(adminToken, 'PATCH', `/devices/${SNJ}/parent`, { parent_account_id: inv.account_id });
  const data = (await res.json()) as { synced_profile: boolean };
  assert.equal(data.synced_profile, false, '已有档不应同步覆盖');
  assert.equal(profileStore.getProfile('device-BJP00326060100200023')?.nickname, '朵朵');
});

await t('J6 小程序 bind-sn：绑定/幂等/抢绑 409/bound-devices 列表', async () => {
  const SNJ = 'BJP00326060100200035';
  deviceRegistryStore.add(SNJ, 'J6 小程序机');
  const inv = accountStore.createInvite();
  const jwt = await parentJwt(inv.account_id);
  const r1 = await parentReq(jwt, 'POST', '/bind-sn', { sn: SNJ });
  assert.equal(r1.status, 200);
  assert.equal(deviceRegistryStore.get(SNJ)?.parent_account_id, inv.account_id);
  const r2 = await parentReq(jwt, 'POST', '/bind-sn', { sn: SNJ });
  assert.equal(r2.status, 200, '同账号重复绑定应幂等');
  const other = accountStore.createInvite();
  const r3 = await parentReq(await parentJwt(other.account_id), 'POST', '/bind-sn', { sn: SNJ });
  assert.equal(r3.status, 409, '他人抢绑应 409');
  const r4 = await parentReq(jwt, 'POST', '/bind-sn', { sn: 'BJP00326060100299999' });
  assert.equal(r4.status, 404, '台账外 SN 应 404');
  const list = (await (await parentReq(jwt, 'GET', '/bound-devices')).json()) as { devices: Array<{ sn: string }> };
  assert.equal(list.devices.length, 1);
  assert.equal(list.devices[0]!.sn, SNJ);
});

await t('J7 bind-sn 建档下发（设备已开通无档 → 家长档同步）', async () => {
  const SNJ = 'BJP00326060100200039';
  deviceRegistryStore.add(SNJ, 'J7 下发机');
  await adminReq(adminToken, 'POST', `/devices/${SNJ}/brain`, {});
  profileStore.deleteByAccountId(`device-${SNJ}`);
  const inv = accountStore.createInvite();
  profileStore.upsertProfile(inv.account_id, { nickname: '乐乐', birthday: '2016-12', gender: '男' });
  const res = await parentReq(await parentJwt(inv.account_id), 'POST', '/bind-sn', { sn: SNJ });
  const data = (await res.json()) as { synced_profile: boolean };
  assert.equal(data.synced_profile, true);
  assert.equal(profileStore.getProfile(`device-${SNJ}`)?.nickname, '乐乐');
});

await t('J8 门控：guest 改档案/绑家长 403（真防线在 server）', async () => {
  const res = await adminReq(guestToken, 'PATCH', '/devices/BJP00326060100200023/child-profile', { nickname: 'x' });
  assert.equal(res.status, 403);
  const res2 = await adminReq(guestToken, 'PATCH', '/devices/BJP00326060100200023/parent', { parent_account_id: null });
  assert.equal(res2.status, 403);
});

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
