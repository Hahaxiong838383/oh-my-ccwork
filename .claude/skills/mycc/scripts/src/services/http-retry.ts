/**
 * 通用 HTTP 重试机制
 * EvoMap Capsule: GDI 66.0 - sha256:6c8b2bef4652d5113cc802b6995a8e9f5da8b5b1ffe3d6bc639e2ca8ce27edec
 *
 * 功能：
 * - 指数退避重试（默认 3 次）
 * - AbortController 超时控制（默认 10s）
 * - 自动处理 429 限流（遵守 Retry-After 头）
 * - 覆盖场景：TimeoutError, ECONNRESET, ECONNREFUSED, 429
 */

export interface RetryOptions {
  maxRetries?: number;       // 最大重试次数，默认 3
  timeoutMs?: number;        // 单次请求超时，默认 10000ms
  baseDelayMs?: number;      // 首次重试基础延迟，默认 500ms
  retryOnStatus?: number[];  // 触发重试的 HTTP 状态码，默认 [429, 502, 503, 504]
}

const RETRYABLE_STATUS = [429, 502, 503, 504];
const RETRYABLE_ERRORS = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'TimeoutError'];

function isRetryableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return RETRYABLE_ERRORS.some(code => err.message.includes(code) || err.name.includes(code));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 带重试的 fetch 封装
 * 用法：直接替换 fetch() 调用
 */
export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  options: RetryOptions = {}
): Promise<Response> {
  const {
    maxRetries = 3,
    timeoutMs = 10_000,
    baseDelayMs = 500,
    retryOnStatus = RETRYABLE_STATUS,
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });

      clearTimeout(timer);

      // 429 特殊处理：遵守 Retry-After
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : baseDelayMs * Math.pow(2, attempt);
        if (attempt < maxRetries) {
          await sleep(waitMs);
          continue;
        }
      }

      // 其他可重试状态码
      if (retryOnStatus.includes(response.status) && attempt < maxRetries) {
        const waitMs = baseDelayMs * Math.pow(2, attempt);
        await sleep(waitMs);
        lastError = new Error(`HTTP ${response.status}`);
        continue;
      }

      return response;
    } catch (err) {
      clearTimeout(timer);
      lastError = err;

      // AbortController 触发的超时
      if (err instanceof Error && err.name === 'AbortError') {
        lastError = new Error(`TimeoutError: request to ${url} timed out after ${timeoutMs}ms`);
      }

      if (attempt < maxRetries && isRetryableError(lastError)) {
        const waitMs = baseDelayMs * Math.pow(2, attempt);
        await sleep(waitMs);
        continue;
      }

      throw lastError;
    }
  }

  throw lastError;
}

/**
 * JSON 快捷方法：发 POST JSON，返回解析后的对象
 */
export async function postJSON<T = unknown>(
  url: string,
  body: unknown,
  options: RetryOptions = {}
): Promise<T> {
  const response = await fetchWithRetry(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    options
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  }

  return response.json() as Promise<T>;
}
