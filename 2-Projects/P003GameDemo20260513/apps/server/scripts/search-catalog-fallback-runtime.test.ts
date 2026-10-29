import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {SignJWT} from 'jose';
const dir=mkdtempSync(join(tmpdir(),'catalog-fallback-runtime-'));
for(const key of ['CONFIG','PROFILE','DEVICES','ACCOUNTS','CONVERSATION','FEEDBACK'])process.env[`${key}_DB_PATH`]=join(dir,key+'.db');
Object.assign(process.env,{AUTH_JWT_SECRET:'synthetic-weather-runtime',SEARCH_TASK_DB_PATH:join(dir,'search.db'),SEARCH_ROUTING_DB_PATH:join(dir,'routing.db'),SEARCH_CANARY_ROOT:dir,SEARCH_ENABLED:'1',SEARCH_ALLOWED_DOMAINS:'cstm.org.cn',SEARCH_WORKER_ACCOUNT_ID:'worker',DEEPSEEK_API_KEY:'synthetic-unused'});
process.env.P003_SEARCH_SIMPLE_FALLBACK='1';process.env.SEARCH_ALLOWED_DOMAINS='example.org';process.env.SEARCH_CANARY_SN='BJP00326070803800006';
const originalNow=Date.now,originalFetch=globalThis.fetch;Date.now=()=>Date.parse('2026-10-22T18:30:00+08:00');let fetches=0;
let searches=0,answers=0,plans=0;
globalThis.fetch=(async(url:any,init:any)=>{
 fetches++;const u=new URL(String(url)),body=JSON.parse(init.body);assert.equal(u.hostname,'api.deepseek.com');
 if(body.tools){plans++;return new Response('',{status:400});}
 if(u.pathname.endsWith('/search')){searches++;return Response.json({results:[{title:'蓝星游戏正式版本公告',url:'https://example.org/release',summary:'正式版本增加了滑翔玩法。',snippet:'正式版本增加了滑翔玩法。',date:'2026-09-15T12:00:00+08:00'}]});}
 answers++;const facts=body.messages.flatMap((m:any)=>{try{return JSON.parse(m.content).facts??[];}catch{return[];}});const fact=facts.find((f:any)=>f.quote==='正式版本增加了滑翔玩法。');assert.ok(fact);
 return new Response('data: '+JSON.stringify({choices:[{index:0,delta:{content:JSON.stringify({abstain:false,claims:[{text:'公告介绍了滑翔玩法。',fact_ids:[fact.id]}]})},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
}) as typeof fetch;
const {searchTaskRoute,getSearchRoutingStore,closeSearchRuntime}=await import('../src/tools/search-runtime.js');
const {configStore}=await import('../src/config-store.js');const {deviceRegistryStore}=await import('../src/device-registry-store.js');
const sn='BJP00326070803800006';deviceRegistryStore.add(sn,'test');deviceRegistryStore.setAccountId(sn,'weather-test');
configStore.setFlag('p003.search.enabled','1','test');configStore.setFlag('p003.search.tools','1','test');configStore.setFlag('p003.search.allowlist',JSON.stringify([sn]),'test');configStore.setFlag('p003.search.canary.expires_at_ms',String(Date.now()+60000),'test');
const token=await new SignJWT({accountId:'worker',role:'device'}).setProtectedHeader({alg:'HS256'}).setIssuer('p003').setAudience('kidshub').setExpirationTime('2h').sign(new TextEncoder().encode(process.env.AUTH_JWT_SECRET));
const headers={'x-p003-worker-token':token,'content-type':'application/json'},url='/?room=sn-'+sn+'-1',store=getSearchRoutingStore()!;
try{
 const version=store.publish(store.state().revision,[sn],'test');
 const body={protocol:1,phase:'committed',turn:'catalog-fallback',query:'查蓝星游戏最近的正式更新',routing:{version,rule_id:'builtin-explicit'}};
 const res=await searchTaskRoute.request(url,{method:'POST',headers,body:JSON.stringify(body)});assert.equal(res.status,202);const id=(await res.json()as any).task.id;
 let task:any;
 for(let i=0;i<80;i++){await new Promise(r=>setTimeout(r,10));task=(await(await searchTaskRoute.request(url,{headers})).json()as any).tasks.find((t:any)=>t.id===id);if(task.status==='ready'||task.status==='failed')break;}
 assert.equal(task.status,'ready');assert.match(task.result.text,/滑翔/);assert.match(task.result.text,/是否为最新版本.*不能确认/);
 assert.equal(task.result.sources[0].url,'https://example.org/release');assert.equal(searches,1);assert.equal(plans,1);assert(answers>=1);
 console.log('authenticated P2 task retains catalog semantics on tool-disabled fallback');
}finally{closeSearchRuntime();Date.now=originalNow;globalThis.fetch=originalFetch;}
