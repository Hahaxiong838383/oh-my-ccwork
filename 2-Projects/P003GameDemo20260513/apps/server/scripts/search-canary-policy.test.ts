import assert from 'node:assert/strict';
import { selectSearchCanaryAgent } from '../src/search-canary-policy.js';
const input = {
  sn: 'BJP00326070803800006', baselineAgent: 'baseline-first-turn', nowMs: 1000,
  enabled: true, allowlist: ['BJP00326070803800006'], expiresAtMs: 9000,
  leaseUntilMs: 5000, canaryAgent: 'p003-search-canary-20261021', contractCompatible: true,
};
assert.equal(selectSearchCanaryAgent(input), input.canaryAgent);
for (const delta of [
  {enabled:false}, {allowlist:[]}, {sn:'BJP00326060100200003'}, {sn:'03800006'},
  {expiresAtMs:1000}, {leaseUntilMs:1000}, {contractCompatible:false},
  {expiresAtMs:NaN}, {leaseUntilMs:Infinity}, {leaseUntilMs:100_000},
  {expiresAtMs:1000+7200001}, {canaryAgent:'rust-worker'},
]) assert.equal(selectSearchCanaryAgent({...input,...delta}), input.baselineAgent, JSON.stringify(delta));
console.log('canary policy: positive + 12 fail-closed cases passed');
