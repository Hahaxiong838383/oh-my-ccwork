import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const root=mkdtempSync(join(tmpdir(),'p003-release-'));
for(const key of ['CONFIG','DEVICES','ACCOUNTS','PROFILE','CONVERSATION','FEEDBACK'])process.env[`${key}_DB_PATH`]=join(root,key+'.db');
Object.assign(process.env,{SEARCH_ENABLED:'1',SEARCH_TASK_DB_PATH:join(root,'search.db'),SEARCH_ROUTING_DB_PATH:join(root,'routing.db'),SEARCH_ALLOWED_DOMAINS:'cstm.org.cn',DEEPSEEK_API_KEY:'synthetic',AUTH_JWT_SECRET:'synthetic',SEARCH_WORKER_ACCOUNT_ID:'worker'});
delete process.env.SEARCH_CANARY_ROOT;
const runtime=await import('../src/tools/search-runtime.js');
const {configStore}=await import('../src/config-store.js');
const {deviceRegistryStore:devices}=await import('../src/device-registry-store.js');
const {searchChatPolicy}=await import('../src/tools/search-chat-policy.js');
const first='BJP00326060100100004',second='BJP00326070803800006',fresh='BJP00326102700100005';
const set=(k:string,v:string)=>configStore.setFlag('p003.search.'+k,v,'synthetic-test');
const add=(sn:string)=>{devices.add(sn,'synthetic');devices.setAccountId(sn,'account-'+sn);};
test('P1 all_registered admits present and later active devices; legacy candidate flag cannot enable main P2',()=>{
 try{
  add(first);set('enabled','1');set('scope','all_registered');set('allowlist','[]');set('exclusions','[]');set('tools','1');
  assert.equal((runtime.searchSettings() as any).scope,'all_registered');
  const allowed=(runtime as any).searchDeviceAllowed;
  assert.equal(typeof allowed,'function');
  assert.equal(allowed(first),true);assert.equal(allowed(fresh),false);
  add(fresh);assert.equal(allowed(fresh),true,'no restart/list-copy for newly registered device');
  assert.equal(runtime.searchSettings().tools,false,'P1 must not execute Tool Calls');
  set('exclusions',JSON.stringify([fresh]));assert.equal(allowed(fresh),false);assert.equal(allowed(first),true);
  devices.setStatus(first,'disabled');assert.equal(allowed(first),false);devices.setStatus(first,'active');
  set('exclusions','{bad');assert.equal(allowed(first),false,'malformed exclusion cannot broaden scope');
  set('exclusions','[]');set('scope','typo');assert.equal(allowed(first),false);
  set('scope','allowlist');assert.equal(allowed(first),false,'empty list remains closed');
  set('scope','all_registered');set('enabled','0');assert.equal(allowed(first),false);
 }finally{runtime.closeSearchRuntime();}
});
test('isolated P2 requires exact candidate environment/list agreement and valid expiry',()=>{
 try{
  add(second);process.env.SEARCH_CANARY_ROOT=root;process.env.SEARCH_CANARY_SN=[first,second].join(',');
  set('canary.expires_at_ms',String(Date.now()+60000));set('enabled','1');set('tools','1');set('scope','all_registered');
  assert.equal(runtime.searchSettings().enabled,false,'candidate must reject all-device scope');
  set('scope','allowlist');set('allowlist',JSON.stringify([first,second]));
  assert.equal(runtime.searchSettings().tools,true);assert.equal((runtime as any).searchDeviceAllowed(fresh),false);
  set('allowlist',JSON.stringify([first,second,fresh]));assert.equal(runtime.searchSettings().tools,false,'environment/list mismatch cannot enable tools');
  process.env.SEARCH_CANARY_SN=[first,second,fresh].join(',');assert.equal(runtime.searchSettings().tools,true,'the existing three-device candidate contract is preserved');
  set('allowlist',JSON.stringify([first,second,fresh,'BJP00399999999999901']));assert.equal(runtime.searchSettings().enabled,false,'independent candidate scope remains bounded');
  process.env.SEARCH_CANARY_SN=[first,second].join(',');
  set('allowlist',JSON.stringify([first,second]));set('canary.expires_at_ms','1');assert.equal(runtime.searchSettings().enabled,false);
 }finally{delete process.env.SEARCH_CANARY_ROOT;runtime.closeSearchRuntime();}
});
test('P1 capability retains normal onboarding/personality; isolated P2 wording never enters P1',()=>{
 const p=searchChatPolicy({candidate:false,enabled:true,role:'device',room:'sn-'+first+'-123',allowed:[first],live:true} as any);
 assert.ok(p.instruction.includes('后台搜索'));
 assert.equal(p.suppressOnboarding,false);
 assert.doesNotMatch(p.instruction,/隔离身份|不推断或补造过去/);
});
process.on('exit',()=>rmSync(root,{recursive:true,force:true}));
