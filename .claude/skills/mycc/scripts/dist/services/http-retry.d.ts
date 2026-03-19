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
    maxRetries?: number;
    timeoutMs?: number;
    baseDelayMs?: number;
    retryOnStatus?: number[];
}
/**
 * 带重试的 fetch 封装
 * 用法：直接替换 fetch() 调用
 */
export declare function fetchWithRetry(url: string, init?: RequestInit, options?: RetryOptions): Promise<Response>;
/**
 * JSON 快捷方法：发 POST JSON，返回解析后的对象
 */
export declare function postJSON<T = unknown>(url: string, body: unknown, options?: RetryOptions): Promise<T>;
//# sourceMappingURL=http-retry.d.ts.map