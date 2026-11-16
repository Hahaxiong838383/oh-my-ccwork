export type ServerConfig = {
  host: string;
  port: number;
  ccBaseUrl: string;
  serviceName: string;
  serviceVersion: string;
  cacheTtlMs: number;
  sessionTtlMs: number;
};

function positiveNumber(value: string | undefined, fallback: number, name: string) {
  const parsed = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} 必须是正数`);
  return parsed;
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const ccBaseUrl = env.CC_BASE_URL || 'https://kidshub-ai.hahaxiong.cc';
  const protocol = new URL(ccBaseUrl).protocol;
  if (protocol !== 'https:' && env.NODE_ENV === 'production') throw new Error('生产环境 CC_BASE_URL 必须使用 HTTPS');
  return {
    host: env.BFF_HOST || '127.0.0.1',
    port: positiveNumber(env.BFF_PORT, 4180, 'BFF_PORT'),
    ccBaseUrl: ccBaseUrl.replace(/\/$/, ''),
    serviceName: env.SERVICE_NAME || 'xiaoke-miniapp-bff',
    serviceVersion: env.SERVICE_VERSION || '0.1.0',
    cacheTtlMs: positiveNumber(env.CACHE_TTL_SECONDS, 45, 'CACHE_TTL_SECONDS') * 1000,
    sessionTtlMs: positiveNumber(env.SESSION_TTL_DAYS, 30, 'SESSION_TTL_DAYS') * 24 * 60 * 60 * 1000,
  };
}

export function loadIntegrationSecrets(env: NodeJS.ProcessEnv = process.env) {
  const names = ['WECHAT_APP_ID', 'WECHAT_APP_SECRET', 'CC_PARTNER_ID', 'CC_PARTNER_KEY'] as const;
  const missing = names.filter(name => !env[name]);
  if (missing.length) throw new Error(`缺少部署密钥：${missing.join(', ')}`);
  return {
    wechatAppId: env.WECHAT_APP_ID!,
    wechatAppSecret: env.WECHAT_APP_SECRET!,
    ccPartnerId: env.CC_PARTNER_ID!,
    ccPartnerKey: env.CC_PARTNER_KEY!,
  };
}
