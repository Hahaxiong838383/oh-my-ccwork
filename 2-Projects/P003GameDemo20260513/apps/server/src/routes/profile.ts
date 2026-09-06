import { Hono } from 'hono';
import { z } from 'zod';
import { profileStore } from '../profile-store.js';
import { verifyAuthToken } from '../auth-jwt.js';
import { deviceRegistryStore } from '../device-registry-store.js';
import { validateDeviceSn } from '../device-sn.js';
import { accountStore } from '../account-store.js';
import { kickoffLocalAudioOnce } from '../local-audio-generator.js';

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

/**
 * SN 绑定核心序列（bind-sn 路由与配网 claim 共用，联调合同 v3 §2.3）：
 * 防抢绑 → 家长关联 → brain 自动开通 → 档案同步。调用方负责 SN 格式校验与大写化。
 * 返回结构化结果，两个入口各自映射 HTTP 错误码（bind-sn: 404/409；claim: 403/409）。
 */
export function performSnBinding(
  parentAccountId: string,
  sn: string,
):
  | { ok: true; brainAccountId: string; syncedProfile: boolean; alreadyBound: boolean }
  | { ok: false; error: 'sn_not_available' | 'sn_taken' } {
  const device = deviceRegistryStore.get(sn);
  if (!device || device.status !== 'active') return { ok: false, error: 'sn_not_available' };
  if (device.parent_account_id && device.parent_account_id !== parentAccountId) {
    return { ok: false, error: 'sn_taken' };
  }
  const alreadyBound = device.parent_account_id === parentAccountId; // 同家长重绑（幂等语义，v3 矩阵第 4 行）
  deviceRegistryStore.setParentAccountId(sn, parentAccountId);
  // 绑定即接入大脑：未开通 brain 的设备自动开通（建 device 账号 + 关联 + 建档）
  let brainAccountId = device.account_id;
  if (!brainAccountId) {
    brainAccountId = accountStore.createDeviceAccount(sn, device.note).id;
    deviceRegistryStore.setAccountId(sn, brainAccountId);
  }
  // 建档下发：设备账号无档 → 从家长档同步；家长也无档 → 空档兜底
  let syncedProfile = false;
  if (brainAccountId && !profileStore.getProfile(brainAccountId)) {
    syncedProfile = Boolean(profileStore.copyProfile(parentAccountId, brainAccountId));
    if (!syncedProfile) profileStore.upsertProfile(brainAccountId, { nickname: '', birthday: '', gender: '' });
  }
  // 绑定即生成（2026-09-06）：配网 claim / 短信 bind-sn 两条绑定路都从这里进，与 admin 开通 brain 共用同一入口（并发去重）
  if (brainAccountId) {
    const k = kickoffLocalAudioOnce(brainAccountId, 'sn-binding');
    if (k !== 'started') console.log(`[local-audio] kickoff ${k} account=${brainAccountId} reason=sn-binding`);
  }
  return { ok: true, brainAccountId, syncedProfile, alreadyBound };
}

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
  const accountId = c.get('accountId');
  // 核心序列抽为 performSnBinding（与配网 claim 共用）；本路由保持原响应口径不变
  const r = performSnBinding(accountId, sn);
  if (!r.ok) {
    if (r.error === 'sn_not_available') {
      // 不在台账/已停用统一一种口径（不区分暴露台账内容）
      return c.json({ ok: false, error: 'sn_not_available', message: '设备不存在或未激活' }, 404);
    }
    return c.json({ ok: false, error: 'sn_taken', message: '该设备已被其他账号绑定' }, 409);
  }
  console.log(`[profile] bind-sn account=${accountId} sn=${sn} brain=${r.brainAccountId} synced_profile=${r.syncedProfile}`);
  return c.json({ ok: true, sn, brain_opened: Boolean(r.brainAccountId), synced_profile: r.syncedProfile });
});

// 当前家长账号绑定的硬件设备列表（小程序「我的设备」）
profileRoute.get('/bound-devices', (c) => {
  const rows = deviceRegistryStore.listByParentAccountId(c.get('accountId'));
  return c.json({
    ok: true,
    devices: rows.map((d) => ({
      sn: d.sn,
      public_id: d.public_id, // 遥测家长查询路由用（H5 路由零 SN，合同 §9）
      note: d.note,
      status: d.status,
      brain_opened: Boolean(d.account_id),
    })),
  });
});

export { profileRoute };
