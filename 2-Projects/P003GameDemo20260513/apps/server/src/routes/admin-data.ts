import { Hono } from 'hono';
import { profileStore } from '../profile-store.js';
import { isValidToken } from './auth.js';

// hub 看板数据端点：admin 看所有账号的孩子档案 + 设备（admin token 鉴权，区别于 parent 自己的 /api/profile 邀请码 JWT）。
const adminDataRoute = new Hono();

adminDataRoute.use('*', async (c, next) => {
  const header = c.req.header('authorization');
  const token = header ? /^Bearer\s+(.+)$/i.exec(header.trim())?.[1] : undefined;
  if (!token || !isValidToken(token)) {
    return c.json({ ok: false, error: 'unauthorized' }, 401);
  }
  await next();
});

// 列所有孩子档案 + 关联设备（按账号聚合）
adminDataRoute.get('/profiles', (c) => {
  const deviceByAccount = new Map(profileStore.listAllDevices().map((d) => [d.account_id, d]));
  const profiles = profileStore.listAllProfiles().map((p) => ({
    ...p,
    device: deviceByAccount.get(p.account_id) ?? null,
  }));
  return c.json({ ok: true, profiles });
});

export { adminDataRoute };
