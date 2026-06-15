import { SignJWT } from 'jose';
import { Hono } from 'hono';
import { accountStore } from '../account-store.js';

const JWT_ISSUER = 'p003';
const JWT_AUDIENCE = 'kidshub';
const JWT_TTL = '7d';
const DEFAULT_AUTH_SECRET = 'dev-secret-change-me';

let warnedDefaultSecret = false;

export const inviteAuthRoute = new Hono();

inviteAuthRoute.post('/invite', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_code' }, 401);
  }

  const rec = (body ?? {}) as Record<string, unknown>;
  const code = typeof rec.code === 'string' ? rec.code.trim() : '';
  const inviteCode = code ? accountStore.findByCode(code) : null;
  if (!inviteCode) {
    return c.json({ error: 'invalid_code' }, 401);
  }

  const account = accountStore.findAccount(inviteCode.account_id);
  if (!account) {
    return c.json({ error: 'invalid_code' }, 401);
  }

  const rawSecret = process.env.AUTH_JWT_SECRET || DEFAULT_AUTH_SECRET;
  if (rawSecret === DEFAULT_AUTH_SECRET && !warnedDefaultSecret) {
    warnedDefaultSecret = true;
    console.warn('AUTH_JWT_SECRET is not set; using development JWT secret. Configure AUTH_JWT_SECRET in production.');
  }

  const secret = new TextEncoder().encode(rawSecret);
  const token = await new SignJWT({ accountId: account.id, role: 'parent' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setExpirationTime(JWT_TTL)
    .sign(secret);

  return c.json({ token, account: { id: account.id, nickname: account.nickname } });
});
