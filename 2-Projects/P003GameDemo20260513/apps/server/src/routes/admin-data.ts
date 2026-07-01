import { Hono } from 'hono';
import { accountStore } from '../account-store.js';
import { conversationStore } from '../conversation-store.js';
import { profileStore } from '../profile-store.js';
import { canWrite, isAdminRole, isValidToken } from './auth.js';
import { resetAllQuotas } from '../guard.js';

// hub 看板数据端点：admin 看所有账号的孩子档案 + 设备（admin token 鉴权，区别于 parent 自己的 /api/profile 邀请码 JWT）。
const adminDataRoute = new Hono();

adminDataRoute.use('*', async (c, next) => {
  const header = c.req.header('authorization');
  const token = header ? /^Bearer\s+(.+)$/i.exec(header.trim())?.[1] : undefined;
  if (!token || !isValidToken(token)) {
    return c.json({ ok: false, error: 'unauthorized' }, 401);
  }
  // 邀请码管理（/api/admin/invites 及 /invites/:code）= admin 专属：editor / guest 连查看（GET）都 403。
  // editor「除邀请码管理外与 admin 同权」的边界就落在这里（真防线；前端隐藏邀请码 tab 只是 UX）。
  if (/\/invites(?:\/|$)/.test(c.req.path) && !isAdminRole(token)) {
    return c.json({ ok: false, error: 'forbidden_invites', message: '无邀请码管理权限' }, 403);
  }
  // 只读门控（真防线）：guest 仅可 GET（查看）；写操作（POST/DELETE/PATCH）需 admin/editor，否则 403。
  // 前端隐藏编辑按钮只是 UX，这里才是 guest 改不了数据的保证。
  if (c.req.method !== 'GET' && !canWrite(token)) {
    return c.json({ ok: false, error: 'forbidden_readonly', message: '游客账号只读，无编辑权限' }, 403);
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
    const stats = conversationStore.statsByAccount();
    const invites = accountStore.listCodes().map((invite) => {
      const account = accountStore.findAccount(invite.account_id);
      const profile = profileStore.getProfile(invite.account_id);
      const stat = stats[invite.account_id];
      return {
        code: invite.code,
        account_id: invite.account_id,
        account_nickname: account?.nickname ?? '',
        child_nickname: profile?.nickname ?? '',
        used_at: invite.used_at,
        conv_count: stat?.count ?? 0,
        token_sum: stat?.tokens ?? 0,
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

adminDataRoute.patch('/invites/:code', async (c) => {
  try {
    const code = c.req.param('code').trim();
    if (!code) return c.json({ ok: false, error: '邀请码不能为空' }, 400);
    const body = (await c.req.json().catch(() => ({}))) as { nickname?: unknown };
    const nickname = typeof body.nickname === 'string' ? body.nickname.trim() : '';
    if (!nickname) return c.json({ ok: false, error: '昵称不能为空' }, 400);

    const invite = accountStore.findByCode(code);
    if (!invite) return c.json({ ok: false, error: '邀请码不存在' }, 404);

    accountStore.updateNickname(invite.account_id, nickname);
    return c.json({ ok: true });
  } catch (error) {
    return c.json({ ok: false, error: '更新昵称失败，请稍后重试' }, 500);
  }
});

// admin 手动重置今日体验限额（内测自助，清空所有 IP 计数；鉴权走上面 use('*') 中间件）
adminDataRoute.post('/reset-quota', (c) => {
  try {
    const cleared = resetAllQuotas();
    return c.json({ ok: true, cleared });
  } catch (error) {
    return c.json({ ok: false, error: '重置限额失败，请稍后重试' }, 500);
  }
});

export { adminDataRoute };
