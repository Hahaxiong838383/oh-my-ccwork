import { randomUUID } from 'node:crypto';
import type { ServerConfig } from './config';
import { TtlCache } from './cache';

type FetchLike = typeof fetch;
type CcRequest = {
  path: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  userIp: string;
  requestId?: string;
  idempotencyKey?: string;
  body?: unknown;
  cacheKey?: string;
  cacheTtlMs?: number;
} & ({ parentJwt: string; partnerId?: never; partnerKey?: never } | { parentJwt?: never; partnerId: string; partnerKey: string });

export class CcHttpError extends Error {
  constructor(public readonly status: number, public readonly payload: unknown, public readonly retryAfterSeconds?: number) {
    super(`cc request failed: ${status}`);
  }
}

export function normalizeRequestId(value?: string) {
  return value && value.length <= 96 ? value : randomUUID();
}

export class CcClient {
  constructor(
    private readonly config: ServerConfig,
    private readonly cache = new TtlCache(),
    private readonly fetcher: FetchLike = fetch,
  ) {}

  async request<T>(input: CcRequest): Promise<T> {
    const method = input.method || 'GET';
    if (method === 'GET' && input.cacheKey) {
      const cached = this.cache.get<T>(input.cacheKey);
      if (cached !== undefined) return cached;
    }
    const headers = new Headers({
      'X-Forwarded-For': input.userIp,
      'X-Request-Id': normalizeRequestId(input.requestId),
      'User-Agent': `${this.config.serviceName}/${this.config.serviceVersion}`,
      Accept: 'application/json',
    });
    if ('parentJwt' in input && input.parentJwt !== undefined) headers.set('Authorization', `Bearer ${input.parentJwt}`);
    else if ('partnerId' in input && input.partnerId !== undefined && input.partnerKey !== undefined) {
      headers.set('X-Partner-Id', input.partnerId);
      headers.set('X-Partner-Key', input.partnerKey);
    }
    if (input.body !== undefined) headers.set('Content-Type', 'application/json');
    if (input.idempotencyKey) headers.set('Idempotency-Key', input.idempotencyKey);
    const response = await this.fetcher(`${this.config.ccBaseUrl}${input.path}`, {
      method,
      headers,
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
    });
    const payload = await readPayload(response);
    if (!response.ok) {
      const retry = response.headers.get('retry-after');
      const retryAfterSeconds = retry ? Number(retry) : typeof payload === 'object' && payload && 'retry_after_s' in payload ? Number(payload.retry_after_s) : undefined;
      throw new CcHttpError(response.status, payload, Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined);
    }
    if (method === 'GET' && input.cacheKey) this.cache.set(input.cacheKey, payload, input.cacheTtlMs || this.config.cacheTtlMs);
    return payload as T;
  }

  invalidateAccount(accountId: string) {
    this.cache.deleteByPrefix(`${accountId}:`);
  }
}

async function readPayload(response: Response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text) as unknown; } catch { return { ok: false, error: 'invalid_upstream_response', message: text }; }
}
