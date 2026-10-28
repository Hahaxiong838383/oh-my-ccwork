import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {SignJWT} from 'jose';
const dir=mkdtempSync(join(tmpdir(),'weather-runtime-'));
for(const key of ['CONFIG','PROFILE','DEVICES','ACCOUNTS','CONVERSATION','FEEDBACK'])process.env[`${key}_DB_PATH`]=join(dir,key+'.db');
Object.assign(process.env,{AUTH_JWT_SECRET:'synthetic-weather-runtime',SEARCH_TASK_DB_PATH:join(dir,'search.db'),SEARCH_ROUTING_DB_PATH:join(dir,'routing.db'),SEARCH_CANARY_ROOT:dir,SEARCH_ENABLED:'1',SEARCH_ALLOWED_DOMAINS:'cstm.org.cn',SEARCH_WORKER_ACCOUNT_ID:'worker',DEEPSEEK_API_KEY:'synthetic-unused'});
process.env.P003_SEARCH_SIMPLE_FALLBACK='1';process.env.SEARCH_ALLOWED_DOMAINS='weather.com.cn';
const originalNow=Date.now,originalFetch=globalThis.fetch;Date.now=()=>Date.parse('2026-10-22T18:30:00+08:00');let fetches=0;
let searches=0,answers=0;
globalThis.fetch=(async(url:any,init:any)=>{
 fetches++;const u=new URL(String(url));
 if(u.hostname==='weathernew.pae.baidu.com')return new Response('',{status:429});
 assert.equal(u.hostname,'api.deepseek.com');
 if(u.pathname.endsWith('/search')){searches++;assert.match(JSON.parse(init.body).query,/成都/);return Response.json({results:[{title:'成都天气预报',url:'https://www.weather.com.cn/weather/101270101.shtml',summary:'成都10月23日多云。',snippet:'成都10月23日多云。',date:'2026-10-22T12:00:00+08:00'}]});}
 answers++;return new Response('data: '+JSON.stringify({choices:[{index:0,delta:{content:JSON.stringify({abstain:false,claims:[{text:'成都10月23日多云。',fact_ids:[1]}]})},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
}) as typeof fetch;
const {searchTaskRoute,getSearchRoutingStore,closeSearchRuntime}=await import('../src/tools/search-runtime.js');
const {configStore}=await import('../src/config-store.js');const {deviceRegistryStore}=await import('../src/device-registry-store.js');
const sn='BJP00326070803800006';deviceRegistryStore.add(sn,'test');deviceRegistryStore.setAccountId(sn,'weather-test');
configStore.setFlag('p003.search.enabled','1','test');configStore.setFlag('p003.search.allowlist',JSON.stringify([sn]),'test');configStore.setFlag('p003.search.canary.expires_at_ms',String(Date.now()+60000),'test');
const token=await new SignJWT({accountId:'worker',role:'device'}).setProtectedHeader({alg:'HS256'}).setIssuer('p003').setAudience('kidshub').setExpirationTime('2h').sign(new TextEncoder().encode(process.env.AUTH_JWT_SECRET));
const headers={'x-p003-worker-token':token,'content-type':'application/json'},url='/?room=sn-'+sn+'-1',store=getSearchRoutingStore()!;
try{
 const state=store.state();const cfg={...state.draft,baidu_weather_enabled:true,weather_enabled:true};store.saveDraft(cfg,state.revision,'test');const version=store.publish(store.state().revision,[sn],'test');
 const body={protocol:1,phase:'committed',turn:'expanded',query:'成都明天天气',routing:{version,rule_id:'builtin-explicit',place_weather:{place:'成都',day_offset:1,metric:'forecast'}}};
 const res=await searchTaskRoute.request(url,{method:'POST',headers,body:JSON.stringify(body)});assert.equal(res.status,202);const id=(await res.json()as any).task.id;
 let task:any;
 for(let i=0;i<80;i++){await new Promise(r=>setTimeout(r,10));task=(await(await searchTaskRoute.request(url,{headers})).json()as any).tasks.find((t:any)=>t.id===id);if(task.status==='ready'||task.status==='failed')break;}
 assert.equal(task.status,'ready');assert.match(task.result.text,/成都/);assert.equal(task.result.sources[0].url,'https://www.weather.com.cn/weather/101270101.shtml');assert.equal(searches,1);assert(answers>=1);const before=fetches;
 const s=store.state();store.saveDraft({...cfg,baidu_weather_enabled:false},s.revision,'test');const disabled=store.publish(store.state().revision,[sn],'test');
 assert.equal((await searchTaskRoute.request(url,{method:'POST',headers,body:JSON.stringify({...body,turn:'off',routing:{...body.routing,version:disabled}})})).status,403);assert.equal(fetches,before);
 console.log('weather fallback runtime: authenticated task → failed provider → general evidence → delivered result; gate unchanged');
}finally{closeSearchRuntime();Date.now=originalNow;globalThis.fetch=originalFetch;}
