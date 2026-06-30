import { Hono } from 'hono';
import { z } from 'zod';
import {
  FEEDBACK_ADOPTION_KINDS,
  FEEDBACK_EMOTIONS,
  FEEDBACK_STATUSES,
  FEEDBACK_THEMES,
  feedbackStore,
  type FeedbackItem,
} from '../feedback-store.js';
import { getTokenRole, getTokenUser, isValidToken } from './auth.js';

const feedbackRoute = new Hono();

// PATCH body：所有字段 optional；adoptionKind 三态（缺/null/枚举值），用 nullable.optional 表达
const PatchBodySchema = z
  .object({
    status: z.enum(FEEDBACK_STATUSES).optional(),
    note: z.string().optional(),
    theme: z.enum(FEEDBACK_THEMES).optional(),
    emotion: z.enum(FEEDBACK_EMOTIONS).optional(),
    adoptionKind: z.enum(FEEDBACK_ADOPTION_KINDS).nullable().optional(),
  })
  .refine(
    (value) =>
      value.status !== undefined ||
      value.note !== undefined ||
      value.theme !== undefined ||
      value.emotion !== undefined ||
      value.adoptionKind !== undefined,
    { message: 'status / note / theme / emotion / adoptionKind 至少提供一个' },
  );

type FeedbackPublicItem = Omit<FeedbackItem, 'ip_hash'>;

feedbackRoute.use('*', async (c, next) => {
  const token = getAuthorizedToken(c.req.header('authorization'));
  if (!token || !isValidToken(token)) {
    return c.json({ ok: false, error: 'unauthorized' }, 401);
  }
  // 只读门控（真防线）：guest 仅可 GET（看反馈）；改状态/备注（PATCH）一律 403。
  if (c.req.method !== 'GET' && getTokenRole(token) !== 'admin') {
    return c.json({ ok: false, error: 'forbidden_readonly', message: '游客账号只读，无编辑权限' }, 403);
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
    theme: parsed.data.theme,
    emotion: parsed.data.emotion,
    adoptionKind: parsed.data.adoptionKind,
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
