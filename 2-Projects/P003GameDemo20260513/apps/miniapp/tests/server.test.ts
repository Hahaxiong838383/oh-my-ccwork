import { describe, expect, it, vi } from 'vitest';
import { TtlCache } from '../server/cache';
import { CcClient, normalizeRequestId } from '../server/cc-client';
import { loadServerConfig } from '../server/config';
import { maskPhone, maskSn, redact } from '../server/logger';
import { snakeToCamel } from '../src/services/dto';

describe('BFF 基础设施', () => {
  it('缓存到期后不再返回旧数据', () => {
    let now = 100;
    const cache = new TtlCache(() => now);
    cache.set('acct-1:dashboard', { value: 1 }, 50);
    expect(cache.get('acct-1:dashboard')).toEqual({ value: 1 });
    now = 150;
    expect(cache.get('acct-1:dashboard')).toBeUndefined();
  });

  it('日志会遮蔽手机号、SN 与密钥', () => {
    expect(maskPhone('13812345678')).toBe('138****5678');
    expect(maskSn('DEMO-1234567890')).toBe('***34567890');
    expect(redact({ phone: '13812345678', sn: 'DEMO-1234567890', authorization: 'Bearer abc' })).toEqual({ phone: '138****5678', sn: '***34567890', authorization: '[REDACTED]' });
  });

  it('请求 cc 时覆写必须的追踪与终端 IP 请求头', async () => {
    const fetcher = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('X-Forwarded-For')).toBe('203.0.113.8');
      expect(headers.get('X-Request-Id')).toBe('request-1');
      expect(headers.get('User-Agent')).toBe('test-bff/1.0');
      expect(headers.get('Authorization')).toBe('Bearer parent-jwt');
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const config = loadServerConfig({ CC_BASE_URL: 'https://example.com', SERVICE_NAME: 'test-bff', SERVICE_VERSION: '1.0' });
    const client = new CcClient(config, new TtlCache(), fetcher as typeof fetch);
    await expect(client.request({ path: '/api/test', parentJwt: 'parent-jwt', userIp: '203.0.113.8', requestId: 'request-1' })).resolves.toEqual({ ok: true });
  });

  it('保留 cc 的失败状态和错误正文', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'rate_limited', retry_after_s: 12 }), { status: 429 }));
    const client = new CcClient(loadServerConfig({ CC_BASE_URL: 'https://example.com' }), new TtlCache(), fetcher as typeof fetch);
    await expect(client.request({ path: '/api/test', parentJwt: 'jwt', userIp: '203.0.113.8' })).rejects.toMatchObject({ status: 429, payload: { ok: false, error: 'rate_limited', retry_after_s: 12 }, retryAfterSeconds: 12 });
    expect(normalizeRequestId('x'.repeat(97))).toHaveLength(36);
  });

  it('伙伴登录使用服务端伙伴请求头且不要求家长 JWT', async () => {
    const fetcher = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBeNull();
      expect(headers.get('X-Partner-Id')).toBe('partner-id');
      expect(headers.get('X-Partner-Key')).toBe('partner-key');
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const client = new CcClient(loadServerConfig({ CC_BASE_URL: 'https://example.com' }), new TtlCache(), fetcher as typeof fetch);
    await client.request({ path: '/api/auth/partner/phone-login', method: 'POST', partnerId: 'partner-id', partnerKey: 'partner-key', userIp: '203.0.113.8', body: {} });
  });

  it('小程序DTO层递归转换snake_case', () => {
    expect(snakeToCamel({ next_cursor: '2', child_items: [{ profile_status: 'complete' }] })).toEqual({ nextCursor: '2', childItems: [{ profileStatus: 'complete' }] });
  });
});
