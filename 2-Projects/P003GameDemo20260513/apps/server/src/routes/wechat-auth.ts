import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { SignJWT } from 'jose';
import { z } from 'zod';
import { accountStore, AccountWechatIdentityError } from '../account-store.js';
import { WechatPhoneClient, WechatPhoneError, wechatAppConfig, type WechatErrorCode } from '../wechat-phone.js';
import { verifyAuthToken } from '../auth-jwt.js';
import { readWechatIdentity } from '../wechat-identity.js';

type Env = { Variables: { wechatRequestId: string } };
type Failure = { status: 401 | 422 | 502 | 503; message: string; action: string };
const failures: Record<WechatErrorCode, Failure> = {
  wechat_not_configured: { status: 503, message: '微信登录暂未就绪，请稍后重试', action: 'contact_support' },
  wechat_phone_code_invalid: { status: 401, message: '手机号授权已失效，请重新点击授权', action: 'reauthorize_phone' },
  wechat_identity_mismatch: { status: 401, message: '手机号授权身份不匹配，请重新授权', action: 'reauthorize_phone' },
  wechat_login_code_invalid: { status: 401, message: '微信登录已失效，请重新授权', action: 'reauthorize_phone' },
  wechat_app_mismatch: { status: 401, message: '小程序应用配置不匹配，请联系支持', action: 'contact_support' },
  phone_region_not_supported: { status: 422, message: '暂不支持该地区手机号', action: 'contact_support' },
  wechat_unavailable: { status: 503, message: '微信登录暂不可用，请稍后重新授权', action: 'wait_then_reauthorize' },
  wechat_exchange_failed: { status: 502, message: '手机号授权结果未确认，请重新授权', action: 'reauthorize_phone' },
};
const code = z.string().min(1).max(2048).refine(v => !/[\s\x00-\x1f\x7f]/.test(v));
const schema = z.object({ phone_code: code, login_code: code.optional(), app_id: z.string().regex(/^wx[a-f0-9]{16}$/).optional() })
  .strict().refine(v => Boolean(v.login_code) === Boolean(v.app_id));

async function parentAccount(c: Context<Env>) {
  const token = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization')?.trim() ?? '')?.[1];
  const auth = await verifyAuthToken(token);
  if (!auth) return { error: 'unauthorized' as const, account: null };
  const account = accountStore.findAccount(auth.accountId);
  if (auth.role !== 'parent' || account?.role !== 'parent') return { error: 'parent_required' as const, account: null };
  return { error: null, account };
}

export function createWechatAuthRoute(options: { client?: WechatPhoneClient; now?: () => number } = {}) {
  const route = new Hono<Env>();
  const client = options.client ?? new WechatPhoneClient();
  const now = options.now ?? Date.now;
  const limits = new Map<string, { count: number; until: number }>();
  route.use('/wechat/*', async (c, next) => {
    c.set('wechatRequestId', `wxreq-${randomUUID()}`);
    c.header('Cache-Control', 'no-store');
    await next();
  });
  route.use('/wechat/*', bodyLimit({ maxSize: 8192, onError: c => c.json({
    ok: false, error: 'bad_request', message: '授权请求格式不正确', retry_action: 'fix_request', request_id: c.get('wechatRequestId'),
  }, 400) }));
  route.get('/wechat/config', c => {
    const { app_id, configured, configuration_status } = readWechatIdentity(null);
    return c.json({ ok: true, app_id, configured, configuration_status });
  });
  route.get('/wechat/identity', async c => {
    const current = await parentAccount(c);
    if (current.error) return c.json({ ok: false, error: current.error, request_id: c.get('wechatRequestId') }, current.error === 'unauthorized' ? 401 : 403);
    return c.json({ ok: true, wechat_identity: readWechatIdentity(current.account.id) });
  });
  const exchange = async (c: Context<Env>) => {
    const requestId = c.get('wechatRequestId');
    const linking = c.req.path.endsWith('/wechat/link');
    const current = linking ? await parentAccount(c) : null;
    if (current?.error) return c.json({ ok: false, error: current.error, request_id: requestId }, current.error === 'unauthorized' ? 401 : 403);
    // Production nginx overwrites X-Real-IP. Do not trust a user-prepended X-Forwarded-For list.
    const ip = c.req.header('x-real-ip')?.slice(0, 64) || 'unknown';
    const at = now();
    for (const [key, entry] of limits) if (entry.until <= at) limits.delete(key);
    let entry = limits.get(ip);
    if (!entry) {
      if (limits.size >= 10000) return c.json({ ok: false, error: 'rate_limited', message: '操作频繁，请稍后重试', retry_action: 'wait_then_reauthorize', retry_after_s: 60, request_id: requestId }, 429, { 'Retry-After': '60' });
      entry = { count: 0, until: at + 60000 }; limits.set(ip, entry);
    }
    if (++entry.count > 10) {
      const retry = Math.max(1, Math.ceil((entry.until - at) / 1000));
      return c.json({ ok: false, error: 'rate_limited', message: '操作频繁，请稍后重试', retry_action: 'wait_then_reauthorize', retry_after_s: retry, request_id: requestId }, 429, { 'Retry-After': String(retry) });
    }
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success || (linking && !parsed.data.login_code) || !c.req.header('content-type')?.toLowerCase().startsWith('application/json')) {
      return c.json({ ok: false, error: 'bad_request', message: '缺少有效手机号授权信息', retry_action: 'fix_request', request_id: requestId }, 400);
    }
    try {
      const secret = process.env.AUTH_JWT_SECRET ?? '';
      if (secret !== secret.trim() || Buffer.byteLength(secret) < 32 || secret === 'dev-secret-change-me') throw new WechatPhoneError('wechat_not_configured');
      const config = wechatAppConfig(); // Fail before consuming any code if application credentials are missing.
      if (parsed.data.app_id && parsed.data.app_id !== config.appId) throw new WechatPhoneError('wechat_app_mismatch');
      const identity = parsed.data.login_code ? await client.exchangeLoginCode(parsed.data.login_code) : null;
      const phone = await client.exchangePhoneCode(parsed.data.phone_code);
      const { account, isNew } = identity
        ? accountStore.upsertWechatPhoneAccountWithStatus(phone, identity, current?.account?.id)
        : accountStore.upsertPhoneAccountWithStatus(phone);
      if (account.role !== 'parent') throw new Error('account_role_mismatch');
      if (linking) return c.json({ ok: true, wechat_identity: readWechatIdentity(account.id), request_id: requestId });
      const token = await new SignJWT({ accountId: account.id, role: 'parent' })
        .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setIssuer('p003').setAudience('kidshub').setExpirationTime('30d')
        .sign(new TextEncoder().encode(secret));
      console.log(`[wechat-auth] login request=${requestId} account=${account.id} is_new=${isNew}`);
      return c.json({
        ok: true, token, token_type: 'Bearer', expires_in: 2592000,
        account: { id: account.id, role: 'parent', nickname: account.nickname, phone_masked: `${phone.slice(0, 3)}****${phone.slice(-4)}` },
        is_new: isNew, request_id: requestId, wechat_identity: readWechatIdentity(account.id),
      });
    } catch (error) {
      if (error instanceof AccountWechatIdentityError) {
        const roleMismatch = error.code === 'account_role_mismatch';
        return c.json({ ok: false, error: error.code,
          message: error.code === 'wechat_phone_mismatch' ? '授权手机号与当前账号不一致，请使用当前账号手机号' : roleMismatch ? '当前账号不能关联微信身份' : '微信身份已关联其他账号，请联系支持',
          retry_action: 'contact_support', request_id: requestId }, roleMismatch ? 403 : 409);
      }
      if (error instanceof WechatPhoneError) {
        const failure = failures[error.code];
        console.warn(`[wechat-auth] rejected request=${requestId} error=${error.code}`);
        return c.json({ ok: false, error: error.code, message: failure.message, retry_action: failure.action, request_id: requestId }, failure.status);
      }
      console.error(`[wechat-auth] login_failed request=${requestId}`);
      return c.json({ ok: false, error: 'account_login_failed', message: '登录暂未完成，请稍后重新授权', retry_action: 'reauthorize_phone', request_id: requestId }, 500);
    }
  };
  route.post('/wechat/phone', exchange);
  route.post('/wechat/link', exchange);
  return route;
}

export const wechatAuthRoute = createWechatAuthRoute();
