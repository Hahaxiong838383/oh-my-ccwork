import { accountStore } from './account-store.js';
import { wechatConfigurationStatus, type WechatConfigurationStatus } from './wechat-phone.js';

export type WechatIdentityDto = {
  app_id: string | null;
  configured: boolean;
  configuration_status: WechatConfigurationStatus;
  state: 'linked' | 'not_linked' | 'not_configured';
  openid: string | null;
  unionid: string | null;
  unionid_status: 'available' | 'not_returned' | 'not_checked';
  verified_at_ms: number | null;
};

/** Read only; no app secret or session key is ever included in the public DTO. */
export function readWechatIdentity(accountId: string | null): WechatIdentityDto {
  const configuredAppId = process.env.WECHAT_APP_ID?.trim() ?? '';
  const appId = /^wx[a-f0-9]{16}$/.test(configuredAppId) ? configuredAppId : null;
  const configurationStatus = wechatConfigurationStatus();
  const configured = configurationStatus === 'ready';
  const identity = accountId && appId ? accountStore.findWechatIdentity(accountId, appId) : null;
  return {
    app_id: appId, configured, configuration_status: configurationStatus,
    state: identity ? 'linked' : configured ? 'not_linked' : 'not_configured',
    openid: identity?.openid ?? null, unionid: identity?.unionid ?? null,
    unionid_status: identity ? identity.unionid ? 'available' : 'not_returned' : 'not_checked',
    verified_at_ms: identity?.verified_at_ms ?? null,
  };
}
