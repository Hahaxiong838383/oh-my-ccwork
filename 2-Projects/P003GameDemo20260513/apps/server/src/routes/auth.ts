import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';

/**
 * KidsHub-AI 工作台 / 运营台登录（demo 级）
 *
 * 三类账号：
 *  - admin：凭据走 env（STUDIO_USER / STUDIO_PASS，放 .env.local 不入 git）。全权限（读 + 写）。
 *  - editor：可编辑账号（clw1-5 等）。除「邀请码管理」外与 admin 同权（可读可写）。凭据走 env
 *    （STUDIO_EDITOR_USERS = 逗号分隔用户名 + STUDIO_EDITOR_PASS = 统一口令，放 .env.local 不入 git；
 *    未配置则不存在此类账号）。邀请码管理（/api/admin/invites）对 editor 一律 403，见 admin-data.ts。
 *  - guest：只读游客（查看所有内容，无任何编辑权）。凭据走 env 带默认值
 *    （STUDIO_GUEST_USER / STUDIO_GUEST_PASS，默认 guest / 123456 —— 公开只读门票，
 *    零配置即生效；想改或关闭就配 env，STUDIO_GUEST_USER='' 可禁用 guest）。
 *
 * token 存内存（重启失效），按 token 关联 role；写操作的真防线在各路由中间件
 * （admin-data / feedback / dev-items / themes 用 canWrite 门控，非 GET 且非 admin/editor 一律 403；
 * 邀请码端点额外用 isAdminRole 门控，editor/guest 连 GET 都 403），前端隐藏按钮只是 UX。
 */
const validTokens = new Set<string>();
const tokenUsers = new Map<string, string>();
const tokenRoles = new Map<string, Role>();

export type Role = 'admin' | 'editor' | 'guest';

let failCount = 0;
let lockedUntil = 0;
const FAIL_LIMIT = 10;
const LOCK_MS = 60_000;

export const authRoute = new Hono();

export function isValidToken(token: string): boolean {
  return validTokens.has(token);
}

export function getTokenUser(token: string): string | undefined {
  return tokenUsers.get(token);
}

export function getTokenRole(token: string): Role | undefined {
  return tokenRoles.get(token);
}

/** 可写角色门控（真防线）：admin 或 editor 可写；guest 只读。各路由非 GET 请求用它判断。 */
export function canWrite(token: string): boolean {
  const role = tokenRoles.get(token);
  return role === 'admin' || role === 'editor';
}

/** admin 专属能力门控（真防线）：仅 admin。用于邀请码管理等 editor 也不可触达的端点。 */
export function isAdminRole(token: string): boolean {
  return tokenRoles.get(token) === 'admin';
}

authRoute.post('/login', async (c) => {
  const adminUser = process.env.STUDIO_USER;
  const adminPass = process.env.STUDIO_PASS;
  // editor：可编辑账号（clw1-5 等），除邀请码管理外与 admin 同权。凭据走 env，未配置则不存在此类账号。
  // STUDIO_EDITOR_USERS = 逗号分隔用户名；STUDIO_EDITOR_PASS = 统一口令。
  const editorUsers = (process.env.STUDIO_EDITOR_USERS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const editorPass = process.env.STUDIO_EDITOR_PASS ?? '';
  // guest 默认 guest/123456（公开只读门票）；env 可覆盖，置空字符串可禁用。
  const guestUser = process.env.STUDIO_GUEST_USER ?? 'guest';
  const guestPass = process.env.STUDIO_GUEST_PASS ?? '123456';

  const adminConfigured = Boolean(adminUser && adminPass);
  const editorConfigured = editorUsers.length > 0 && Boolean(editorPass);
  const guestConfigured = Boolean(guestUser && guestPass);
  if (!adminConfigured && !editorConfigured && !guestConfigured) {
    return c.json({ ok: false, error: 'auth 未配置' }, 503);
  }

  if (Date.now() < lockedUntil) {
    return c.json({ ok: false, error: '尝试过于频繁，请稍后再试' }, 429);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: '请求格式错误' }, 400);
  }

  const rec = (body ?? {}) as Record<string, unknown>;
  const username = typeof rec.username === 'string' ? rec.username : '';
  const password = typeof rec.password === 'string' ? rec.password : '';

  let role: Role | null = null;
  if (adminConfigured && username === adminUser && password === adminPass) {
    role = 'admin';
  } else if (editorConfigured && editorUsers.includes(username) && password === editorPass) {
    role = 'editor';
  } else if (guestConfigured && username === guestUser && password === guestPass) {
    role = 'guest';
  }

  if (!role) {
    failCount += 1;
    if (failCount >= FAIL_LIMIT) {
      lockedUntil = Date.now() + LOCK_MS;
      failCount = 0;
    }
    return c.json({ ok: false, error: '账号或密码错误' }, 401);
  }

  failCount = 0;
  const token = randomBytes(24).toString('hex');
  validTokens.add(token);
  tokenUsers.set(token, username);
  tokenRoles.set(token, role);
  return c.json({ ok: true, token, role, username });
});

authRoute.get('/check', (c) => {
  const token = c.req.query('token') ?? '';
  if (token && isValidToken(token)) {
    return c.json({
      ok: true,
      role: getTokenRole(token) ?? 'guest',
      username: getTokenUser(token) ?? '',
    });
  }
  return c.json({ ok: false }, 401);
});
