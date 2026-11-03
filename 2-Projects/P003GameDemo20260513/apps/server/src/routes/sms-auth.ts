import { randomInt, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { SignJWT } from 'jose';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { accountStore } from '../account-store.js';
import { smsLimitStore } from '../sms-limit-store.js';
import { sendSmsVerifyCode, checkSmsVerifyCode } from '../aliyun-sms.js';
import { sendSpugSmsCode } from '../spug-sms.js';
import { verifyCodeStore } from '../verify-code-store.js';

// Keep the existing paths, phone identity, parent JWT and device ACLs. No account rebinding.
// Spug is the active provider; aliyun remains an explicit operational rollback, never auto-fallback.
function smsProvider(): 'spug' | 'aliyun' {
  return process.env.SMS_PROVIDER?.trim() === 'aliyun' ? 'aliyun' : 'spug';
}
function authSecret(): string {
  const secret = process.env.AUTH_JWT_SECRET ?? '';
  if (secret !== secret.trim() || Buffer.byteLength(secret) < 32 || secret === 'dev-secret-change-me') {
    throw new Error('auth_not_configured');
  }
  return secret;
}
function resendInterval(): number {
  const n = Number(process.env.SMS_SEND_INTERVAL_S);
  return Number.isFinite(n) && n >= 0 ? Math.ceil(n) : 60;
}
const PHONE_RE = /^1[3-9]\d{9}$/;
const SendSchema = z.object({ phone: z.string().trim().regex(PHONE_RE) }).strict();
const VerifySchema = z.object({ phone: z.string().trim().regex(PHONE_RE), code: z.string().trim().regex(/^\d{6}$/) }).strict();
type Env = { Variables: { smsRequestId: string } };
export const smsAuthRoute = new Hono<Env>();
smsAuthRoute.onError((_error, c) => {
  const requestId = c.get('smsRequestId');
  console.error(`[sms-auth] unavailable request=${requestId}`);
  return c.json({ ok: false, error: 'sms_unavailable', message: '短信登录服务暂不可用，请稍后再试', request_id: requestId }, 503);
});
smsAuthRoute.use('/sms/*', async (c, next) => {
  c.set('smsRequestId', 'smsreq-' + randomUUID());
  c.header('Cache-Control', 'no-store');
  await next();
});
smsAuthRoute.use('/sms/*', bodyLimit({ maxSize: 4096, onError: c => c.json({
  ok: false, error: 'bad_request', message: '请求格式不正确', request_id: c.get('smsRequestId'),
}, 400) }));

smsAuthRoute.post('/sms/send', async c => {
  const requestId = c.get('smsRequestId');
  const parsed = SendSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ ok: false, error: 'bad_phone', message: '手机号格式不正确', request_id: requestId }, 400);
  const phone = parsed.data.phone;
  // Verified production nginx overwrites X-Real-IP; a caller may prepend arbitrary X-Forwarded-For.
  const realIp = c.req.header('x-real-ip') ?? '';
  const ip = isIP(realIp) ? realIp : 'unknown';
  try { authSecret(); }
  catch { return c.json({ ok: false, error: 'auth_not_configured', message: '登录服务暂未就绪', request_id: requestId }, 503); }
  if (smsProvider() === 'spug' && !/^[A-Za-z0-9_-]{1,200}$/.test(process.env.SPUG_SMS_TEMPLATE_CODE?.trim() ?? '')) {
    return c.json({ ok: false, error: 'sms_not_configured', message: '短信服务未配置', request_id: requestId }, 503);
  }
  const verdict = smsLimitStore.reserve(phone, ip);
  if (!verdict.ok) {
    console.warn(`[sms-auth] rate_limited request=${requestId} phone=****${phone.slice(-4)} reason=${verdict.reason}`);
    const message = verdict.reason === 'interval' ? `发送太频繁，请 ${verdict.retry_after_s} 秒后再试`
      : verdict.reason === 'phone_hour' ? '本小时发送次数已达上限，请稍后再试' : '发送次数已达上限，请稍后再试';
    return c.json({ ok: false, error: 'rate_limited', reason: verdict.reason, message, retry_after_s: verdict.retry_after_s, request_id: requestId },
      429, { 'Retry-After': String(verdict.retry_after_s) });
  }
  try {
    if (smsProvider() === 'spug') {
      const code = String(randomInt(100000, 1000000));
      const result = await sendSpugSmsCode(phone, code);
      if (!result.ok) {
        smsLimitStore.release(verdict.reservationId);
        console.warn(`[sms-auth] send_rejected request=${requestId} provider=spug code=${result.code}`);
        return c.json({ ok: false, error: 'send_failed', message: '发送失败，请稍后再试', request_id: requestId }, 502);
      }
      verifyCodeStore.issue(phone, code);
      smsLimitStore.complete(verdict.reservationId, phone, ip, result.requestId);
      console.log(`[sms-auth] sent request=${requestId} provider=spug phone=****${phone.slice(-4)} provider_request=${result.requestId}`);
    } else {
      const result = await sendSmsVerifyCode(phone);
      if (!result.ok) {
        smsLimitStore.release(verdict.reservationId);
        const frequency = result.code === 'biz.FREQUENCY';
        console.warn(`[sms-auth] send_rejected request=${requestId} provider=aliyun`);
        return c.json({ ok: false, error: 'send_failed', reason: frequency ? 'aliyun_frequency' : undefined,
          message: frequency ? '触发运营商侧频率限制，请1分钟后再试' : '发送失败，请稍后再试', request_id: requestId }, 502);
      }
      smsLimitStore.complete(verdict.reservationId, phone, ip, result.bizId ?? '');
      console.log(`[sms-auth] sent request=${requestId} provider=aliyun phone=****${phone.slice(-4)}`);
    }
    return c.json({ ok: true, request_id: requestId, expires_in: 300, resend_after_s: resendInterval() });
  } catch (error) {
    const missing = error instanceof Error && (error.message === 'sms_not_configured' || error.message === 'spug_not_configured');
    if (missing) {
      smsLimitStore.release(verdict.reservationId);
      return c.json({ ok: false, error: 'sms_not_configured', message: '短信服务未配置', request_id: requestId }, 503);
    }
    // Timeouts or malformed success may already be billable. Persist the attempt in every quota window.
    // The unknown marker is an internal request ID, never a fabricated provider receipt.
    smsLimitStore.complete(verdict.reservationId, phone, ip, 'unknown:' + requestId);
    // Never log arbitrary exception text, provider URLs, response messages, credentials or codes.
    console.error(`[sms-auth] send_unconfirmed request=${requestId} provider=${smsProvider()}`);
    const retry = Math.max(1, resendInterval());
    return c.json({ ok: false, error: 'send_failed', message: '发送结果未确认，请稍后重新获取验证码', retry_after_s: retry, request_id: requestId }, 502, { 'Retry-After': String(retry) });
  }
});

smsAuthRoute.post('/sms/verify', async c => {
  const requestId = c.get('smsRequestId');
  const parsed = VerifySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ ok: false, error: 'bad_request', message: '手机号或验证码格式不正确', request_id: requestId }, 400);
  const { phone, code } = parsed.data;
  let secret: string;
  try { secret = authSecret(); }
  catch { return c.json({ ok: false, error: 'auth_not_configured', message: '登录服务暂未就绪', request_id: requestId }, 503); }
  try {
    if (smsProvider() === 'spug') {
      const outcome = verifyCodeStore.verify(phone, code);
      if (outcome !== 'ok') {
        console.log(`[sms-auth] verify_rejected request=${requestId} phone=****${phone.slice(-4)} outcome=${outcome}`);
        return c.json({ ok: false, error: 'code_invalid', message: '验证码错误或已过期', request_id: requestId }, 401);
      }
    } else {
      const result = await checkSmsVerifyCode(phone, code);
      if (!result.ok) return c.json({ ok: false, error: 'code_invalid', message: '验证码错误或已过期', request_id: requestId }, 401);
    }
  } catch {
    console.error(`[sms-auth] verify_unconfirmed request=${requestId}`);
    return c.json({ ok: false, error: 'verify_failed', message: '校验失败，请稍后再试', request_id: requestId }, 502);
  }
  try {
    const { account, isNew } = accountStore.upsertPhoneAccountWithStatus(phone);
    if (account.role !== 'parent') throw new Error('account_role_mismatch');
    const token = await new SignJWT({ accountId: account.id, role: 'parent' })
      .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setIssuer('p003').setAudience('kidshub').setExpirationTime('30d')
      .sign(new TextEncoder().encode(secret));
    console.log(`[sms-auth] login request=${requestId} account=${account.id} is_new=${isNew}`);
    return c.json({ ok: true, token, token_type: 'Bearer', expires_in: 2592000,
      account: { id: account.id, role: 'parent', nickname: account.nickname, phone_masked: `${phone.slice(0, 3)}****${phone.slice(-4)}` },
      is_new: isNew, request_id: requestId });
  } catch {
    console.error(`[sms-auth] login_failed request=${requestId}`);
    return c.json({ ok: false, error: 'account_login_failed', message: '登录暂未完成，请重新获取验证码', request_id: requestId }, 500);
  }
});
