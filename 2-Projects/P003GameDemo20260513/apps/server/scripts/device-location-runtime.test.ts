import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Hono} from 'hono';import {SignJWT} from 'jose';
const dir=mkdtempSync(join(tmpdir(),'location-runtime-')),sn='BJP00326060100100004',other='BJP00326070803800006',room='sn-'+sn+'-1';
for(const k of ['CONFIG','PROFILE','DEVICES','ACCOUNTS','CONVERSATION','FEEDBACK'])process.env[k+'_DB_PATH']=join(dir,k+'.db');
Object.assign(process.env,{SEARCH_CANARY_ROOT:dir,SEARCH_ROUTING_DB_PATH:join(dir,'routing.db'),SEARCH_DEVICE_ROUTING_DB_PATH:join(dir,'routing.db'),SEARCH_DEVICE_LOCATION_DB_PATH:join(dir,'location.db'),SEARCH_TASK_DB_PATH:join(dir,'search.db'),AUTH_JWT_SECRET:'synthetic-location-test-only',SEARCH_WORKER_ACCOUNT_ID:'worker',SEARCH_ENABLED:'1',DEEPSEEK_API_KEY:'synthetic-not-used',SEARCH_ALLOWED_DOMAINS:'moji.com'});
const realFetch=globalThis.fetch;let finishIp:((r:Response)=>void)|undefined,ipCalls=0,weatherCalls=0;
const stamp=new Date(Date.now()+28800000).toISOString().slice(0,19).replace('T',' '),today=stamp.slice(0,10);
globalThis.fetch=(async(url:any)=>{
 const u=new URL(String(url));
 if(u.hostname==='ip9.com.cn'){ipCalls++;assert.equal(u.searchParams.get('ip'),'58.30.0.0');return new Promise<Response>(resolve=>{finishIp=resolve;});}
 assert.equal(u.hostname,'wwwapi.moji.com');assert.equal(u.searchParams.get('cityId'),'2');weatherCalls++;
 return new Response(JSON.stringify({code:0,data:u.pathname.endsWith('getCityData')?{city:{id:2,name:'北京市',time_zone_name:'Asia/Shanghai'}}:{daily:[{predict_date:today,update_time:stamp,temp_low:12,temp_high:22,weather_day:'晴',weather_night:'多云'}]}}));
}) as typeof fetch;
const {captureDeviceLocation,getDeviceLocationStore}=await import('../src/tools/device-location-runtime.js');
const {searchTaskRoute,getSearchRoutingStore,closeSearchRuntime}=await import('../src/tools/search-runtime.js');
const {configStore}=await import('../src/config-store.js');const {deviceRegistryStore}=await import('../src/device-registry-store.js');
const {defaultRoutingConfig}=await import('../src/tools/search-routing-config.js');
for(const s of [sn,other]){deviceRegistryStore.add(s,'synthetic');deviceRegistryStore.setAccountId(s,'account-'+s);}
configStore.setFlag('p003.search.allowlist',JSON.stringify([sn,other]),'test');configStore.setFlag('p003.search.enabled','1','test');configStore.setFlag('p003.search.canary.expires_at_ms',String(Date.now()+60000),'test');
const store=getSearchRoutingStore()!,config={...defaultRoutingConfig(),weather_enabled:true,auto_location_enabled:true};store.saveDraft(config,0,'test');const version=store.publish(1,[sn],'test');
const app=new Hono();app.get('/',c=>{captureDeviceLocation(c,sn,room,Date.now()+60000);return c.json({ok:true});});
const headers={host:'kidshub-ai.hahaxiong.cc','x-real-ip':'58.30.0.0','x-forwarded-for':'8.8.8.8'};
try {
 const response=await app.request('http://kidshub-ai.hahaxiong.cc/',{headers},{incoming:{socket:{remoteAddress:'127.0.0.1'}}});assert.equal(response.status,200);
 assert.equal(ipCalls,1);assert.equal(getDeviceLocationStore()!.get(sn,room).state,'pending','response must not wait for IP service');
 finishIp!(new Response(JSON.stringify({ret:200,data:{ip:'58.30.0.0',country_code:'cn',prov:'北京',city:'北京'}})));
 const ip=await getDeviceLocationStore()!.wait(sn,room,new AbortController().signal);assert.equal(ip.city,'北京市');
 const worker=await new SignJWT({accountId:'worker',role:'device'}).setProtectedHeader({alg:'HS256'}).setIssuer('p003').setAudience('kidshub').setExpirationTime('5m').sign(new TextEncoder().encode(process.env.AUTH_JWT_SECRET));
 const submit=async(session:string,claim:any)=>searchTaskRoute.request('/?room='+session,{method:'POST',headers:{'x-p003-worker-token':worker,'content-type':'application/json'},body:JSON.stringify({protocol:1,phase:'committed',turn:'t'+session,query:'今天天气怎么样',routing:claim})});
 const claim={version,rule_id:'builtin-explicit',auto_weather:{day_offset:0,metric:'forecast'}};
 assert.equal((await submit(room,{...claim,weather:{city_id:2,city_name:'北京市',day_offset:0,metric:'forecast'}})).status,400);
 const created=await submit(room,claim);assert.equal(created.status,202);const id=(await created.json() as any).task.id;
 let task:any;for(let n=0;n<100;n++){task=(await(await searchTaskRoute.request('/?room='+room,{headers:{'x-p003-worker-token':worker}})).json() as any).tasks.find((v:any)=>v.id===id);if(task.status==='ready')break;await new Promise(r=>setTimeout(r,10));}
 assert.equal(task.status,'ready');assert.match(task.result.text,/设备网络定位.*北京市/);assert.equal(weatherCalls,2);
 const otherRoom='sn-'+sn+'-2';const missing=await submit(otherRoom,claim);assert.equal(missing.status,202);const mid=(await missing.json() as any).task.id;
 for(let n=0;n<100;n++){task=(await(await searchTaskRoute.request('/?room='+otherRoom,{headers:{'x-p003-worker-token':worker}})).json() as any).tasks.find((v:any)=>v.id===mid);if(task.status==='ready')break;await new Promise(r=>setTimeout(r,10));}
 assert.match(task.result.text,/没能.*确定所在城市/);assert.equal(weatherCalls,2,'new room must not borrow old room location');
 store.saveDraft({...config,auto_location_enabled:false},2,'test');const disabled=store.publish(3,[sn],'test');assert.equal((await submit('sn-'+sn+'-3',{...claim,version:disabled})).status,403);
 assert.equal(getDeviceLocationStore()!.get(other,room).state,'unknown');
 console.log('location integration: nonblocking capture, query-IP isolation, auto weather, no cross-room fallback, disabled/ambiguous claims rejected');
}finally{closeSearchRuntime();globalThis.fetch=realFetch;}
