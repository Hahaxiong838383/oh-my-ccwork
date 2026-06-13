import { Hono } from 'hono';
import { z } from 'zod';
import { FEEDBACK_STATUSES, feedbackStore, type FeedbackItem } from '../feedback-store.js';
import { getTokenUser, isValidToken } from './auth.js';

const feedbackRoute = new Hono();

const PatchBodySchema = z
  .object({
    status: z.enum(FEEDBACK_STATUSES).optional(),
    note: z.string().optional(),
  })
  .refine((value) => value.status !== undefined || value.note !== undefined, {
    message: 'status 或 note 至少提供一个',
  });

type FeedbackPublicItem = Omit<FeedbackItem, 'ip_hash'>;

feedbackRoute.use('*', async (c, next) => {
  const token = getAuthorizedToken(c.req.header('authorization'));
  if (!token || !isValidToken(token)) {
    return c.json({ ok: false, error: 'unauthorized' }, 401);
  }
  await next();
});

feedbackRoute.get('/', (c) => {
  return c.json({
    ok: true,
    items: feedbackStore.list().map(toPublicItem),
  });
});

feedbackRoute.patch('/:id', async (c) => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'bad_request' }, 400);
  }

  const parsed = PatchBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ ok: false, error: 'bad_request' }, 400);
  }

  const token = getAuthorizedToken(c.req.header('authorization'));
  const updatedBy = token ? getTokenUser(token) ?? 'admin' : 'admin';
  const item = feedbackStore.updateStatus(c.req.param('id'), {
    status: parsed.data.status,
    note: parsed.data.note,
    updatedBy,
  });

  if (!item) {
    return c.json({ ok: false, error: 'not_found' }, 404);
  }

  return c.json({ ok: true, item: toPublicItem(item) });
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

function toPublicItem(item: FeedbackItem): FeedbackPublicItem {
  const { ip_hash: _ipHash, ...rest } = item;
  return rest;
}

export { feedbackRoute };
