import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {SignJWT} from 'jose';
const dir=mkdtempSync(join(tmpdir(),'r23-location-fallback-'));
for(const key of ['CONFIG','PROFILE','DEVICES','ACCOUNTS','CONVERSATION','FEEDBACK'])process.env[`${key}_DB_PATH`]=join(dir,key+'.db');
Object.assign(process.env,{AUTH_JWT_SECRET:'synthetic-location-runtime',SEARCH_TASK_DB_PATH:join(dir,'search.db'),SEARCH_ROUTING_DB_PATH:join(dir,'routing.db'),SEARCH_DEVICE_LOCATION_DB_PATH:join(dir,'location.db'),SEARCH_CANARY_ROOT:dir,SEARCH_ENABLED:'1',SEARCH_ALLOWED_DOMAINS:'weather.com.cn',SEARCH_WORKER_ACCOUNT_ID:'worker',DEEPSEEK_API_KEY:'synthetic-unused',P003_SEARCH_SIMPLE_FALLBACK:'1'});
const originalFetch=globalThis.fetch;let searches=0;globalThis.fetch=(async()=>{searches++;throw new Error('must not search here without a verified city');})as typeof fetch;
const {DeviceLocationStore}=await import('../src/tools/device-location.js');const wait=DeviceLocationStore.prototype.wait;DeviceLocationStore.prototype.wait=async()=>{throw new Error('synthetic location storage unavailable');};
const {searchTaskRoute,getSearchRoutingStore,closeSearchRuntime}=await import('../src/tools/search-runtime.js');
const {configStore}=await import('../src/config-store.js');const {deviceRegistryStore}=await import('../src/device-registry-store.js');
const sn='BJP00399999999999901';deviceRegistryStore.add(sn,'test');deviceRegistryStore.setAccountId(sn,'location-test');
configStore.setFlag('p003.search.enabled','1','test');configStore.setFlag('p003.search.allowlist',JSON.stringify([sn]),'test');configStore.setFlag('p003.search.canary.expires_at_ms',String(Date.now()+60000),'test');
const token=await new SignJWT({accountId:'worker',role:'device'}).setProtectedHeader({alg:'HS256'}).setIssuer('p003').setAudience('kidshub').setExpirationTime('2h').sign(new TextEncoder().encode(process.env.AUTH_JWT_SECRET));
const headers={'x-p003-worker-token':token,'content-type':'application/json'},url='/?room=sn-'+sn+'-1',store=getSearchRoutingStore()!;
try{
 const s=store.state();store.saveDraft({...s.draft,weather_enabled:true,auto_location_enabled:true,baidu_weather_enabled:true},s.revision,'test');const version=store.publish(store.state().revision,[sn],'test');
 const body={protocol:1,phase:'committed',turn:'local-weather-error',query:'今天这里下不下雨',routing:{version,rule_id:'builtin-explicit',auto_weather:{day_offset:0,metric:'forecast'}}};
 const res=await searchTaskRoute.request(url,{method:'POST',headers,body:JSON.stringify(body)});assert.equal(res.status,202);const id=(await res.json()as any).task.id;let task:any;
 for(let i=0;i<100;i++){await new Promise(r=>setTimeout(r,10));task=(await(await searchTaskRoute.request(url,{headers})).json()as any).tasks.find((t:any)=>t.id===id);if(task.status==='ready'||task.status==='failed')break;}
 assert.equal(task.status,'ready');assert.equal(searches,0,'a failed location lookup must never turn here into an unlocated general weather search');assert.equal(task.result.sources.length,0);assert.match(task.result.text,/没能查到可靠/);
 console.log('local weather with location storage failure: no guessed location, no unlocated upstream search, explicit short response');
}finally{DeviceLocationStore.prototype.wait=wait;globalThis.fetch=originalFetch;closeSearchRuntime();}
