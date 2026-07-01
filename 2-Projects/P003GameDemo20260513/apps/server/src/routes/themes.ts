import { Hono } from 'hono';
import { z } from 'zod';
import { themeStore } from '../themes-store.js';
import { canWrite, getTokenUser, isValidToken } from './auth.js';

/**
 * /api/feedback-themes
 *
 * - GET    /            全部 themes（含 inactive，按 sort_order asc）
 * - POST   /            { id, color, sort_order? }  创建（system=0）
 * - PATCH  /:id         { new_id?, color?, sort_order?, active? }  改名/改色/排序/软删
 * - DELETE /:id         物理删（system=1 拒）
 *
 * 鉴权：所有路径需 token；guest 仅可 GET，非 GET 一律 403。
 */
const themesRoute = new Hono();

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

const CreateBody = z.object({
  id: z.string().min(1).max(20),
  color: z.string().regex(HEX_COLOR, 'color must be hex'),
  sort_order: z.number().optional(),
});

const PatchBody = z
  .object({
    new_id: z.string().min(1).max(20).optional(),
    color: z.string().regex(HEX_COLOR).optional(),
    sort_order: z.number().optional(),
    active: z.union([z.literal(0), z.literal(1)]).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field' });

themesRoute.use('*', async (c, next) => {
  const token = getAuthorizedToken(c.req.header('authorization'));
  if (!token || !isValidToken(token)) {
    return c.json({ ok: false, error: 'unauthorized' }, 401);
  }
  if (c.req.method !== 'GET' && !canWrite(token)) {
    return c.json({ ok: false, error: 'forbidden_readonly', message: '游客账号只读，无编辑权限' }, 403);
  }
  await next();
});

themesRoute.get('/', (c) => {
  console.log('[themes] list');
  return c.json({ ok: true, items: themeStore.list() });
});

themesRoute.post('/', async (c) => {
  console.log('[themes] create');
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'bad_request' }, 400);
  }
  const parsed = CreateBody.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ ok: false, error: 'bad_request' }, 400);
  }
  const token = getAuthorizedToken(c.req.header('authorization'));
  const updatedBy = token ? getTokenUser(token) ?? 'admin' : 'admin';
  try {
    const item = themeStore.create(parsed.data, updatedBy);
    return c.json({ ok: true, item });
  } catch (err) {
    const code = err instanceof Error ? err.message : 'create_failed';
    if (code === 'conflict_id') {
      return c.json({ ok: false, error: 'conflict_id' }, 400);
    }
    return c.json({ ok: false, error: 'bad_request' }, 400);
  }
});

themesRoute.patch('/:id', async (c) => {
  const id = c.req.param('id');
  console.log(`[themes] patch id=${id}`);
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'bad_request' }, 400);
  }
  const parsed = PatchBody.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ ok: false, error: 'bad_request' }, 400);
  }
  const token = getAuthorizedToken(c.req.header('authorization'));
  const updatedBy = token ? getTokenUser(token) ?? 'admin' : 'admin';
  try {
    const item = themeStore.update(id, parsed.data, updatedBy);
    if (!item) return c.json({ ok: false, error: 'not_found' }, 404);
    return c.json({ ok: true, item });
  } catch (err) {
    const code = err instanceof Error ? err.message : 'update_failed';
    if (code === 'conflict_id') {
      return c.json({ ok: false, error: 'conflict_id' }, 400);
    }
    if (code === 'system_protected') {
      return c.json({ ok: false, error: 'system_protected' }, 400);
    }
    return c.json({ ok: false, error: 'bad_request' }, 400);
  }
});

themesRoute.delete('/:id', (c) => {
  const id = c.req.param('id');
  console.log(`[themes] delete id=${id}`);
  try {
    const ok = themeStore.remove(id);
    if (!ok) return c.json({ ok: false, error: 'not_found' }, 404);
    return c.json({ ok: true });
  } catch (err) {
    const code = err instanceof Error ? err.message : 'delete_failed';
    if (code === 'system_protected') {
      return c.json({ ok: false, error: 'system_protected' }, 400);
    }
    return c.json({ ok: false, error: 'bad_request' }, 400);
  }
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

export { themesRoute };
