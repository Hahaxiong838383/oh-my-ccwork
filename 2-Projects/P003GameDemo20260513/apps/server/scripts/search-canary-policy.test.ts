import assert from 'node:assert/strict';
import { selectSearchCanaryAgent, explainSearchCanarySelection } from '../src/search-canary-policy.js';
const input = {
  sn: 'BJP00326070803800006', baselineAgent: 'baseline-first-turn', nowMs: 1000,
  enabled: true, allowlist: ['BJP00326070803800006'], expiresAtMs: 9000,
  leaseUntilMs: 5000, canaryAgent: 'p003-search-canary-20261021', contractCompatible: true,
};
assert.equal(selectSearchCanaryAgent(input), input.canaryAgent);
for (const delta of [
  {enabled:false}, {allowlist:[]}, {sn:'BJP00326060100200003'}, {sn:'03800006'},
  {expiresAtMs:1000}, {leaseUntilMs:1000}, {contractCompatible:false},
  {expiresAtMs:6500},
  {expiresAtMs:NaN}, {leaseUntilMs:Infinity}, {leaseUntilMs:100_000},
  {expiresAtMs:1000+168*3600_000+1}, {canaryAgent:'rust-worker'},
]) assert.equal(selectSearchCanaryAgent({...input,...delta}), input.baselineAgent, JSON.stringify(delta));
assert.equal(selectSearchCanaryAgent({...input,expiresAtMs:input.nowMs+168*3600_000}), input.canaryAgent);
console.log('canary policy: positive + 13 fail-closed cases passed');

const second='BJP00326060100100004';
for(const sn of [input.sn,second]) assert.equal(selectSearchCanaryAgent({...input,sn,allowlist:[input.sn,second]}),input.canaryAgent);
for(const allowlist of [[input.sn,input.sn],[input.sn,second,'BJP00326060100200003'],[input.sn,'00100004']]) assert.equal(selectSearchCanaryAgent({...input,allowlist}),input.baselineAgent);
console.log('two-device scope: both targets pass; duplicate/third/malformed fail closed');

assert.deepEqual(explainSearchCanarySelection(input),{agent:input.canaryAgent,reason:'selected'});
for(const [delta,reason] of [
 [{enabled:false},'disabled'],[{sn:'03800006'},'invalid_scope'],
 [{allowlist:[]},'invalid_scope'],[{sn:'BJP00326060100200003'},'not_target'],
 [{canaryAgent:'wrong'},'wrong_agent'],[{contractCompatible:false},'contract_incompatible'],
 [{expiresAtMs:6500},'window_invalid'],[{nowMs:NaN},'window_invalid'],
 [{leaseUntilMs:1000},'lease_invalid'],[{leaseUntilMs:Infinity},'lease_invalid'],
] as const){
 const result=explainSearchCanarySelection({...input,...delta});
 assert.deepEqual(result,{agent:input.baselineAgent,reason});
 assert.equal(selectSearchCanaryAgent({...input,...delta}),result.agent);
}
console.log('dispatch decision: selected + 10 explicit fallback reasons passed');
