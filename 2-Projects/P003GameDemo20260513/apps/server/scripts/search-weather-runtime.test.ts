import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {SignJWT} from 'jose';
const dir=mkdtempSync(join(tmpdir(),'weather-runtime-'));
for(const key of ['CONFIG','PROFILE','DEVICES','ACCOUNTS','CONVERSATION','FEEDBACK'])process.env[`${key}_DB_PATH`]=join(dir,key+'.db');
Object.assign(process.env,{AUTH_JWT_SECRET:'synthetic-weather-runtime',SEARCH_TASK_DB_PATH:join(dir,'search.db'),SEARCH_ROUTING_DB_PATH:join(dir,'routing.db'),SEARCH_CANARY_ROOT:dir,SEARCH_ENABLED:'1',SEARCH_ALLOWED_DOMAINS:'cstm.org.cn',SEARCH_WORKER_ACCOUNT_ID:'worker',DEEPSEEK_API_KEY:'synthetic-unused'});
const originalNow=Date.now,originalFetch=globalThis.fetch;Date.now=()=>Date.parse('2026-10-22T18:30:00+08:00');let fetches=0;
globalThis.fetch=(async(url:any)=>{fetches++;assert.equal(new URL(String(url)).hostname,'weathernew.pae.baidu.com','weather must not call the general LLM');return new Response('window.tplData = '+JSON.stringify({position:{country:'中国',city:'成都'},base:{date:'2026-10-22'},weather:{site:'moji',update_time:'2026-10-22 18:20',temperature:'18',weather:'阴'},'24_hour_forecast':{loc:'http://moji.com/101270101'},long_day_forecast:{info:[{date:'2026-10-23',temperature_day:'23',temperature_night:'15',weather_day:'多云',weather_night:'阴'}]}})+';');}) as typeof fetch;
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
 for(let i=0;i<20;i++){await new Promise(r=>setTimeout(r,10));task=(await(await searchTaskRoute.request(url,{headers})).json()as any).tasks.find((t:any)=>t.id===id);if(task.status==='ready'||task.status==='failed')break;}
 assert.equal(task.status,'ready');assert.equal(task.result.weather.station_id,'101270101');assert.equal(task.result.weather.target_date,'2026-10-23');assert.match(task.result.text,/成都/);assert.equal(fetches,1);
 const s=store.state();store.saveDraft({...cfg,baidu_weather_enabled:false},s.revision,'test');const disabled=store.publish(store.state().revision,[sn],'test');
 assert.equal((await searchTaskRoute.request(url,{method:'POST',headers,body:JSON.stringify({...body,turn:'off',routing:{...body.routing,version:disabled}})})).status,403);assert.equal(fetches,1);
 console.log('weather runtime: actual authenticated route → frozen config → fixed provider → ledger; source gate enforced');
}finally{closeSearchRuntime();Date.now=originalNow;globalThis.fetch=originalFetch;}
