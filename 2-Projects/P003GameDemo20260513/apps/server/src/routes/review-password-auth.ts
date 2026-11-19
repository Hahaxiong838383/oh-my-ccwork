import { randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { issueVerifiedPhoneSession, parentSessionSecret } from '../parent-phone-session.js';

const phonePattern = /^1[3-9]\d{9}$/;
const credentials = z.object({
  phone: z.string().trim().regex(phonePattern),
  password: z.string().min(1).max(256),
}).strict();
const route = new Hono<{ Variables: { requestId: string } }>();

// Bound both online guesses and the number of simultaneous memory-intensive scrypt calls.
const perIp = new Map<string, number>();
let resetAt = 0, attempts = 0, inFlight = 0;
function retryAfter(ip: string): number {
  const now = Date.now();
  if (now >= resetAt) {
    resetAt = now + 60_000;
    perIp.clear();
    attempts = 0;
  }
  if (inFlight >= 2) return 1;
  const count = perIp.get(ip) ?? 0;
  if (count >= 8 || attempts >= 60) return Math.max(1, Math.ceil((resetAt - now) / 1000));
  perIp.set(ip, count + 1);
  attempts++;
  return 0;
}

route.use('/password/login', async (c, next) => {
  c.set('requestId', 'pwdreq-' + randomUUID());
  c.header('Cache-Control', 'no-store');
  await next();
});
route.use('/password/login', bodyLimit({ maxSize: 4096, onError: c => c.json({
  ok: false, error: 'bad_request', message: '请求格式不正确', request_id: c.get('requestId'),
}, 400) }));
route.post('/password/login', async c => {
  const requestId = c.get('requestId');
  const parsed = credentials.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ ok: false, error: 'bad_request', message: '手机号或密码格式不正确', request_id: requestId }, 400);

  const reviewPhone = process.env.PARENT_REVIEW_PHONE ?? '';
  const verifier = /^([0-9a-f]{32}):([0-9a-f]{128})$/.exec(process.env.PARENT_REVIEW_PASSWORD_HASH ?? '');
  let secret: string;
  try {
    secret = parentSessionSecret();
    if (!phonePattern.test(reviewPhone) || !verifier) throw new Error('review_not_configured');
  } catch {
    return c.json({ ok: false, error: 'password_login_unavailable', message: '密码登录暂未就绪', request_id: requestId }, 503);
  }
  const sourceIp = c.req.header('x-real-ip') ?? '';
  const wait = retryAfter(isIP(sourceIp) ? sourceIp : 'unknown');
  if (wait) return c.json({ ok: false, error: 'rate_limited', message: '登录频繁，请稍后再试', retry_after_s: wait, request_id: requestId }, 429, { 'Retry-After': String(wait) });

  const { phone, password } = parsed.data;
  inFlight++;
  try {
    const salt = Buffer.from(verifier[1], 'hex'), expected = Buffer.from(verifier[2], 'hex');
    const actual = await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
        (error, key) => error ? reject(error) : resolve(key));
    });
    if (!timingSafeEqual(expected, actual) || phone !== reviewPhone) {
      return c.json({ ok: false, error: 'invalid_credentials', message: '手机号或密码错误', request_id: requestId }, 401);
    }
    return c.json(await issueVerifiedPhoneSession(phone, secret, requestId));
  } catch {
    console.error(`[review-password-auth] login_failed request=${requestId}`);
    return c.json({ ok: false, error: 'account_login_failed', message: '登录暂未完成，请稍后再试', request_id: requestId }, 500);
  } finally {
    inFlight--;
  }
});
export const reviewPasswordAuthRoute = route;
