/** Provider responses may contain account IDs, request IDs or echoed input. Keep only reviewed codes. */
const knownCodes = new Set([
  'InvalidSubscription', 'InvalidApiKey', 'AuthenticationError', 'AccessDenied',
  'RateLimitExceeded', 'QuotaExceeded', 'InvalidParameter', 'ModelNotFound', 'ModelNotOpen',
]);

export function providerErrorDetails(error: unknown): { http_status: number | null; code: string } {
  const value = error as { httpStatus?: unknown; providerCode?: unknown } | null;
  const status = value?.httpStatus;
  return {
    http_status: Number.isInteger(status) && Number(status) >= 400 && Number(status) <= 599 ? Number(status) : null,
    code: typeof value?.providerCode === 'string' && knownCodes.has(value.providerCode) ? value.providerCode : 'UpstreamError',
  };
}

export class ProviderHttpError extends Error {
  readonly providerCode: string;
  constructor(readonly httpStatus: number, responseBody: string) {
    let code: unknown;
    try { code = JSON.parse(responseBody)?.error?.code; } catch { /* HTML/plain text never enters diagnostics. */ }
    const safe = providerErrorDetails({ httpStatus, providerCode: code });
    // message can reach a voice/UI fallback; operator details stay in structured fields.
    super('模型服务暂时不可用');
    this.name = 'ProviderHttpError';
    this.providerCode = safe.code;
  }
}

type Route = 'main' | 'fallback';
type Observation = { at_ms: number; outcome: 'content' | 'failure'; http_status: number | null; code: string | null };
const last: Partial<Record<Route, Observation>> = {};
export function recordRaceContent(route: Route): void {
  last[route] = { at_ms: Date.now(), outcome: 'content', http_status: null, code: null };
}
export function recordRaceFailure(route: Route, error: Error): void {
  const observation: Observation = { at_ms: Date.now(), outcome: 'failure', ...providerErrorDetails(error) };
  last[route] = observation;
  console.warn('[race-provider]', JSON.stringify({ route, ...observation }));
}
export function raceProviderHealth(now = Date.now()) {
  const route = (name: Route) => last[name] ? { ...last[name], stale: now - last[name]!.at_ms > 300_000 } : { outcome: 'unknown' as const };
  return { main: route('main'), fallback: route('fallback'), degraded: Object.values(last).some(v => v.outcome === 'failure') };
}
