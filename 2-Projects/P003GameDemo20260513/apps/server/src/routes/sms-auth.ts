import { SignJWT } from 'jose';
import { Hono } from 'hono';
import { z } from 'zod';
import { accountStore } from '../account-store.js';
import { smsLimitStore } from '../sms-limit-store.js';
import { sendSmsVerifyCode, checkSmsVerifyCode } from '../aliyun-sms.js';

/**
 * 手机号短信验证码注册/登录（2026-08-20，阿里云 dypnsapi 托管核验）。
 *
 * POST /api/auth/sms/send   {phone}        → 三窗限流 → 阿里云发码（码只走短信，绝不回传）
 * POST /api/auth/sms/verify {phone, code}  → 阿里云核验 PASS → 手机号 upsert 家长账号 → 签 JWT
 *
 * JWT 姿势与 invite-auth.ts 完全一致（同 secret/issuer/audience/TTL），两种登录发的 token
 * 在 verifyAuthToken 眼里无差别 —— 后续 bind-sn / bound-devices / profile 链路零改动直接可用。
 * 核验错误一律 code_invalid 单一口径（不区分过期/错码，防枚举探测）。
 */

const JWT_ISSUER = 'p003';
const JWT_AUDIENCE = 'kidshub';
const JWT_TTL = '7d';
const DEFAULT_AUTH_SECRET = 'dev-secret-change-me';

const PHONE_RE = /^1[3-9]\d{9}$/;

const SendSchema = z.object({ phone: z.string().trim().regex(PHONE_RE) });
const VerifySchema = z.object({
  phone: z.string().trim().regex(PHONE_RE),
  code: z.string().trim().regex(/^[0-9]{4,8}$/),
});

function clientIp(headerXff: string | undefined, fallback: string): string {
  const first = headerXff?.split(',')[0]?.trim();
  return first || fallback;
}

async function signParentToken(accountId: string): Promise<string> {
  const rawSecret = process.env.AUTH_JWT_SECRET || DEFAULT_AUTH_SECRET;
  const secret = new TextEncoder().encode(rawSecret);
  return new SignJWT({ accountId, role: 'parent' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setExpirationTime(JWT_TTL)
    .sign(secret);
}

export const smsAuthRoute = new Hono();

smsAuthRoute.post('/sms/send', async (c) => {
  const parsed = SendSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ ok: false, error: 'bad_phone', message: '手机号格式不正确' }, 400);
  const phone = parsed.data.phone;
  const ip = clientIp(c.req.header('x-forwarded-for'), '');

  const verdict = smsLimitStore.check(phone, ip);
  if (!verdict.ok) {
    return c.json(
      { ok: false, error: 'rate_limited', message: '发送太频繁，请稍后再试', retry_after_s: verdict.retry_after_s },
      429,
    );
  }

  try {
    const result = await sendSmsVerifyCode(phone);
    if (!result.ok) {
      // 阿里云侧拒绝（频控/黑名单/额度等）：机器码进日志，用户拿统一友好口径
      console.warn(`[sms-auth] send rejected phone=****${phone.slice(-4)} code=${result.code}`);
      return c.json({ ok: false, error: 'send_failed', message: '发送失败，请稍后再试' }, 502);
    }
    smsLimitStore.record(phone, ip, result.bizId ?? '');
    console.log(`[sms-auth] sent phone=****${phone.slice(-4)} biz=${result.bizId ?? ''}`);
    return c.json({ ok: true });
  } catch (err) {
    if ((err as Error).message === 'sms_not_configured') {
      console.error('[sms-auth] ALIYUN_SMS_ACCESS_KEY_ID/SECRET 未配置');
      return c.json({ ok: false, error: 'sms_not_configured', message: '短信服务未配置' }, 503);
    }
    console.error('[sms-auth] send error', err);
    return c.json({ ok: false, error: 'send_failed', message: '发送失败，请稍后再试' }, 502);
  }
});

smsAuthRoute.post('/sms/verify', async (c) => {
  const parsed = VerifySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ ok: false, error: 'bad_request', message: '手机号或验证码格式不正确' }, 400);
  const { phone, code } = parsed.data;

  try {
    const result = await checkSmsVerifyCode(phone, code);
    if (!result.ok) {
      console.log(`[sms-auth] verify fail phone=****${phone.slice(-4)} code=${result.code} result=${result.verifyResult}`);
      return c.json({ ok: false, error: 'code_invalid', message: '验证码错误或已过期' }, 401);
    }
  } catch (err) {
    console.error('[sms-auth] verify error', err);
    return c.json({ ok: false, error: 'verify_failed', message: '校验失败，请稍后再试' }, 502);
  }

  const before = accountStore.findByPhone(phone);
  const account = accountStore.upsertPhoneAccount(phone);
  const token = await signParentToken(account.id);
  console.log(`[sms-auth] login account=${account.id} is_new=${!before}`);
  return c.json({ ok: true, token, account: { id: account.id, nickname: account.nickname }, is_new: !before });
});
