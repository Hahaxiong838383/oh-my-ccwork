// Shared signer patch: no search executor imports, no network on the request path.
import { readFile } from 'node:fs/promises';
import { configStore } from './config-store.js';
import { SEARCH_CANARY_AGENT, explainSearchCanarySelection } from './search-canary-policy.js';
type Lease = { agent: string; until_ms: number; ordered_pcm_v1: boolean; generation: string;
  at_ms?: unknown; jobs?: unknown; max_jobs?: unknown; registered?: unknown };
let lease: Lease | null = null;
export async function refreshSearchCanaryLease() {
  try {
    const path = process.env.SEARCH_CANARY_HEALTH_FILE;
    if (!path) { lease = null; return; }
    const raw = await readFile(path, 'utf8');
    if (raw.length > 2048) throw new Error('oversize');
    const v = JSON.parse(raw);
    if (v.agent !== SEARCH_CANARY_AGENT || !Number.isFinite(v.until_ms) || typeof v.generation !== 'string' || !v.generation || v.generation.length > 128) throw new Error('invalid');
    lease = v;
  } catch { lease = null; }
}
if (process.env.SEARCH_CANARY_HEALTH_FILE) {
  void refreshSearchCanaryLease();
  setInterval(() => void refreshSearchCanaryLease(), 5000).unref();
}
export function searchCanarySelection(sn: string, baselineAgent: string, ordered: boolean) {
  const now=Date.now();
  // Optional observations never authorize dispatch or change old lease compatibility.
  const integer=(v:unknown):number|null=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:null;
  const observedAt=integer(lease?.at_ms);
  const observation={leaseRemainingMs:lease?lease.until_ms-now:null,
    leaseAgeMs:observedAt!==null&&observedAt<=now?now-observedAt:null,
    leaseJobs:integer(lease?.jobs),leaseMaxJobs:integer(lease?.max_jobs),
    leaseRegistered:typeof lease?.registered==='boolean'?lease.registered:null};
  try {
    const flag = (k: string) => configStore.getFlag(`p003.search.canary.${k}`)?.value;
    const allowed = JSON.parse(flag('allowlist') ?? '[]');
    const expires = Number(flag('expires_at_ms'));
    const {agent,reason} = explainSearchCanarySelection({ sn, baselineAgent, nowMs: now,
      enabled: flag('enabled') === '1', allowlist: Array.isArray(allowed) ? allowed : [],
      expiresAtMs: expires, leaseUntilMs: lease?.until_ms ?? 0,
      canaryAgent: flag('agent') ?? '', contractCompatible: !ordered || lease?.ordered_pcm_v1 === true });
    return { agent, canary: agent === SEARCH_CANARY_AGENT && agent !== baselineAgent,
      reason,...observation,expiresAtMs: expires, generation: lease?.generation ?? '' };
  } catch { return { agent: baselineAgent, canary: false, reason:'config_invalid' as const,
    ...observation,expiresAtMs: 0, generation: '' }; }
}
