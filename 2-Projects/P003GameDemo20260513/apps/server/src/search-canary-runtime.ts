// Shared signer patch: no search executor imports, no network on the request path.
import { readFile } from 'node:fs/promises';
import { configStore } from './config-store.js';
import { SEARCH_CANARY_AGENT, selectSearchCanaryAgent } from './search-canary-policy.js';
type Lease = { agent: string; until_ms: number; ordered_pcm_v1: boolean; generation: string };
let lease: Lease | null = null;
export async function refreshSearchCanaryLease() {
  try {
    const path = process.env.SEARCH_CANARY_HEALTH_FILE;
    if (!path) { lease = null; return; }
    const raw = await readFile(path, 'utf8');
    if (raw.length > 2048) throw new Error('oversize');
    const v = JSON.parse(raw);
    if (v.agent !== SEARCH_CANARY_AGENT || !Number.isFinite(v.until_ms) || typeof v.generation !== 'string') throw new Error('invalid');
    lease = v;
  } catch { lease = null; }
}
if (process.env.SEARCH_CANARY_HEALTH_FILE) {
  void refreshSearchCanaryLease();
  setInterval(() => void refreshSearchCanaryLease(), 5000).unref();
}
export function searchCanarySelection(sn: string, baselineAgent: string, ordered: boolean) {
  try {
    const flag = (k: string) => configStore.getFlag(`p003.search.canary.${k}`)?.value;
    const allowed = JSON.parse(flag('allowlist') ?? '[]');
    const expires = Number(flag('expires_at_ms'));
    const agent = selectSearchCanaryAgent({ sn, baselineAgent, nowMs: Date.now(),
      enabled: flag('enabled') === '1', allowlist: Array.isArray(allowed) ? allowed : [],
      expiresAtMs: expires, leaseUntilMs: lease?.until_ms ?? 0,
      canaryAgent: flag('agent') ?? '', contractCompatible: !ordered || lease?.ordered_pcm_v1 === true });
    return { agent, canary: agent === SEARCH_CANARY_AGENT && agent !== baselineAgent,
      expiresAtMs: expires, generation: lease?.generation ?? '' };
  } catch { return { agent: baselineAgent, canary: false, expiresAtMs: 0, generation: '' }; }
}
