import { createHmac, randomUUID } from 'node:crypto';

/**
 * 阿里云号码认证服务（dypnsapi）短信验证码客户端 —— 零依赖自实现 POP RPC V1 签名。
 *
 * 为什么不装 SDK：server 依赖极简（hono/jose/zod），部署链 rsync + pm2 不重装依赖；
 * 签名规范公开稳定，实现 ~40 行；签名错误会立刻显性失败（SignatureDoesNotMatch），不会静默错。
 *
 * 真值（2026-08-20 CLI E2E PASS，详见记忆 project_p003_sms_auth）：
 *  - 账号 cc-remote；签名只能用系统赠送（默认「恒创联众」）；模板 100001=登录/注册。
 *  - TemplateParam 必须 {"code":"##code##","min":"5"} 形态 → 阿里云生成码 + 托管核验
 *    （CheckSmsVerifyCode 直接校验，server 零存码）。
 *  - 红线：生产绝不传 ReturnVerifyCode（码只走短信通道）。
 *
 * env：ALIYUN_SMS_ACCESS_KEY_ID / ALIYUN_SMS_ACCESS_KEY_SECRET（必配，缺失时接口返回未配置错误）
 *      SMS_SIGN_NAME（默认 恒创联众）/ SMS_TEMPLATE_CODE（默认 100001）
 */

const ENDPOINT = 'https://dypnsapi.aliyuncs.com/';
const API_VERSION = '2017-05-25';

export type SmsResult = {
  ok: boolean;
  /** 阿里云返回的 Code（OK=成功；isv.BUSINESS_LIMIT_CONTROL=运营商/平台频控 等） */
  code: string;
  /** 核验结果（仅 check 用）：PASS / UNKNOWN */
  verifyResult?: string;
  bizId?: string;
  raw?: unknown;
};

/** 传输层（测试注入点）：输入完整请求参数，返回阿里云 JSON 响应体。 */
export type SmsTransport = (action: string, params: Record<string, string>) => Promise<unknown>;

let transport: SmsTransport = httpTransport;

/** 测试专用：替换传输层（mock 阿里云，不实发）。返回恢复函数。 */
export function setSmsTransportForTest(t: SmsTransport): () => void {
  const prev = transport;
  transport = t;
  return () => {
    transport = prev;
  };
}

/** RFC3986 percent-encode（阿里云 POP 规范：保留 A-Za-z0-9-_.~，其余全编码）。 */
function pe(s: string): string {
  return encodeURIComponent(s)
    .replace(/!/g, '%21')
    .replace(/\*/g, '%2A')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');
}

function signedQuery(action: string, bizParams: Record<string, string>, akId: string, akSecret: string): string {
  const params: Record<string, string> = {
    ...bizParams,
    AccessKeyId: akId,
    Action: action,
    Format: 'JSON',
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: randomUUID(),
    SignatureVersion: '1.0',
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    Version: API_VERSION,
  };
  const canonical = Object.keys(params)
    .sort()
    .map((k) => `${pe(k)}=${pe(params[k])}`)
    .join('&');
  const stringToSign = `POST&${pe('/')}&${pe(canonical)}`;
  const signature = createHmac('sha1', `${akSecret}&`).update(stringToSign).digest('base64');
  return `${canonical}&Signature=${pe(signature)}`;
}

async function httpTransport(action: string, bizParams: Record<string, string>): Promise<unknown> {
  const akId = process.env.ALIYUN_SMS_ACCESS_KEY_ID?.trim();
  const akSecret = process.env.ALIYUN_SMS_ACCESS_KEY_SECRET?.trim();
  if (!akId || !akSecret) throw new Error('sms_not_configured');
  const body = signedQuery(action, bizParams, akId, akSecret);
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  return res.json();
}

function signName(): string {
  return process.env.SMS_SIGN_NAME?.trim() || '恒创联众';
}

function templateCode(): string {
  return process.env.SMS_TEMPLATE_CODE?.trim() || '100001';
}

/** 发送验证码（阿里云生成 6 位数字码，有效期 5 分钟，同号 60s 平台频控兜底）。 */
export async function sendSmsVerifyCode(phone: string): Promise<SmsResult> {
  const raw = (await transport('SendSmsVerifyCode', {
    PhoneNumber: phone,
    SignName: signName(),
    TemplateCode: templateCode(),
    TemplateParam: '{"code":"##code##","min":"5"}',
    CodeLength: '6',
    ValidTime: '300',
    // 红线：不传 ReturnVerifyCode —— 验证码只走短信通道，绝不回传给调用方。
  })) as { Code?: string; Success?: boolean; Model?: { BizId?: string } };
  const code = raw?.Code ?? 'UNKNOWN_ERROR';
  return { ok: raw?.Success === true && code === 'OK', code, bizId: raw?.Model?.BizId, raw };
}

/** 核验验证码（托管核验；PASS 才算通过，其余一律失败）。 */
export async function checkSmsVerifyCode(phone: string, verifyCode: string): Promise<SmsResult> {
  const raw = (await transport('CheckSmsVerifyCode', {
    PhoneNumber: phone,
    VerifyCode: verifyCode,
  })) as { Code?: string; Success?: boolean; Model?: { VerifyResult?: string } };
  const code = raw?.Code ?? 'UNKNOWN_ERROR';
  const verifyResult = raw?.Model?.VerifyResult ?? 'UNKNOWN';
  return { ok: raw?.Success === true && code === 'OK' && verifyResult === 'PASS', code, verifyResult, raw };
}
