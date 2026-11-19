import { Hono } from 'hono';
import { z } from 'zod';
import { isValidToken, isAdminRole, getTokenUser } from './auth.js';
import { configStore } from '../config-store.js';
import { deviceRegistryStore } from '../device-registry-store.js';
import { getSearchTasks, searchSettings, searchAudit } from '../tools/search-runtime.js';
import { boundedSearchBody } from './search-tasks.js';

const settings = z.object({ enabled: z.boolean(), tools: z.boolean(), allowlist: z.array(z.string().regex(/^BJP003\d{14}$/)).max(32) }).strict();
export const searchAdminRoute = new Hono();
searchAdminRoute.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  const token = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization') ?? '')?.[1] ?? '';
  if (!isValidToken(token)) return c.json({ error: 'unauthorized' }, 401);
  if (!isAdminRole(token)) return c.json({ error: 'forbidden' }, 403);
  await next();
});
searchAdminRoute.get('/settings', c => c.json(searchSettings()));
searchAdminRoute.get('/tasks', c => c.json(searchAudit()));
searchAdminRoute.put('/settings', async c => {
  try {
    const value = settings.parse(await boundedSearchBody(c));
    if (value.enabled && (!searchSettings().configured || !value.allowlist.length || value.allowlist.some(sn => {
      const d = deviceRegistryStore.get(sn); return !d?.account_id || d.status !== 'active';
    }))) return c.json({ error: 'invalid_scope_or_unconfigured' }, 400);
    const token = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization') ?? '')?.[1] ?? '';
    const who = getTokenUser(token) ?? 'admin';
    // Close first: partial config write failure can never accidentally widen a live scope.
    configStore.setFlag('p003.search.enabled', '0', who);
    getSearchTasks();
    configStore.setFlag('p003.search.allowlist', JSON.stringify([...new Set(value.allowlist)]), who);
    configStore.setFlag('p003.search.tools', value.tools ? '1' : '0', who);
    configStore.setFlag('p003.search.enabled', value.enabled ? '1' : '0', who);
    return c.json(searchSettings());
  } catch (e) {
    return c.json({ error: e instanceof z.ZodError || e instanceof SyntaxError ? 'invalid_request' : 'settings_failed' }, 400);
  }
});
