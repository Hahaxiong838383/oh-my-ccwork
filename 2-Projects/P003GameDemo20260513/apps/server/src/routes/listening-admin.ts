import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { isValidToken, isAdminRole, getTokenUser } from './auth.js';
import { getListeningSettingsStore } from '../listening-settings-store.js';
import { LISTENING_FIELDS, LISTENING_FIXED, LISTENING_SCENES, ListeningConfigError, exactObject, listeningRuntimeStatus, parseListeningEditable } from '../listening-settings.js';
export const listeningAdminRoute = new Hono();
listeningAdminRoute.use('*', async (c, next) => {
  const token = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization')?.trim() ?? '')?.[1];
  if (!token || !isValidToken(token)) return c.json({ ok: false, error: 'unauthorized' }, 401);
  if (!isAdminRole(token)) return c.json({ ok: false, error: '仅管理员可配置倾听模式' }, 403);
  await next();
});
listeningAdminRoute.use('*', bodyLimit({ maxSize: 64 * 1024, onError: c => c.json({ ok: false, error: '配置请求超过64KiB上限' }, 413) }));
const messages: Record<string,string> = {
  invalid_settings: '配置不合法，请检查字段、范围及完整设备SN', revision_conflict: '配置已被其他管理员修改；请重新载入后再保存',
  revision_not_found: '历史版本不存在', corrupt_config: '配置完整性异常，已停止读取，请联系维护人员',
  revision_exhausted: '配置版本已达上限', invalid_actor: '管理员身份不可用',
};
function snapshot() {
  const store = getListeningSettingsStore();
  return { ok: true, ...store.view(), fields: LISTENING_FIELDS,
    scenes: LISTENING_SCENES, fixed_constraints: LISTENING_FIXED, runtime: listeningRuntimeStatus() };
}
function actor(c: Context) {
  const token = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization')?.trim() ?? '')?.[1];
  const user = token ? getTokenUser(token) : undefined;
  if (!user) throw new ListeningConfigError('invalid_actor');
  return user;
}
function failure(c: Context, error: unknown) {
  if (error instanceof ListeningConfigError) return c.json({ ok: false, code: error.code, error: messages[error.code] ?? '配置操作失败' },
    error.code === 'revision_conflict' ? 409 : error.code === 'revision_not_found' ? 404 : error.code === 'invalid_settings' ? 400 : 503);
  return c.json({ ok: false, code: 'config_unavailable', error: '配置存储暂不可用，请稍后重试；请重新读取确认是否已保存' }, 503);
}
const validRevision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1;
listeningAdminRoute.get('/', c => { try { return c.json(snapshot()); } catch (e) { return failure(c,e); } });
listeningAdminRoute.put('/', async c => {
  const body = await c.req.json().catch(() => null);
  if (!exactObject(body,['expected_revision','settings']) || !validRevision(body.expected_revision) || !parseListeningEditable(body.settings))
    return c.json({ ok: false, error: messages.invalid_settings }, 400);
  if ((body.settings as {enabled:boolean}).enabled && !listeningRuntimeStatus().ready)
    return c.json({ ok: false, code: 'runtime_not_ready', error: '倾听运行链路尚未接入，当前不能开启总闸；其他参数可先保存' }, 409);
  try { getListeningSettingsStore().save(body.expected_revision, body.settings, actor(c)); return c.json(snapshot()); } catch (e) { return failure(c,e); }
});
listeningAdminRoute.post('/disable', async c => {
  const body = await c.req.json().catch(() => null);
  if (!exactObject(body,[])) return c.json({ ok: false, error: '关闭请求不接受其他配置字段' }, 400);
  try { getListeningSettingsStore().disable(actor(c)); return c.json(snapshot()); } catch (e) { return failure(c,e); }
});
listeningAdminRoute.post('/restore', async c => {
  const body = await c.req.json().catch(() => null);
  if (!exactObject(body,['expected_revision','revision']) || !validRevision(body.expected_revision) || !validRevision(body.revision))
    return c.json({ ok: false, error: '版本参数不合法' }, 400);
  try { getListeningSettingsStore().restore(body.expected_revision, body.revision, actor(c)); return c.json(snapshot()); } catch (e) { return failure(c,e); }
});
