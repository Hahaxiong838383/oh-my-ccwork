import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {SignJWT} from 'jose';
const dir=mkdtempSync(join(tmpdir(),'p1-weather-'));
for(const key of ['CONFIG','PROFILE','DEVICES','ACCOUNTS','CONVERSATION','FEEDBACK','TELEMETRY','DIAGNOSTICS','OTA'])process.env[`${key}_DB_PATH`]=join(dir,key+'.db');
delete process.env.SEARCH_CANARY_ROOT;
Object.assign(process.env,{AUTH_JWT_SECRET:'synthetic-p1-weather',SEARCH_TASK_DB_PATH:join(dir,'search.db'),SEARCH_ROUTING_DB_PATH:join(dir,'routing.db'),SEARCH_DEVICE_LOCATION_DB_PATH:join(dir,'location.db'),SEARCH_ENABLED:'1',SEARCH_ALLOWED_DOMAINS:'weather.com.cn',SEARCH_WORKER_ACCOUNT_ID:'worker',DEEPSEEK_API_KEY:'synthetic-unused'});
const live=process.argv.includes('--live');
const originalNow=Date.now,originalFetch=globalThis.fetch;if(!live)Date.now=()=>Date.parse('2026-10-31T15:00:00+08:00');let fetches=0;
const expectedDay=new Date(Date.now()+28800000).toISOString().slice(0,10);
if(!live)globalThis.fetch=(async(url:any)=>{
 fetches++;const u=new URL(String(url));assert.equal(u.hostname,'weathernew.pae.baidu.com','P1 weather must not need LLM tool calls');
 const harbin=u.searchParams.get('query')?.includes('哈尔滨');
 return new Response('window.tplData = '+JSON.stringify({position:{country:'中国',city:harbin?'哈尔滨':'北京'},base:{date:'2026-10-31'},weather:{site:'moji',update_time:'2026-10-31 14:55',temperature:'18',weather:'阴'},'24_hour_forecast':{loc:'http://moji.com/'+(harbin?'101050101':'101010100')},long_day_forecast:{info:[{date:'2026-10-31',temperature_day:'12',temperature_night:'5',weather_day:'多云',weather_night:'阴'}]}})+';');
}) as typeof fetch;
const {searchTaskRoute,getSearchRoutingStore,closeSearchRuntime,searchSettings}=await import('../src/tools/search-runtime.js');
const {configStore}=await import('../src/config-store.js');const {deviceRegistryStore}=await import('../src/device-registry-store.js');
const sn='BJP00399999999000031';deviceRegistryStore.add(sn,'synthetic');deviceRegistryStore.setAccountId(sn,'synthetic-weather');
configStore.setFlag('p003.search.enabled','1','test');configStore.setFlag('p003.search.scope','all_registered','test');configStore.setFlag('p003.search.tools','0','test');
assert.equal(searchSettings().tools,false);assert.equal(searchSettings().enabled,true);
const token=await new SignJWT({accountId:'worker',role:'device'}).setProtectedHeader({alg:'HS256'}).setIssuer('p003').setAudience('kidshub').setExpirationTime('2h').sign(new TextEncoder().encode(process.env.AUTH_JWT_SECRET));
const headers={'x-p003-worker-token':token,'content-type':'application/json'},url='/?room=sn-'+sn+'-1',store=getSearchRoutingStore()!;
try{
 const state=store.state();const cfg={...state.draft,baidu_weather_enabled:true,weather_enabled:true};store.saveDraft(cfg,state.revision,'test');const version=store.publishGlobal(store.state().revision,'test');
 assert.equal((await searchTaskRoute.request(url)).status,401);
 const texts=['小可请你提供一下北京的天气预报','就查哈尔滨的天气吧','请你告诉我今天北京经开区的天气'];
 for(const [index,place]of ['北京','哈尔滨','北京经开区'].entries()){
  let routing:any={version,rule_id:'builtin-explicit',place_weather:{place,day_offset:0,metric:'forecast'}},query=place+'今天天气';
  if(process.env.P003_WEATHER_PREVIEW_BIN){
   const result=JSON.parse(execFileSync(process.env.P003_WEATHER_PREVIEW_BIN,[],{input:JSON.stringify({config:cfg,utterances:[{text:texts[index],at_ms:0,reset:true}]}),encoding:'utf8'}));
   const decision=result.decisions[0];assert.equal(decision.action,'search');assert.equal(decision.place_weather.place,place);
   query=decision.query;routing={version,rule_id:decision.rule_id,place_weather:decision.place_weather};
  }
  const body={protocol:1,phase:'committed',turn:'p1-weather-'+index,query,routing};
  const res=await searchTaskRoute.request(url,{method:'POST',headers,body:JSON.stringify(body)});assert.equal(res.status,202);const id=(await res.json()as any).task.id;
  let task:any;for(let i=0;i<(live?160:40);i++){await new Promise(r=>setTimeout(r,live?50:10));task=(await(await searchTaskRoute.request(url,{headers})).json()as any).tasks.find((t:any)=>t.id===id);if(task.status==='ready'||task.status==='failed')break;}
  assert.equal(task.status,'ready');assert.equal(task.result.weather.station_id,place==='哈尔滨'?'101050101':'101010100');assert.equal(task.result.weather.target_date,expectedDay);
  if(place==='北京经开区')assert.match(task.result.text,/市级天气参考/);else assert.doesNotMatch(task.result.text,/市级天气参考/);
  await searchTaskRoute.request('/'+id+'/cancel?room=sn-'+sn+'-1',{method:'POST',headers,body:'{}'});
 }
 if(!live)assert.equal(fetches,2,'city reference shares exact source cache');
 configStore.setFlag('p003.search.enabled','0','test');assert.equal(searchSettings().enabled,false);
 console.log('P1 runtime: all_registered + tools=false, authenticated route, frozen config, '+(live?'live provider':'provider fixture')+', ledger, city scope and gate passed');
}finally{closeSearchRuntime();Date.now=originalNow;globalThis.fetch=originalFetch;}
