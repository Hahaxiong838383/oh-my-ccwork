import { Hono } from 'hono';
import { conversationStore } from '../conversation-store.js';
import { isValidToken } from './auth.js';

const conversationRoute = new Hono();

conversationRoute.use('*', async (c, next) => {
  const token = getAuthorizedToken(c.req.header('authorization'));
  if (!token) {
    return c.json({ ok: false, error: 'unauthorized' }, 401);
  }
  await next();
});

conversationRoute.get('/', (c) => {
  const rawLimit = c.req.query('limit');
  const limit = rawLimit ? Number(rawLimit) : undefined;
  return c.json({
    ok: true,
    items: conversationStore.list({
      accountId: c.req.query('accountId'),
      sessionId: c.req.query('sessionId'),
      limit,
    }),
  });
});

function readBearerToken(headerValue: string | undefined): string | null {
  if (!headerValue) return null;
  const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  if (!match) return null;
  const token = match[1]?.trim();
  return token ? token : null;
}

function getAuthorizedToken(headerValue: string | undefined): string | null {
  const token = readBearerToken(headerValue);
  return token && isValidToken(token) ? token : null;
}

export { conversationRoute };
