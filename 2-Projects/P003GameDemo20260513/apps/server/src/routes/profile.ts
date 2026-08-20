import { Hono } from 'hono';
import { z } from 'zod';
import { profileStore } from '../profile-store.js';
import { verifyAuthToken } from '../auth-jwt.js';
import { deviceRegistryStore } from '../device-registry-store.js';
import { validateDeviceSn } from '../device-sn.js';
import { accountStore } from '../account-store.js';

// 家长端建档 + 配网绑定 API。鉴权用邀请码登录 JWT（与 WS 鉴权同 verifyAuthToken），按 accountId 隔离。
const profileRoute = new Hono<{ Variables: { accountId: string } }>();

// 鉴权中间件：Authorization: Bearer <JWT> → accountId；无/无效 → 401（家长账号专用，非 admin token）
profileRoute.use('*', async (c, next) => {
  const header = c.req.header('authorization');
  const token = header ? /^Bearer\s+(.+)$/i.exec(header.trim())?.[1] : undefined;
  const auth = await verifyAuthToken(token);
  if (!auth) {
    return c.json({ ok: false, error: 'unauthorized' }, 401);
  }
  c.set('accountId', auth.accountId);
  await next();
});

const ProfileSchema = z.object({
  nickname: z.string().trim().min(1).max(20),
  birthday: z.string().trim().regex(/^(\d{4}-\d{2})?$/, 'birthday 须为 YYYY-MM 或空'),
  gender: z.string().trim().max(10),
});

const DeviceSchema = z.object({
  model: z.string().trim().max(60),
  name: z.string().trim().min(1).max(60),
});

// 建档（upsert）：孩子昵称 + 出生年月 + 性别
profileRoute.post('/', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'bad_request' }, 400);
  }
  const parsed = ProfileSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: 'bad_request' }, 400);
  }
  const profile = profileStore.upsertProfile(c.get('accountId'), parsed.data);
  return c.json({ ok: true, profile });
});

// 读当前账号的孩子档案（无则 profile=null）
profileRoute.get('/', (c) => {
  const profile = profileStore.getProfile(c.get('accountId'));
  return c.json({ ok: true, profile });
});

// 配网绑定设备：型号 + 设备名
profileRoute.post('/device', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'bad_request' }, 400);
  }
  const parsed = DeviceSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: 'bad_request' }, 400);
  }
  const device = profileStore.bindDevice(c.get('accountId'), parsed.data);
  return c.json({ ok: true, device });
});

// 读当前账号已绑定的设备（无则 device=null）
profileRoute.get('/device', (c) => {
  const device = profileStore.getDevice(c.get('accountId'));
  return c.json({ ok: true, device });
});

// ── 硬件设备（SN）绑定：家长账号 ↔ device_registry 关联（建档下发链，2026-08-19 预留）──
// 「设备 SN 就是邀请码」：家长在小程序输入/扫码 SN → 关联到自己账号 → 设备 brain 建档时
// 从家长档同步孩子信息。与 admin 手工绑定（/api/admin/devices/:sn/parent）写同一列。

const BindSnSchema = z.object({ sn: z.string().trim().min(1).max(30) });

profileRoute.post('/bind-sn', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'bad_request' }, 400);
  }
  const parsed = BindSnSchema.safeParse(body);
  if (!parsed.success) return c.json({ ok: false, error: 'bad_request' }, 400);
  const sn = parsed.data.sn.toUpperCase();
  if (!validateDeviceSn(sn).ok) return c.json({ ok: false, error: 'invalid_sn', message: 'SN 格式不正确' }, 400);
  const device = deviceRegistryStore.get(sn);
  if (!device || device.status !== 'active') {
    // 不在台账/已停用统一一种口径（不区分暴露台账内容）
    return c.json({ ok: false, error: 'sn_not_available', message: '设备不存在或未激活' }, 404);
  }
  const accountId = c.get('accountId');
  if (device.parent_account_id && device.parent_account_id !== accountId) {
    return c.json({ ok: false, error: 'sn_taken', message: '该设备已被其他账号绑定' }, 409);
  }
  deviceRegistryStore.setParentAccountId(sn, accountId);
  // 绑定即接入大脑（2026-08-20 配网即绑定 P0）：未开通 brain 的设备自动开通
  // （与 admin POST /devices/:sn/brain 同序列：建 device 账号 + 关联 + 建档），
  // 家长自助绑定后设备直接可记忆/认人，无需运营手工开通。
  let brainAccountId = device.account_id;
  if (!brainAccountId) {
    brainAccountId = accountStore.createDeviceAccount(sn, device.note).id;
    deviceRegistryStore.setAccountId(sn, brainAccountId);
  }
  // 建档下发：设备账号无档 → 从家长档同步；家长也无档 → 空档兜底（空档已足以激活记忆抽取）。
  let syncedProfile = false;
  if (brainAccountId && !profileStore.getProfile(brainAccountId)) {
    syncedProfile = Boolean(profileStore.copyProfile(accountId, brainAccountId));
    if (!syncedProfile) profileStore.upsertProfile(brainAccountId, { nickname: '', birthday: '', gender: '' });
  }
  console.log(`[profile] bind-sn account=${accountId} sn=${sn} brain=${brainAccountId} synced_profile=${syncedProfile}`);
  return c.json({ ok: true, sn, brain_opened: Boolean(brainAccountId), synced_profile: syncedProfile });
});

// 当前家长账号绑定的硬件设备列表（小程序「我的设备」）
profileRoute.get('/bound-devices', (c) => {
  const rows = deviceRegistryStore.listByParentAccountId(c.get('accountId'));
  return c.json({
    ok: true,
    devices: rows.map((d) => ({ sn: d.sn, note: d.note, status: d.status, brain_opened: Boolean(d.account_id) })),
  });
});

export { profileRoute };
