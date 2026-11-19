export type CanaryInput = {
  sn: string; baselineAgent: string; nowMs: number; enabled: boolean; allowlist: readonly string[];
  expiresAtMs: number; leaseUntilMs: number; canaryAgent: string; contractCompatible: boolean;
};
export const SEARCH_CANARY_AGENT = 'p003-search-canary-20261021';
export const LISTENING_CANARY_AGENT = 'p003-search-listening-20261030';
export function isSearchCanaryAgent(agent:string):boolean {return agent===SEARCH_CANARY_AGENT||agent===LISTENING_CANARY_AGENT;}
export function validCanaryAllowlist(list: readonly string[]): boolean {
  return list.length>=1 && list.length<=3 && new Set(list).size===list.length && list.every(sn=>/^BJP003\d{14}$/.test(sn));
}
export function selectSearchCanaryAgent(i: CanaryInput): string {
  return explainSearchCanarySelection(i).agent;
}
export type CanaryReason = 'selected'|'disabled'|'invalid_scope'|'not_target'|'wrong_agent'|'contract_incompatible'|'window_invalid'|'lease_invalid';
export function explainSearchCanarySelection(i: CanaryInput): {agent:string;reason:CanaryReason} {
  const fallback=(reason:CanaryReason)=>({agent:i.baselineAgent,reason});
  if(i.enabled!==true)return fallback('disabled');
  if(!/^BJP003\d{14}$/.test(i.sn)||!validCanaryAllowlist(i.allowlist))return fallback('invalid_scope');
  if(!i.allowlist.includes(i.sn))return fallback('not_target');
  if(!isSearchCanaryAgent(i.canaryAgent))return fallback('wrong_agent');
    // 2026-10-26: authorized one-week window within a 168h horizon; fixed cutoff, no renewal.
    // Existing ticket contract requires >=5s after second-level JWT rounding.
  if(!Number.isFinite(i.nowMs)||!Number.isFinite(i.expiresAtMs)
    ||i.expiresAtMs-i.nowMs<6000||i.expiresAtMs-i.nowMs>168*3600_000)return fallback('window_invalid');
  if(!Number.isFinite(i.leaseUntilMs)||i.leaseUntilMs<=i.nowMs||i.leaseUntilMs-i.nowMs>15_000)return fallback('lease_invalid');
  // Without a valid lease, capabilities are unknown, not a proven mismatch.
  if(i.contractCompatible!==true)return fallback('contract_incompatible');
  return {agent:i.canaryAgent,reason:'selected'};
}
