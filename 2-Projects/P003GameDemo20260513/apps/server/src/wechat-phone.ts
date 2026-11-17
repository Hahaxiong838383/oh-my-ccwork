/** WeChat code exchange. No codes, URLs containing credentials, or upstream bodies are logged. */
import type { VerifiedWechatIdentity } from './account-store.js';
export type WechatErrorCode =
  | 'wechat_not_configured' | 'wechat_phone_code_invalid' | 'wechat_identity_mismatch'
  | 'wechat_login_code_invalid' | 'wechat_app_mismatch'
  | 'phone_region_not_supported' | 'wechat_unavailable' | 'wechat_exchange_failed';

export class WechatPhoneError extends Error {
  constructor(public readonly code: WechatErrorCode) { super(code); this.name = 'WechatPhoneError'; }
}

type AppConfig = { appId: string; appSecret: string };
export type WechatConfigurationStatus = 'ready' | 'missing_app_id' | 'invalid_app_id' | 'missing_app_secret' | 'invalid_app_secret';
type Json = Record<string, unknown>;
const invalidAccessToken = new Set([40001, 40014, 42001]);
const configErrors = new Set([40013, 40125, 40164, 48001, 48002, 50001, 61007]);
const jsonObject = (value: unknown): Json | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;

export function wechatConfigurationStatus(): WechatConfigurationStatus {
  const appId = process.env.WECHAT_APP_ID?.trim() ?? '';
  const appSecret = process.env.WECHAT_APP_SECRET?.trim() ?? '';
  if (!appId) return 'missing_app_id';
  if (!/^wx[a-f0-9]{16}$/.test(appId)) return 'invalid_app_id';
  if (!appSecret) return 'missing_app_secret';
  if (appSecret.length < 16 || /\s/.test(appSecret)) return 'invalid_app_secret';
  return 'ready';
}

export function wechatAppConfig(): AppConfig {
  if (wechatConfigurationStatus() !== 'ready') throw new WechatPhoneError('wechat_not_configured');
  return { appId: process.env.WECHAT_APP_ID!.trim(), appSecret: process.env.WECHAT_APP_SECRET!.trim() };
}

/** Dependencies make remote HTTP and clock explicit; there is no production mock mode or bypass. */
export class WechatPhoneClient {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private cache: { configKey: string; value: string; until: number } | null = null;
  private loading: { configKey: string; promise: Promise<string> } | null = null;
  private refreshInvalidToken = false;
  private lastForcedRefresh = -Infinity;
  private readonly attemptedCodes = new Map<string, number>();
  private readonly attemptedLoginCodes = new Map<string, number>();

  constructor(options: { fetchImpl?: typeof fetch; now?: () => number; timeoutMs?: number } = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 8000;
  }

  private async request(url: string, body?: unknown): Promise<Json> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal, redirect: 'error',
      });
      if (!response.ok) throw new WechatPhoneError('wechat_unavailable');
      const text = await response.text();
      if (text.length > 65536) throw new WechatPhoneError('wechat_exchange_failed');
      const data = jsonObject(JSON.parse(text));
      if (!data) throw new WechatPhoneError('wechat_exchange_failed');
      return data;
    } catch (error) {
      if (error instanceof WechatPhoneError) throw error;
      // Never expose fetch exceptions: they may contain access_token URLs or app secrets.
      throw new WechatPhoneError('wechat_exchange_failed');
    } finally { clearTimeout(timer); }
  }

  private post(url: string, body: unknown): Promise<Json> { return this.request(url, body); }

  async exchangeLoginCode(code: string): Promise<VerifiedWechatIdentity> {
    const config = wechatAppConfig();
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(`${config.appId}\0${code}`).digest('hex');
    const now = this.now();
    for (const [key, until] of this.attemptedLoginCodes) if (until <= now) this.attemptedLoginCodes.delete(key);
    if (this.attemptedLoginCodes.has(hash)) throw new WechatPhoneError('wechat_login_code_invalid');
    if (this.attemptedLoginCodes.size >= 10000) throw new WechatPhoneError('wechat_unavailable');
    this.attemptedLoginCodes.set(hash, now + 5 * 60_000);
    const query = new URLSearchParams({ appid: config.appId, secret: config.appSecret, js_code: code, grant_type: 'authorization_code' });
    const data = await this.request(`https://api.weixin.qq.com/sns/jscode2session?${query}`);
    if (data.errcode !== undefined && (typeof data.errcode !== 'number' || !Number.isInteger(data.errcode))) throw new WechatPhoneError('wechat_exchange_failed');
    if (typeof data.errcode === 'number' && data.errcode !== 0) {
      if (data.errcode === 40029 || data.errcode === 40163) throw new WechatPhoneError('wechat_login_code_invalid');
      throw new WechatPhoneError(configErrors.has(data.errcode) ? 'wechat_not_configured' : 'wechat_unavailable');
    }
    const validIdentity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
    if (!validIdentity(data.openid) || typeof data.session_key !== 'string' || !data.session_key || data.session_key.length > 2048 ||
        (data.unionid != null && !validIdentity(data.unionid))) throw new WechatPhoneError('wechat_exchange_failed');
    // session_key is deliberately discarded. Only server-verified identifiers leave this boundary.
    return { appId: config.appId, openid: data.openid, unionid: typeof data.unionid === 'string' ? data.unionid : null };
  }

  private async token(config: AppConfig): Promise<string> {
    const configKey = `${config.appId}:${config.appSecret}`;
    if (this.cache?.configKey === configKey && this.cache.until > this.now() && !this.refreshInvalidToken) return this.cache.value;
    if (this.loading?.configKey === configKey) return this.loading.promise;
    const forceRefresh = this.refreshInvalidToken;
    if (forceRefresh && this.now() - this.lastForcedRefresh < 30000) throw new WechatPhoneError('wechat_unavailable');
    if (forceRefresh) this.lastForcedRefresh = this.now();
    const promise = (async () => {
      const data = await this.post('https://api.weixin.qq.com/cgi-bin/stable_token', {
        grant_type: 'client_credential', appid: config.appId, secret: config.appSecret, force_refresh: forceRefresh,
      });
      if (typeof data.errcode === 'number' && data.errcode !== 0) {
        throw new WechatPhoneError(configErrors.has(data.errcode) ? 'wechat_not_configured' : 'wechat_unavailable');
      }
      if (typeof data.access_token !== 'string' || !data.access_token || typeof data.expires_in !== 'number' || data.expires_in <= 0) {
        throw new WechatPhoneError('wechat_exchange_failed');
      }
      this.cache = { configKey, value: data.access_token, until: this.now() + Math.max(0, data.expires_in - 120) * 1000 };
      this.refreshInvalidToken = false;
      return data.access_token;
    })();
    const loading = { configKey, promise };
    this.loading = loading;
    try { return await promise; }
    finally { if (this.loading === loading) this.loading = null; }
  }

  async exchangePhoneCode(code: string): Promise<string> {
    const config = wechatAppConfig();
    const { createHash } = await import('node:crypto');
    const codeHash = createHash('sha256').update(`${config.appId}\0${code}`).digest('hex');
    const now = this.now();
    for (const [hash, until] of this.attemptedCodes) if (until <= now) this.attemptedCodes.delete(hash);
    if (this.attemptedCodes.has(codeHash)) throw new WechatPhoneError('wechat_phone_code_invalid');
    const accessToken = await this.token(config);
    // Recheck after await, so concurrent requests cannot exchange the same code twice.
    if (this.attemptedCodes.has(codeHash)) throw new WechatPhoneError('wechat_phone_code_invalid');
    if (this.attemptedCodes.size >= 10000) throw new WechatPhoneError('wechat_unavailable');
    this.attemptedCodes.set(codeHash, this.now() + 5 * 60_000);
    const data = await this.post(`https://api.weixin.qq.com/wxa/business/getuserphonenumber?access_token=${encodeURIComponent(accessToken)}`, { code });
    if (typeof data.errcode === 'number' && data.errcode !== 0) {
      if (invalidAccessToken.has(data.errcode)) {
        this.cache = null;
        this.refreshInvalidToken = true;
        // The next newly-authorized code gets a fresh token. Do not replay this code.
        throw new WechatPhoneError('wechat_unavailable');
      }
      if (data.errcode === 40029) throw new WechatPhoneError('wechat_phone_code_invalid');
      if (data.errcode === 40013) throw new WechatPhoneError('wechat_identity_mismatch');
      throw new WechatPhoneError(configErrors.has(data.errcode) ? 'wechat_not_configured' : 'wechat_unavailable');
    }
    const info = jsonObject(data.phone_info);
    const watermark = jsonObject(info?.watermark);
    if (!info || !watermark || typeof watermark.appid !== 'string') throw new WechatPhoneError('wechat_exchange_failed');
    if (watermark.appid !== config.appId) throw new WechatPhoneError('wechat_identity_mismatch');
    if (info.countryCode !== '86') throw new WechatPhoneError('phone_region_not_supported');
    if (typeof info.purePhoneNumber !== 'string' || !/^1[3-9]\d{9}$/.test(info.purePhoneNumber)) throw new WechatPhoneError('wechat_exchange_failed');
    return info.purePhoneNumber;
  }
}
