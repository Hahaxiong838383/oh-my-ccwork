import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {SignJWT} from 'jose';
const dir=mkdtempSync(join(tmpdir(),'clock-runtime-'));
for(const key of ['CONFIG','PROFILE','DEVICES','ACCOUNTS','CONVERSATION','FEEDBACK'])process.env[`${key}_DB_PATH`]=join(dir,key+'.db');
Object.assign(process.env,{AUTH_JWT_SECRET:'synthetic-weather-runtime',SEARCH_TASK_DB_PATH:join(dir,'search.db'),SEARCH_ROUTING_DB_PATH:join(dir,'routing.db'),SEARCH_CANARY_ROOT:dir,SEARCH_ENABLED:'1',SEARCH_ALLOWED_DOMAINS:'cstm.org.cn',SEARCH_WORKER_ACCOUNT_ID:'worker',DEEPSEEK_API_KEY:'synthetic-unused'});
const originalFetch=globalThis.fetch;let fetches=0;globalThis.fetch=(async()=>{fetches++;throw new Error('NO_EXTERNAL_NETWORK_IN_CLOCK_TEST');}) as typeof fetch;
const {searchTaskRoute,getSearchRoutingStore,closeSearchRuntime,getSearchTasks}=await import('../src/tools/search-runtime.js');
const {configStore}=await import('../src/config-store.js');const {deviceRegistryStore}=await import('../src/device-registry-store.js');
const sn='BJP00326070803800006';deviceRegistryStore.add(sn,'test');deviceRegistryStore.setAccountId(sn,'weather-test');
configStore.setFlag('p003.search.enabled','1','test');configStore.setFlag('p003.search.allowlist',JSON.stringify([sn]),'test');configStore.setFlag('p003.search.canary.expires_at_ms',String(Date.now()+60000),'test');
const token=await new SignJWT({accountId:'worker',role:'device'}).setProtectedHeader({alg:'HS256'}).setIssuer('p003').setAudience('kidshub').setExpirationTime('2h').sign(new TextEncoder().encode(process.env.AUTH_JWT_SECRET));
const headers={'x-p003-worker-token':token,'content-type':'application/json'},url='/?room=sn-'+sn+'-1',store=getSearchRoutingStore()!;
try{
 const state=store.state();const version=store.publish(state.revision,[sn],'test');
 for(const [i,query] of ['现在几点','帮我查现在几点','纽约现在几点','今天是周几','美国时间'].entries()){
  const body={protocol:1,phase:'committed',turn:'clock-'+i,query,routing:{version,rule_id:'builtin-explicit'}};
  const res=await searchTaskRoute.request(url,{method:'POST',headers,body:JSON.stringify(body)});assert.equal(res.status,202);const id=(await res.json()as any).task.id;
  let task:any;for(let n=0;n<20;n++){await new Promise(r=>setTimeout(r,10));task=(await(await searchTaskRoute.request(url,{headers})).json()as any).tasks.find((t:any)=>t.id===id);if(task.status==='ready'||task.status==='failed')break;}
  assert.equal(task.status,'ready');assert.equal(getSearchTasks()!.get({subject:sn,session:'sn-'+sn+'-1'},id).outcome,'answered');assert.match(task.result.text,/查询时|查询当天|时区/);assert.equal(fetches,0);
  const cancelled=await searchTaskRoute.request('/'+id+'/cancel'+url.slice(1),{method:'POST',headers,body:'{}'});assert.equal(cancelled.status,200);assert.equal((await cancelled.json() as any).task.status,'cancelled');
 }
 // Force an actual supplier failure through the unchanged search executor.
 globalThis.fetch=(async()=>{fetches++;return new Response('{}',{status:402});}) as typeof fetch;
 const post=(turn:string,query:string,h=headers)=>searchTaskRoute.request(url,{method:'POST',headers:h,body:JSON.stringify({protocol:1,phase:'committed',turn,query,routing:{version,rule_id:'builtin-explicit'}})});
 const paused=await post('supplier-failure','故宫今天开门吗');assert.equal(paused.status,202);const failedId=(await paused.json() as any).task.id;
 for(let n=0;n<100&&getSearchTasks()!.get({subject:sn,session:'sn-'+sn+'-1'},failedId).status!=='failed';n++)await new Promise(r=>setTimeout(r,10));
 assert.equal(getSearchTasks()!.get({subject:sn,session:'sn-'+sn+'-1'},failedId).status,'failed');assert.equal(fetches,1);
 const denied=await post('paused-ordinary','故宫现在门票多少钱');assert.equal(denied.status,503);assert.equal((await denied.json() as any).error,'upstream_paused');
 const local=await post('paused-clock','帮我查当前时间');assert.equal(local.status,202);const localId=(await local.json() as any).task.id;
 for(let n=0;n<30&&getSearchTasks()!.get({subject:sn,session:'sn-'+sn+'-1'},localId).status!=='ready';n++)await new Promise(r=>setTimeout(r,10));
 assert.equal(getSearchTasks()!.get({subject:sn,session:'sn-'+sn+'-1'},localId).status,'ready');assert.equal(fetches,1);
 process.env.P003_CLOCK_ENABLED='0';const off=await post('clock-disabled','当前时间');assert.equal(off.status,503);assert.equal((await off.json() as any).error,'upstream_paused');assert.equal(fetches,1);
 process.env.P003_CLOCK_ENABLED='1';assert.equal((await post('anonymous-clock','现在几点',{'content-type':'application/json'} as any)).status,401);
 configStore.setFlag('p003.search.enabled','0','test');assert.equal((await post('search-disabled','现在几点')).status,503);assert.equal(fetches,1);
 console.log('PASS actual search runtime routes clock locally with zero provider requests');
}finally{closeSearchRuntime();globalThis.fetch=originalFetch;}
