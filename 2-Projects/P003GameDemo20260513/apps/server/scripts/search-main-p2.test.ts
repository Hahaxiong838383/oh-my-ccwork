import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SignJWT} from 'jose';
const root=mkdtempSync(join(tmpdir(),'p003-main-p2-'));
for(const key of ['CONFIG','DEVICES','ACCOUNTS','PROFILE','CONVERSATION','FEEDBACK'])process.env[`${key}_DB_PATH`]=join(root,key+'.db');
Object.assign(process.env,{SEARCH_ENABLED:'1',SEARCH_TASK_DB_PATH:join(root,'search.db'),SEARCH_ROUTING_DB_PATH:join(root,'routing.db'),SEARCH_ALLOWED_DOMAINS:'cstm.org.cn',DEEPSEEK_API_KEY:'synthetic',AUTH_JWT_SECRET:'synthetic',SEARCH_WORKER_ACCOUNT_ID:'worker'});
delete process.env.SEARCH_CANARY_ROOT;
const rt=await import('../src/tools/search-runtime.js');
const {configStore}=await import('../src/config-store.js');
const {deviceRegistryStore:devices}=await import('../src/device-registry-store.js');
const {searchChatPolicy}=await import('../src/tools/search-chat-policy.js');
const set=(k:string,v:string)=>configStore.setFlag('p003.search.'+k,v,'synthetic-test');
const sns=Array.from({length:16},(_,i)=>'BJP003999999'+String(i+1).padStart(8,'0'));
const add=(sn:string)=>{devices.add(sn,'synthetic');devices.setAccountId(sn,'account-'+sn);};
const token=(role='device',accountId='worker')=>new SignJWT({role,accountId}).setProtectedHeader({alg:'HS256'}).setIssuer('p003').setAudience('kidshub').setExpirationTime('5m').sign(new TextEncoder().encode(process.env.AUTH_JWT_SECRET));
test('主P2独立热开关覆盖16台及新注册设备，旧候选开关无效，身份和排除边界保持',async()=>{
 try{
  sns.forEach(add);set('enabled','1');set('scope','all_registered');set('exclusions','[]');set('tools','1');
  assert.equal(rt.searchSettings().tools,false,'old candidate flag must not enable main P2');
  set('main.tools','1');assert.equal(rt.searchSettings().tools,true);
  const headers={'x-p003-worker-token':await token()};
  for(const sn of sns){assert.equal(rt.searchDeviceAllowed(sn),true);assert.equal((await rt.searchTaskRoute.request('/?room=sn-'+sn+'-123',{headers})).status,200);}
  const fresh='BJP00399999900000017';assert.equal(rt.searchDeviceAllowed(fresh),false);add(fresh);assert.equal(rt.searchDeviceAllowed(fresh),true);
  const noAccount='BJP00399999900000018';devices.add(noAccount,'synthetic');assert.equal(rt.searchDeviceAllowed(noAccount),false);
  set('exclusions',JSON.stringify([sns[0]]));assert.equal(rt.searchDeviceAllowed(sns[0]),false);
  devices.setStatus(sns[1],'disabled');assert.equal(rt.searchDeviceAllowed(sns[1]),false);
  assert.equal((await rt.searchTaskRoute.request('/?room=sn-'+sns[2]+'-123',{headers:{'x-p003-worker-token':await token('parent')}})).status,401);
  assert.equal((await rt.searchTaskRoute.request('/?room=sn-'+sns[2]+'-123',{headers:{'x-p003-worker-token':await token('device','wrong')}})).status,401);
  assert.equal((await rt.searchTaskRoute.request('/?room=invalid',{headers})).status,401);
  set('exclusions','bad');assert.equal(rt.searchSettings().tools,false);
  set('exclusions','[]');set('scope','typo');assert.equal(rt.searchSettings().tools,false);
  set('scope','all_registered');set('main.tools','0');assert.equal(rt.searchSettings().tools,false);assert.equal(rt.searchDeviceAllowed(sns[2]),true,'rollback to P1 preserves enrollment');
  set('main.tools','1');set('enabled','0');assert.equal(rt.searchSettings().tools,false);
  set('enabled','1');const p=searchChatPolicy({candidate:false,live:true,enabled:true,role:'device',room:'sn-'+sns[2]+'-123',allowed:[sns[2]]});assert.equal(p.suppressOnboarding,false);assert.doesNotMatch(p.instruction,/隔离身份/);
 }finally{rt.closeSearchRuntime();}
});
test('主P2开关不能突破独立候选名单和期限',()=>{
 try{process.env.SEARCH_CANARY_ROOT=root;process.env.SEARCH_CANARY_SN=sns[0];set('main.tools','1');set('tools','0');set('scope','allowlist');set('allowlist',JSON.stringify([sns[0]]));set('canary.expires_at_ms',String(Date.now()+60000));assert.equal(rt.searchSettings().tools,false);set('tools','1');assert.equal(rt.searchSettings().tools,true);set('scope','all_registered');assert.equal(rt.searchSettings().enabled,false);set('scope','allowlist');set('canary.expires_at_ms','1');assert.equal(rt.searchSettings().enabled,false);}finally{delete process.env.SEARCH_CANARY_ROOT;rt.closeSearchRuntime();}
});
process.on('exit',()=>rmSync(root,{recursive:true,force:true}));
