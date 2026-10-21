export type CanaryInput = {
  sn: string; baselineAgent: string; nowMs: number; enabled: boolean; allowlist: readonly string[];
  expiresAtMs: number; leaseUntilMs: number; canaryAgent: string; contractCompatible: boolean;
};
export const SEARCH_CANARY_AGENT = 'p003-search-canary-20261021';
export function selectSearchCanaryAgent(i: CanaryInput): string {
  const valid = i.enabled === true && /^BJP003\d{14}$/.test(i.sn)
    && i.allowlist.length === 1 && i.allowlist[0] === i.sn
    && i.canaryAgent === SEARCH_CANARY_AGENT && i.contractCompatible === true
    && Number.isFinite(i.nowMs) && Number.isFinite(i.expiresAtMs) && Number.isFinite(i.leaseUntilMs)
    // 2026-10-21: explicitly authorized next-day single-device window; fixed cutoff, no renewal.
    // Existing ticket contract requires >=5s after second-level JWT rounding.
    && i.expiresAtMs - i.nowMs >= 6000 && i.expiresAtMs - i.nowMs <= 36 * 3600_000
    && i.leaseUntilMs > i.nowMs && i.leaseUntilMs - i.nowMs <= 15_000;
  return valid ? i.canaryAgent : i.baselineAgent;
}
