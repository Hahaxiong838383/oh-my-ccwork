import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync,realpathSync,writeFileSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareCanaryEnvironment} from '../src/search-canary-guard.js';

const agent='p003-search-verification-20261026',sn='BJP00399999999999901';
function fixture(run:(env:NodeJS.ProcessEnv,root:string)=>void) {
 const root=realpathSync(mkdtempSync(join(tmpdir(),'p003-verifier-')));
 try {run({SEARCH_CANARY_ROOT:root,SEARCH_CANARY_AGENT:agent,SEARCH_CANARY_SN:sn,
  SEARCH_CANARY_MAX_JOBS:'1',SEARCH_WORKER_ACCOUNT_ID:'search-canary-worker',
  CUSTOM_LLM_API_KEY:'synthetic-key',AUTH_JWT_SECRET:'synthetic-secret'},root);}
 finally {rmSync(root,{recursive:true,force:true});}
}
test('verification rejects real devices, extra slots and unknown profile names',()=>fixture(env=>{
 for(const delta of [{SEARCH_CANARY_SN:'BJP00326060100100004'},
  {SEARCH_CANARY_SN:sn+',BJP00326070803800006'},{SEARCH_CANARY_MAX_JOBS:'2'},
  {SEARCH_CANARY_AGENT:'p003-search-verification-typo'}]) {
  assert.throws(()=>prepareCanaryEnvironment({...env,...delta}),/canary_verification|canary_agent/);
 }
}));
test('verification resume authority stays in its isolated data directory',()=>fixture((env,root)=>{
 const authority=join(root,'data/devices.db');
 const ready={...env,SEARCH_RESUME_V1:'1',SEARCH_RESUME_AUTHORITY_DB_PATH:authority};
 prepareCanaryEnvironment(ready);
 assert.equal(ready.DEVICES_DB_PATH,authority);
 for(const path of ['/opt/p003/server/data/devices.db','/opt/p003/search-canary-20261021/brain/data/devices.db',join(root,'other.db')]) {
  assert.throws(()=>prepareCanaryEnvironment({...ready,SEARCH_RESUME_AUTHORITY_DB_PATH:path}),/canary_resume_authority/);
 }
 writeFileSync(join(root,'outside'),'synthetic');symlinkSync(join(root,'outside'),authority);
 assert.throws(()=>prepareCanaryEnvironment(ready),/canary_resume_authority|canary_link/);
}));
