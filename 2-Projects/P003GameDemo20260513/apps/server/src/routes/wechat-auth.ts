import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { SignJWT } from 'jose';
import { z } from 'zod';
import { accountStore } from '../account-store.js';
import { WechatPhoneClient, WechatPhoneError, wechatAppConfig, type WechatErrorCode } from '../wechat-phone.js';

type Env = { Variables: { wechatRequestId: string } };
type Failure = { status: 401 | 422 | 502 | 503; message: string; action: string };
const failures: Record<WechatErrorCode, Failure> = {
  wechat_not_configured: { status: 503, message: '微信登录暂未就绪，请稍后重试', action: 'contact_support' },
  wechat_phone_code_invalid: { status: 401, message: '手机号授权已失效，请重新点击授权', action: 'reauthorize_phone' },
  wechat_identity_mismatch: { status: 401, message: '手机号授权身份不匹配，请重新授权', action: 'reauthorize_phone' },
  phone_region_not_supported: { status: 422, message: '暂不支持该地区手机号', action: 'contact_support' },
  wechat_unavailable: { status: 503, message: '微信登录暂不可用，请稍后重新授权', action: 'wait_then_reauthorize' },
  wechat_exchange_failed: { status: 502, message: '手机号授权结果未确认，请重新授权', action: 'reauthorize_phone' },
};
const schema = z.object({ phone_code: z.string().min(1).max(2048).refine(v => !/[\s\x00-\x1f\x7f]/.test(v)) }).strict();

export function createWechatAuthRoute(options: { client?: WechatPhoneClient; now?: () => number } = {}) {
  const route = new Hono<Env>();
  const client = options.client ?? new WechatPhoneClient();
  const now = options.now ?? Date.now;
  const limits = new Map<string, { count: number; until: number }>();
  route.use('/wechat/phone', async (c, next) => {
    c.set('wechatRequestId', `wxreq-${randomUUID()}`);
    c.header('Cache-Control', 'no-store');
    await next();
  });
  route.use('/wechat/phone', bodyLimit({ maxSize: 4096, onError: c => c.json({
    ok: false, error: 'bad_request', message: '授权请求格式不正确', retry_action: 'fix_request', request_id: c.get('wechatRequestId'),
  }, 400) }));
  route.post('/wechat/phone', async c => {
    const requestId = c.get('wechatRequestId');
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
    if (!parsed.success || !c.req.header('content-type')?.toLowerCase().startsWith('application/json')) {
      return c.json({ ok: false, error: 'bad_request', message: '缺少有效手机号授权信息', retry_action: 'fix_request', request_id: requestId }, 400);
    }
    try {
      const secret = process.env.AUTH_JWT_SECRET ?? '';
      if (secret !== secret.trim() || Buffer.byteLength(secret) < 32 || secret === 'dev-secret-change-me') throw new WechatPhoneError('wechat_not_configured');
      wechatAppConfig(); // Fail before consuming a phone code if application credentials are missing.
      const phone = await client.exchangePhoneCode(parsed.data.phone_code);
      const { account, isNew } = accountStore.upsertPhoneAccountWithStatus(phone);
      if (account.role !== 'parent') throw new Error('account_role_mismatch');
      const token = await new SignJWT({ accountId: account.id, role: 'parent' })
        .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setIssuer('p003').setAudience('kidshub').setExpirationTime('30d')
        .sign(new TextEncoder().encode(secret));
      console.log(`[wechat-auth] login request=${requestId} account=${account.id} is_new=${isNew}`);
      return c.json({
        ok: true, token, token_type: 'Bearer', expires_in: 2592000,
        account: { id: account.id, role: 'parent', nickname: account.nickname, phone_masked: `${phone.slice(0, 3)}****${phone.slice(-4)}` },
        is_new: isNew, request_id: requestId,
      });
    } catch (error) {
      if (error instanceof WechatPhoneError) {
        const failure = failures[error.code];
        console.warn(`[wechat-auth] rejected request=${requestId} error=${error.code}`);
        return c.json({ ok: false, error: error.code, message: failure.message, retry_action: failure.action, request_id: requestId }, failure.status);
      }
      console.error(`[wechat-auth] login_failed request=${requestId}`);
      return c.json({ ok: false, error: 'account_login_failed', message: '登录暂未完成，请稍后重新授权', retry_action: 'reauthorize_phone', request_id: requestId }, 500);
    }
  });
  return route;
}

export const wechatAuthRoute = createWechatAuthRoute();
