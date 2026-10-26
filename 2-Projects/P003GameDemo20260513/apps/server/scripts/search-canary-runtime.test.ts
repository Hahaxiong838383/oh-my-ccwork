import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const root=mkdtempSync(join(tmpdir(),'canary-lease-audit-'));
process.env.CONFIG_DB_PATH=join(root,'config.db');
// Import without a configured file so no background interval races the fake clock.
delete process.env.SEARCH_CANARY_HEALTH_FILE;
const {configStore}=await import('../src/config-store.js');
const {searchCanarySelection,refreshSearchCanaryLease}=await import('../src/search-canary-runtime.js');
const originalNow=Date.now;Date.now=()=>1_000_000;
const sn='BJP00326060100100004',agent='p003-search-canary-20261021',baseline='baseline-first-turn';
for(const [key,value]of Object.entries({enabled:'1',allowlist:JSON.stringify([sn]),expires_at_ms:'2000000',agent}))
 configStore.setFlag('p003.search.canary.'+key,value,'synthetic-test');
process.env.SEARCH_CANARY_HEALTH_FILE=join(root,'lease.json');
const write=async(v:unknown)=>{writeFileSync(join(root,'lease.json'),JSON.stringify(v));await refreshSearchCanaryLease();};
const lease={agent,generation:'test',until_ms:1_015_000,ordered_pcm_v1:true,at_ms:1_000_000,jobs:0,max_jobs:2,registered:true};
try{
 await write(lease);
 let d=searchCanarySelection(sn,baseline,true);
 assert.equal(d.agent,agent);assert.equal(d.reason,'selected');assert.equal(d.leaseAgeMs,0);
 assert.equal(d.leaseJobs,0);assert.equal(d.leaseMaxJobs,2);assert.equal(d.leaseRemainingMs,15000);
 await write({...lease,jobs:2,until_ms:0});
 d=searchCanarySelection(sn,baseline,true);
 assert.equal(d.agent,baseline);assert.equal(d.reason,'lease_invalid');assert.equal(d.leaseJobs,2);
 // File updates do not magically update the signer's cached observation.
 writeFileSync(join(root,'lease.json'),JSON.stringify(lease));
 assert.equal(searchCanarySelection(sn,baseline,true).reason,'lease_invalid');
 await refreshSearchCanaryLease();assert.equal(searchCanarySelection(sn,baseline,true).reason,'selected');
 Date.now=()=>1_015_000;assert.equal(searchCanarySelection(sn,baseline,true).reason,'lease_invalid');
 Date.now=()=>1_000_000;
 // Old heartbeat schema remains compatible; missing audit fields stay unknown.
 await write({agent,generation:'legacy',until_ms:1_010_000,ordered_pcm_v1:true});
 d=searchCanarySelection(sn,baseline,true);assert.equal(d.agent,agent);assert.equal(d.leaseJobs,null);assert.equal(d.leaseAgeMs,null);
 writeFileSync(join(root,'lease.json'),'{bad');await refreshSearchCanaryLease();
 assert.equal(searchCanarySelection(sn,baseline,true).reason,'lease_invalid');
 await write({...lease,at_ms:1_000_001,jobs:'2',max_jobs:-1});
 d=searchCanarySelection(sn,baseline,true);assert.equal(d.agent,agent);assert.equal(d.leaseAgeMs,null);assert.equal(d.leaseJobs,null);assert.equal(d.leaseMaxJobs,null);
 configStore.setFlag('p003.search.canary.allowlist','{bad','synthetic-test');
 d=searchCanarySelection(sn,baseline,true);assert.equal(d.agent,baseline);assert.equal(d.reason,'config_invalid');
 console.log('canary runtime: capacity, cache, expiry, legacy/invalid telemetry and fail-closed passed');
}finally{Date.now=originalNow;rmSync(root,{recursive:true,force:true});}
