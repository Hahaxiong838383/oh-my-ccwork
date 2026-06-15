import { Hono } from 'hono';
import { z } from 'zod';
import { profileStore } from '../profile-store.js';
import { verifyAuthToken } from '../auth-jwt.js';

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

export { profileRoute };
