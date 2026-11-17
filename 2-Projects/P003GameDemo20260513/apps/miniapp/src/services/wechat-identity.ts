import { ApiError } from './api-error';

export type WechatCredentials = { phone_code: string; login_code: string; app_id: string };
export type WechatConfiguration = { appId: string | null; configured: boolean; configurationStatus: string };
export type WechatIdentity = WechatConfiguration & { state: 'linked' | 'not_linked' | 'not_configured'; openid: string | null; unionid: string | null; unionidStatus: 'available' | 'not_returned' | 'not_checked'; verifiedAtMs: number | null };
export function wechatConfiguration(value: unknown): WechatConfiguration {
  const x=value as Record<string,unknown> | null;
  if (!x || typeof x.configured!=='boolean') throw new ApiError(502,{error:'invalid_wechat_configuration'});
  return {appId:typeof x.appId==='string'?x.appId:null,configured:x.configured,configurationStatus:typeof x.configurationStatus==='string'?x.configurationStatus:'unknown'};
}
export const wechatAuthorizationErrors = ['wechat_login_code_invalid', 'wechat_phone_code_invalid', 'wechat_app_mismatch', 'wechat_identity_mismatch'];
export function wechatIdentity(value: unknown): WechatIdentity {
  const x = value as Record<string, unknown> | null;
  if (!x || typeof x !== 'object' || !['linked', 'not_linked', 'not_configured'].includes(String(x.state)) || typeof x.configured !== 'boolean') throw new ApiError(502, { error: 'invalid_wechat_identity' });
  const string = (v: unknown) => typeof v === 'string' && v ? v : null;
  if (x.state === 'linked' && (!string(x.appId) || !string(x.openid))) throw new ApiError(502, { error: 'invalid_wechat_identity' });
  return { ...wechatConfiguration(x), state: x.state as WechatIdentity['state'], openid: string(x.openid), unionid: string(x.unionid), unionidStatus: ['available', 'not_returned', 'not_checked'].includes(String(x.unionidStatus)) ? x.unionidStatus as WechatIdentity['unionidStatus'] : 'not_checked', verifiedAtMs: typeof x.verifiedAtMs === 'number' && Number.isFinite(x.verifiedAtMs) ? x.verifiedAtMs : null };
}
export function wechatErrorMessage(error: unknown) {
  const code = (error as { payload?: { error?: string }; code?: string })?.payload?.error || (error as {code?:string})?.code;
  const labels: Record<string, string> = {
    wechat_cancelled: '未授权手机号，可继续使用短信登录', wechat_login_code_invalid: '微信登录凭证已过期，请重新授权', wechat_phone_code_invalid: '手机号授权已过期，请重新授权',
    wechat_app_mismatch: '当前小程序与服务端配置不匹配，请联系内测负责人', wechat_identity_mismatch: '微信身份校验未通过，请重新授权',
    wechat_identity_conflict: '此微信身份已关联其他账号，请联系内测负责人', wechat_phone_mismatch: '微信授权手机号与当前账号不同，请使用当前账号手机号授权',
    wechat_not_configured: '微信登录暂未配置完成，可继续使用短信登录', wechat_unavailable: '微信服务暂不可用，请稍后重试', wechat_exchange_failed: '微信验证暂未成功，请稍后重新授权',
    phone_region_not_supported: '目前仅支持中国大陆手机号', wechat_platform_unavailable: '请在微信小程序内完成授权',
  };
  return code && labels[code] || '微信授权未完成，请重试或使用短信登录';
}
