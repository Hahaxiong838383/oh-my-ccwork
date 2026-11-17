import Taro from '@tarojs/taro';
import { snakeToCamel } from './dto';
import { ApiError } from './api-error';
export { ApiError } from './api-error';

const sessionKey = 'xiaoke.bff.session';

function apiBaseUrl() {
  return (process.env.TARO_APP_API_BASE_URL || 'http://127.0.0.1:4180').replace(/\/$/, '');
}

function requestId() {
  return `miniapp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function hasSession() {
  return Boolean(Taro.getStorageSync<string>(sessionKey));
}

export async function apiRequest<T>(path: string, options: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; data?: unknown; authenticated?: boolean; preserveSessionOnErrors?: string[] } = {}) {
  const session = options.authenticated === false ? '' : Taro.getStorageSync<string>(sessionKey);
  const response = await Taro.request<unknown>({
    url: `${apiBaseUrl()}${path}`,
    method: options.method || 'GET',
    data: options.data,
    timeout: 15000,
    header: {
      'X-Request-Id': requestId(),
      ...(session ? { Authorization: `Bearer ${session}` } : {}),
    },
  });
  const payload = snakeToCamel(response.data);
  if (response.statusCode >= 200 && response.statusCode < 300) {
    if (!payload || typeof payload !== 'object') throw new ApiError(502, { error: 'invalid_response' });
    return payload as T;
  }
  // A 的旧请求不能清除用户刚登录的 B 会话。
  const businessError = payload && typeof payload === 'object' ? (payload as { error?: string }).error : undefined;
  if (response.statusCode === 401 && session && !(businessError && options.preserveSessionOnErrors?.includes(businessError)) && Taro.getStorageSync<string>(sessionKey) === session) clearSession();
  const retryValue = response.header?.['Retry-After'] || response.header?.['retry-after'];
  const retryAfterSeconds = retryValue === undefined ? undefined : Number(retryValue);
  throw new ApiError(response.statusCode, payload, Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined);
}

export function saveSession(session: string) {
  Taro.setStorageSync(sessionKey, session);
}

export function clearSession() {
  Taro.removeStorageSync(sessionKey);
}

export function checkBffHealth() {
  return apiRequest<{ ok: true; service: string; version: string }>('/health');
}
