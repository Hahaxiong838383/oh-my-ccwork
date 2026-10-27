/** Provider responses may contain account IDs, request IDs or echoed input. Keep only reviewed codes. */
const knownCodes = new Set([
  'InvalidSubscription', 'InvalidApiKey', 'AuthenticationError', 'AccessDenied',
  'RateLimitExceeded', 'QuotaExceeded', 'InvalidParameter', 'ModelNotFound', 'ModelNotOpen', 'InvalidEndpointOrModel.NotFound',
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

/** Candidate fallback only. No timer, queue or request on the main critical path.
 * After a cooldown the next conversation may start one concurrent probe. */
export class ProviderCircuit {
  private retryAt = 0;
  private failures = 0;
  private sequence = 0;
  private cooldown = 1000;
  private probe: number | null = null;
  constructor(private readonly now: () => number = Date.now) {}
  acquire(): number | null {
    if (this.probe !== null || this.now() < this.retryAt) return null;
    const ticket = ++this.sequence;
    if (this.failures) { this.probe = ticket; this.retryAt = this.now() + this.cooldown; }
    return ticket;
  }
  content(_ticket: number): void { this.failures = 0; this.retryAt = 0; }
  failure(_ticket: number, error: Error): void {
    const {http_status,code}=providerErrorDetails(error);
    const configuration = [401,403,404].includes(http_status ?? 0)
      || ['InvalidSubscription','InvalidApiKey','AuthenticationError','AccessDenied','ModelNotFound','ModelNotOpen','InvalidParameter'].includes(code);
    this.failures++;
    this.cooldown = configuration ? 600_000 : Math.min(30_000, 1000 * 2 ** Math.min(this.failures - 1, 5));
    this.retryAt = this.now() + this.cooldown;
  }
  release(ticket: number): void { if (this.probe === ticket) this.probe = null; }
  snapshot() {
    return { state: this.probe !== null ? 'half_open' : this.failures ? 'open' : 'closed',
      retry_at_ms: this.retryAt || null };
  }
}
export const fallbackCircuit = new ProviderCircuit();

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
  return { main: route('main'), fallback: {...route('fallback'), ...(process.env.SEARCH_CANARY_ROOT ? {circuit:fallbackCircuit.snapshot()} : {})},
    verified: (['main','fallback'] as const).every(name=>last[name]?.outcome==='content' && now-last[name]!.at_ms<=300_000),
    degraded: Object.values(last).some(v => v.outcome === 'failure') };
}
