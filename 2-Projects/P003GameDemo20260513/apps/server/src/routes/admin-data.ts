import { Hono } from 'hono';
import { accountStore } from '../account-store.js';
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

adminDataRoute.get('/invites', (c) => {
  try {
    const invites = accountStore.listCodes().map((invite) => {
      const account = accountStore.findAccount(invite.account_id);
      const profile = profileStore.getProfile(invite.account_id);
      return {
        code: invite.code,
        account_id: invite.account_id,
        account_nickname: account?.nickname ?? '',
        child_nickname: profile?.nickname ?? '',
        used_at: invite.used_at,
        created_at: invite.created_at,
      };
    });
    return c.json({ ok: true, invites, count: invites.length, limit: 15 });
  } catch (error) {
    return c.json({ ok: false, error: '拉取邀请码失败，请稍后重试' }, 500);
  }
});

adminDataRoute.post('/invites', (c) => {
  try {
    const invite = accountStore.createInvite();
    return c.json({ ok: true, invite });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message === 'invite_limit') {
      return c.json({ ok: false, error: '已达上限 15 个，请先删除部分邀请码' }, 400);
    }
    return c.json({ ok: false, error: '生成邀请码失败，请稍后重试' }, 500);
  }
});

adminDataRoute.delete('/invites/:code', (c) => {
  try {
    const code = c.req.param('code').trim();
    if (!code) return c.json({ ok: false, error: '邀请码不能为空' }, 400);

    const invite = accountStore.findByCode(code);
    if (!invite) return c.json({ ok: false, error: '邀请码不存在' }, 404);

    const deleted = accountStore.deleteInvite(code);
    if (!deleted) return c.json({ ok: false, error: '邀请码不存在' }, 404);
    profileStore.deleteByAccountId(invite.account_id);
    return c.json({ ok: true });
  } catch (error) {
    return c.json({ ok: false, error: '删除邀请码失败，请稍后重试' }, 500);
  }
});

export { adminDataRoute };
