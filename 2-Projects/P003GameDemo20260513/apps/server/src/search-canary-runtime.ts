// Shared signer patch: no search executor imports, no network on the request path.
import { readFile } from 'node:fs/promises';
import { configStore } from './config-store.js';
import { SEARCH_CANARY_AGENT, LISTENING_CANARY_AGENT, isSearchCanaryAgent, explainSearchCanarySelection } from './search-canary-policy.js';
type Lease = { agent: string; until_ms: number; ordered_pcm_v1: boolean; generation: string;
  at_ms?: unknown; jobs?: unknown; max_jobs?: unknown; registered?: unknown };
let lease: Lease | null = null;
export async function refreshSearchCanaryLease() {
  try {
    const agent=configStore.getFlag('p003.search.canary.agent')?.value??SEARCH_CANARY_AGENT;
    if(!isSearchCanaryAgent(agent)){lease=null;return;}
    const path = agent===LISTENING_CANARY_AGENT ? process.env.LISTENING_CANARY_HEALTH_FILE : process.env.SEARCH_CANARY_HEALTH_FILE;
    if (!path) { lease = null; return; }
    const raw = await readFile(path, 'utf8');
    if (raw.length > 2048) throw new Error('oversize');
    const v = JSON.parse(raw);
    if (v.agent !== agent || !Number.isFinite(v.until_ms) || typeof v.generation !== 'string' || !v.generation || v.generation.length > 128) throw new Error('invalid');
    lease = v;
  } catch { lease = null; }
}
if (process.env.SEARCH_CANARY_HEALTH_FILE || process.env.LISTENING_CANARY_HEALTH_FILE) {
  void refreshSearchCanaryLease();
  setInterval(() => void refreshSearchCanaryLease(), 5000).unref();
}
export function searchCanarySelection(sn: string, baselineAgent: string, ordered: boolean) {
  const now=Date.now();
  let observation:{leaseRemainingMs:number|null;leaseAgeMs:number|null;leaseJobs:number|null;leaseMaxJobs:number|null;leaseRegistered:boolean|null}={leaseRemainingMs:null,leaseAgeMs:null,leaseJobs:null,leaseMaxJobs:null,leaseRegistered:null};
  try {
  const selected=configStore.getFlag('p003.search.canary.agent')?.value;
  const current=lease?.agent===selected?lease:null;
  // Optional observations never authorize dispatch or change old lease compatibility.
  const integer=(v:unknown):number|null=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:null;
  const observedAt=integer(current?.at_ms);
  observation={leaseRemainingMs:current?current.until_ms-now:null,
    leaseAgeMs:observedAt!==null&&observedAt<=now?now-observedAt:null,
    leaseJobs:integer(current?.jobs),leaseMaxJobs:integer(current?.max_jobs),
    leaseRegistered:typeof current?.registered==='boolean'?current.registered:null};
    const flag = (k: string) => configStore.getFlag(`p003.search.canary.${k}`)?.value;
    const allowed = JSON.parse(flag('allowlist') ?? '[]');
    const expires = Number(flag('expires_at_ms'));
    const {agent,reason} = explainSearchCanarySelection({ sn, baselineAgent, nowMs: now,
      enabled: flag('enabled') === '1', allowlist: Array.isArray(allowed) ? allowed : [],
      expiresAtMs: expires, leaseUntilMs: current?.until_ms ?? 0,
      canaryAgent: flag('agent') ?? '', contractCompatible: !ordered || current?.ordered_pcm_v1 === true });
    return { agent, canary: isSearchCanaryAgent(agent) && agent !== baselineAgent,
      reason,...observation,expiresAtMs: expires, generation: current?.generation ?? '' };
  } catch { return { agent: baselineAgent, canary: false, reason:'config_invalid' as const,
    ...observation,expiresAtMs: 0, generation: '' }; }
}
