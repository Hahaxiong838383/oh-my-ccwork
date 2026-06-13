import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';

/**
 * KidsHub-AI 工作台登录（demo 级）
 *
 * 凭据走 env（STUDIO_USER / STUDIO_PASS，放 .env.local 不入 git）。
 * token 存内存（重启失效），极简失败限流防爆破。
 */
const validTokens = new Set<string>();
const tokenUsers = new Map<string, string>();

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

authRoute.post('/login', async (c) => {
  const expectedUser = process.env.STUDIO_USER;
  const expectedPass = process.env.STUDIO_PASS;
  if (!expectedUser || !expectedPass) {
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

  if (username !== expectedUser || password !== expectedPass) {
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
  return c.json({ ok: true, token });
});

authRoute.get('/check', (c) => {
  const token = c.req.query('token') ?? '';
  if (token && isValidToken(token)) {
    return c.json({ ok: true });
  }
  return c.json({ ok: false }, 401);
});
