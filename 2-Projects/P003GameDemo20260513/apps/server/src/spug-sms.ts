// Spug 推送助手短信验证码发送（2026-08-23 川哥定为优先渠道，阿里云 aliyun-sms.ts 降为备用回滚锚）。
// 与阿里云 dypnsapi「托管核验」不同：Spug 是自备码模式——码由 server 生成/存储/校验
// （配套 verify-code-store.ts），Spug 只负责发送。
//
// 契约（https://push.spug.cc/guide/sms）：
//   POST https://push.spug.cc/sms/<TEMPLATE_CODE>  body {to, code, number}
//   → {code:200, msg:'请求成功', request_id:'…'}；code≠200 时 msg 说明原因。
//   模板带有效时长变量 → number 必填（分钟数，实测缺参报 400「缺少变量number的值」）。
// 状态查询（排障）：POST /request/query {token:<开发者Token>, request_id} → data[].status（2=成功）。
//
// env（凭证，生产 .env.local，不进 git）：
//   SPUG_SMS_TEMPLATE_CODE  模板编码（文档明言「模板编码是调用凭证」，勿入前端/APK）
//   SPUG_DEV_TOKEN          开发者 Token（仅状态查询用）

const SPUG_BASE = 'https://push.spug.cc';
const CODE_TTL_MIN = '5'; // 与阿里云模板 min=5 同口径

export type SpugSendResult = { ok: true; requestId: string } | { ok: false; code: number; msg: string };

type SpugTransport = (url: string, body: Record<string, string>) => Promise<unknown>;

let transport: SpugTransport = async (url, body) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
};

/** 测试注入点（同 aliyun-sms.ts 的 setSmsTransportForTest 模式） */
export function setSpugTransportForTest(t: SpugTransport): void {
  transport = t;
}

export async function sendSpugSmsCode(phone: string, code: string): Promise<SpugSendResult> {
  const template = process.env.SPUG_SMS_TEMPLATE_CODE?.trim();
  if (!template) throw new Error('spug_not_configured');
  const resp = (await transport(`${SPUG_BASE}/sms/${template}`, {
    to: phone,
    code,
    number: CODE_TTL_MIN,
  })) as { code?: number; msg?: string; request_id?: string };
  if (resp?.code === 200 && resp.request_id) return { ok: true, requestId: resp.request_id };
  return { ok: false, code: resp?.code ?? 0, msg: resp?.msg ?? 'unknown' };
}

/** 投递状态查询（排障用；status: 0待发/1发送中/2成功/3失败/4审核中） */
export async function querySpugStatus(
  requestId: string,
): Promise<{ ok: boolean; data?: Array<{ target: string; status: string; reason: string }> }> {
  const token = process.env.SPUG_DEV_TOKEN?.trim();
  if (!token) return { ok: false };
  const resp = (await transport(`${SPUG_BASE}/request/query`, { token, request_id: requestId })) as {
    code?: number;
    data?: Array<{ target: string; status: string; reason: string }>;
  };
  return resp?.code === 200 ? { ok: true, data: resp.data } : { ok: false };
}
