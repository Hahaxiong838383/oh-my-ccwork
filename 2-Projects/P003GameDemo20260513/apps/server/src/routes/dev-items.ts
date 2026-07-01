/**
 * 产品开发看板 · HTTP 路由
 *
 * 鉴权：照搬 feedback.ts —— Bearer token + 非 GET 要 admin（guest 只读）
 * 9 个 endpoint：
 *   GET    /                          列表
 *   GET    /links?feedbackIds=a,b,c   反向查（Issue 抽屉用）
 *   GET    /:id                       详情
 *   POST   /                          创建
 *   PATCH  /:id                       改字段
 *   DELETE /:id                       删
 *   POST   /:id/feedbacks             关联 feedback
 *   DELETE /:id/feedbacks/:fid        解关联
 *   POST   /:id/send-thanks           标记致谢已下发
 */

import { Hono } from 'hono';
import { z } from 'zod';

import { DEV_ITEM_LEVELS, DEV_ITEM_STATUSES } from '../dev-items-types.js';
import { devItemStore } from '../dev-items-store.js';
import { canWrite, getTokenUser, isValidToken } from './auth.js';

const devItemsRoute = new Hono();

const CreateBodySchema = z.object({
  title: z.string().trim().min(1, 'title 必填'),
  description: z.string().optional(),
  level: z.enum(DEV_ITEM_LEVELS),
  feedback_ids: z.array(z.string()).optional(),
});

const PatchBodySchema = z
  .object({
    title: z.string().trim().min(1).optional(),
    description: z.string().optional(),
    level: z.enum(DEV_ITEM_LEVELS).optional(),
    status: z.enum(DEV_ITEM_STATUSES).optional(),
    representative_quote: z.string().nullable().optional(),
    source_themes: z.array(z.string()).nullable().optional(),
  })
  .refine(
    (v) =>
      v.title !== undefined ||
      v.description !== undefined ||
      v.level !== undefined ||
      v.status !== undefined ||
      v.representative_quote !== undefined ||
      v.source_themes !== undefined,
    { message: '至少提供一个字段' },
  );

const AttachBodySchema = z.object({
  feedback_ids: z.array(z.string()).min(1, 'feedback_ids 至少一项'),
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

devItemsRoute.use('*', async (c, next) => {
  const token = getAuthorizedToken(c.req.header('authorization'));
  if (!token || !isValidToken(token)) {
    return c.json({ ok: false, error: 'unauthorized' }, 401);
  }
  if (c.req.method !== 'GET' && !canWrite(token)) {
    return c.json(
      { ok: false, error: 'forbidden_readonly', message: '游客账号只读，无编辑权限' },
      403,
    );
  }
  await next();
});

// GET / 列表
devItemsRoute.get('/', (c) => {
  console.log('[dev-items] list');
  return c.json({ ok: true, items: devItemStore.list() });
});

// GET /links?feedbackIds=a,b,c —— 反向查（注意：放在 /:id 之前，否则 :id 会吞 'links'）
devItemsRoute.get('/links', (c) => {
  const raw = c.req.query('feedbackIds') ?? '';
  const ids = raw
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
  console.log(`[dev-items] links lookup count=${ids.length}`);
  return c.json({ ok: true, links: devItemStore.findLinksByFeedbackIds(ids) });
});

// GET /:id 详情
devItemsRoute.get('/:id', (c) => {
  const id = c.req.param('id');
  console.log(`[dev-items] get id=${id}`);
  const item = devItemStore.getById(id);
  if (!item) return c.json({ ok: false, error: 'not_found' }, 404);
  return c.json({ ok: true, item });
});

// POST / 创建
devItemsRoute.post('/', async (c) => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'bad_request' }, 400);
  }
  const parsed = CreateBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ ok: false, error: 'bad_request' }, 400);
  }

  const token = getAuthorizedToken(c.req.header('authorization'));
  const updatedBy = token ? getTokenUser(token) ?? 'admin' : 'admin';
  console.log(`[dev-items] create title="${parsed.data.title}" by=${updatedBy}`);
  const item = devItemStore.create(
    {
      title: parsed.data.title,
      description: parsed.data.description,
      level: parsed.data.level,
      feedback_ids: parsed.data.feedback_ids,
    },
    updatedBy,
  );
  return c.json({ ok: true, item });
});

// PATCH /:id
devItemsRoute.patch('/:id', async (c) => {
  const id = c.req.param('id');
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
  console.log(`[dev-items] patch id=${id} by=${updatedBy}`);
  const item = devItemStore.update(id, parsed.data, updatedBy);
  if (!item) return c.json({ ok: false, error: 'not_found' }, 404);
  return c.json({ ok: true, item });
});

// DELETE /:id
devItemsRoute.delete('/:id', (c) => {
  const id = c.req.param('id');
  console.log(`[dev-items] delete id=${id}`);
  const ok = devItemStore.delete(id);
  if (!ok) return c.json({ ok: false, error: 'not_found' }, 404);
  return c.json({ ok: true });
});

// POST /:id/feedbacks
devItemsRoute.post('/:id/feedbacks', async (c) => {
  const id = c.req.param('id');
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'bad_request' }, 400);
  }
  const parsed = AttachBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ ok: false, error: 'bad_request' }, 400);
  }
  console.log(`[dev-items] attach id=${id} count=${parsed.data.feedback_ids.length}`);
  const item = devItemStore.attachFeedbacks(id, parsed.data.feedback_ids);
  if (!item) return c.json({ ok: false, error: 'not_found' }, 404);
  return c.json({ ok: true, item });
});

// DELETE /:id/feedbacks/:fid
devItemsRoute.delete('/:id/feedbacks/:fid', (c) => {
  const id = c.req.param('id');
  const fid = c.req.param('fid');
  console.log(`[dev-items] detach id=${id} fid=${fid}`);
  const item = devItemStore.detachFeedback(id, fid);
  if (!item) return c.json({ ok: false, error: 'not_found' }, 404);
  return c.json({ ok: true, item });
});

// POST /:id/send-thanks
devItemsRoute.post('/:id/send-thanks', (c) => {
  const id = c.req.param('id');
  console.log(`[dev-items] send-thanks id=${id}`);
  const item = devItemStore.markThanksSent(id);
  if (!item) return c.json({ ok: false, error: 'not_found' }, 404);
  return c.json({ ok: true, item });
});

export { devItemsRoute };
