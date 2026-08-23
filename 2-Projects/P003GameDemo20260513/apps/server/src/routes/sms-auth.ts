import { randomInt } from 'node:crypto';
import { SignJWT } from 'jose';
import { Hono } from 'hono';
import { z } from 'zod';
import { accountStore } from '../account-store.js';
import { smsLimitStore } from '../sms-limit-store.js';
import { sendSmsVerifyCode, checkSmsVerifyCode } from '../aliyun-sms.js';
import { sendSpugSmsCode } from '../spug-sms.js';
import { verifyCodeStore } from '../verify-code-store.js';

/**
 * 手机号短信验证码注册/登录（2026-08-20 阿里云托管核验；2026-08-23 Spug 升主渠道）。
 *
 * POST /api/auth/sms/send   {phone}        → 三窗限流 → 发码（码只走短信，绝不回传）
 * POST /api/auth/sms/verify {phone, code}  → 核验通过 → 手机号 upsert 家长账号 → 签 JWT
 *
 * 双渠道（SMS_PROVIDER env 每请求读取，改 env+重启即切，无自动 fallback——两套码体系
 * 混合回退会出「码校验路由错」的坑，切换窗口内在途旧码作废由用户重新获取兜底）：
 *  - 'spug'（默认，川哥 2026-08-23「优先使用这个平台」）：自备码模式——server 生成 6 位码
 *    → verify-code-store 落 hash → Spug 发送；verify 走本地校验（TTL 5min/5 次上限/一次性）。
 *  - 'aliyun'（回滚锚）：dypnsapi 托管核验，码不落本地，verify 走 CheckSmsVerifyCode。
 *
 * JWT 姿势与 invite-auth.ts 完全一致（同 secret/issuer/audience/TTL），两种登录发的 token
 * 在 verifyAuthToken 眼里无差别 —— 后续 bind-sn / bound-devices / profile 链路零改动直接可用。
 * 核验错误一律 code_invalid 单一口径（不区分过期/错码/超次，防枚举探测）。
 */

function smsProvider(): 'spug' | 'aliyun' {
  return process.env.SMS_PROVIDER?.trim() === 'aliyun' ? 'aliyun' : 'spug';
}

const JWT_ISSUER = 'p003';
const JWT_AUDIENCE = 'kidshub';
const JWT_TTL = '30d'; // 持久登录(川哥 2026-08-23):家长端 token 存 localStorage,30 天免重登
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
    // 限流拒绝必留痕（此前零日志，排障只能翻 sms.db 反推命中哪窗，2026-08-23）
    console.warn(
      `[sms-auth] rate_limited phone=****${phone.slice(-4)} reason=${verdict.reason} retry_after_s=${verdict.retry_after_s}`,
    );
    const message =
      verdict.reason === 'interval'
        ? `发送太频繁，请 ${verdict.retry_after_s} 秒后再试`
        : verdict.reason === 'phone_hour'
          ? `本小时发送次数已达上限，请约 ${Math.ceil(verdict.retry_after_s / 60)} 分钟后再试`
          : '今日发送次数已达上限，请明天再试';
    return c.json(
      { ok: false, error: 'rate_limited', reason: verdict.reason, message, retry_after_s: verdict.retry_after_s },
      429,
    );
  }

  try {
    if (smsProvider() === 'spug') {
      // 自备码：生成 → 发送成功才落 hash（发送失败不留可用码）
      const code = String(randomInt(100000, 1000000));
      const result = await sendSpugSmsCode(phone, code);
      if (!result.ok) {
        console.warn(`[sms-auth] spug send rejected phone=****${phone.slice(-4)} code=${result.code} msg=${result.msg}`);
        return c.json({ ok: false, error: 'send_failed', message: '发送失败，请稍后再试' }, 502);
      }
      verifyCodeStore.issue(phone, code);
      smsLimitStore.record(phone, ip, result.requestId);
      console.log(`[sms-auth] sent provider=spug phone=****${phone.slice(-4)} req=${result.requestId}`);
      return c.json({ ok: true });
    }
    const result = await sendSmsVerifyCode(phone);
    if (!result.ok) {
      // 阿里云侧拒绝：机器码进日志，用户拿友好口径。
      // biz.FREQUENCY 特化（平台防盗刷频控，本地白名单救不了，控制台白名单可解）——
      // 高频测试期主要撞这个，含糊文案会被误判成服务故障（2026-08-23）。
      console.warn(`[sms-auth] send rejected phone=****${phone.slice(-4)} code=${result.code}`);
      const isFreq = result.code === 'biz.FREQUENCY';
      return c.json(
        {
          ok: false,
          error: 'send_failed',
          reason: isFreq ? 'aliyun_frequency' : undefined,
          message: isFreq ? '触发运营商侧频率限制，请 1 分钟后再试' : '发送失败，请稍后再试',
        },
        502,
      );
    }
    smsLimitStore.record(phone, ip, result.bizId ?? '');
    console.log(`[sms-auth] sent provider=aliyun phone=****${phone.slice(-4)} biz=${result.bizId ?? ''}`);
    return c.json({ ok: true });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg === 'sms_not_configured' || msg === 'spug_not_configured') {
      console.error(`[sms-auth] 短信凭证未配置 provider=${smsProvider()} err=${msg}`);
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
    if (smsProvider() === 'spug') {
      const outcome = verifyCodeStore.verify(phone, code);
      if (outcome !== 'ok') {
        // 内部原因进日志，用户拿 code_invalid 单一口径（防枚举）
        console.log(`[sms-auth] verify fail provider=spug phone=****${phone.slice(-4)} outcome=${outcome}`);
        return c.json({ ok: false, error: 'code_invalid', message: '验证码错误或已过期' }, 401);
      }
    } else {
      const result = await checkSmsVerifyCode(phone, code);
      if (!result.ok) {
        console.log(`[sms-auth] verify fail phone=****${phone.slice(-4)} code=${result.code} result=${result.verifyResult}`);
        return c.json({ ok: false, error: 'code_invalid', message: '验证码错误或已过期' }, 401);
      }
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
