import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,rmSync,chmodSync } from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {SignJWT} from 'jose';
const {createAnalyticsApp,readControl}=await import('../src/analytics/index.js');
const {AnalyticsStore}=await import('../src/analytics/store.js');
const dir=mkdtempSync(join(tmpdir(),'analytics-http-')),control=join(dir,'control.json');
writeFileSync(control,JSON.stringify({enabled:false}),{mode:0o600});
const store=new AnalyticsStore(join(dir,'analytics.db'));
const reader={acceptsCredential:()=>true,readiness:()=>true,readAnalyticsDeviceContext:(sn:string)=>({deviceKey:'fake-'+sn,active:sn!=='inactive',uploadEnabled:sn!=='off',uploadHourCst:23})};
let freeBytes=20*1024**3;
const options={store,reader,authSecret:'fake-jwt-secret',internalSecret:'fake-internal-secret',controlPath:control,allowSubjects:['allowed','off'],globalRpm:600,diskFreeBytes:()=>freeBytes};
const app=createAnalyticsApp(options);
const sign=(sn='allowed')=>new SignJWT({kind:'p003-device'}).setSubject(sn).setProtectedHeader({alg:'HS256'}).setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode('fake-jwt-secret'));
const cred=await sign();
const event=(id:string)=>({schema_version:1,client_event_id:id,event_name:'app.bridge_ready',occurred_at_ms:Date.now(),session_id:'session-http',sequence:1,priority:'normal',context:{},properties:{}});
const batch=(id:string)=>({schema_version:1,batch_id:'batch-http',sent_at_ms:Date.now(),client:{},events:[event(id)]});
const post=(body:unknown= batch('e1'),token=cred,requestId='request-original:1')=>app.request('/v1/device/analytics/events:batch',{method:'POST',headers:{authorization:'Bearer '+token,'X-Request-Id':requestId},body:typeof body==='string'?body:JSON.stringify(body)});
assert.equal((await post(batch('bad-auth'),'invalid')).status,401);
let r=await post();assert.equal(r.status,503);assert.equal(r.headers.get('Retry-After'),'900');assert.equal((await r.json()).error_code,'ANALYTICS_UPLOAD_DISABLED');
assert.equal((await app.request('/health')).status,200);assert.equal((await app.request('/ready')).status,200);
writeFileSync(control,JSON.stringify({enabled:true}),{mode:0o600});
assert.equal((await post(batch('nongray'),await sign('nongray'))).status,403);
r=await post(batch('device-off'),await sign('off'));assert.equal(r.status,503);assert.equal(r.headers.get('Retry-After'),'900');
assert.equal((await post('{broken')).status,400);
assert.equal((await post(batch('bad-header'),cred,'with space')).status,400);
r=await post();assert.equal(r.status,200);const ack=await r.json();assert.equal(ack.request_id,'request-original:1');assert.deepEqual(ack.accepted_event_ids,['e1']);
r=await post('x'.repeat(2*1024*1024+1));assert.equal(r.status,413);assert.match(r.headers.get('content-type')!,/json/);
const oversized={...event('large-one'),properties:{padding:'x'.repeat(8192)}};
r=await post({...batch(''),events:[oversized]});assert.equal(r.status,200);assert.deepEqual((await r.json()).rejected,[{client_event_id:'large-one',reason:'event_too_large'}]);
// A complete 200 x 8192-byte legal batch stays below the 2 MiB application ceiling.
const full={...batch(''),events:Array.from({length:200},(_,i)=>{
 const e={...event('full-'+i),event_name:'g1.reward_granted',properties:{logical_day:'2026-10-13',tank_id:'TANK-001',reward_instance_id:'reward-'+i,source_kind:'progress_stage',source_id:'REGULAR-01',rewards:Array.from({length:10},()=>({kind:'',item_id:'',quantity:1,tank_id:''}))}};
 let remaining=8192-Buffer.byteLength(JSON.stringify(e));
 for(const reward of e.properties.rewards)for(const key of ['kind','item_id','tank_id'] as const){const n=Math.min(256,remaining);reward[key]='x'.repeat(n);remaining-=n;}
 assert.equal(remaining,0);assert.equal(Buffer.byteLength(JSON.stringify(e)),8192);return e;
})};
r=await post(full);assert.equal(r.status,200);assert.equal((await r.json()).accepted_event_ids.length,200);
freeBytes=3*1024**3;r=await post(batch('disk'));assert.equal(r.status,503);assert.equal(r.headers.get('Retry-After'),'60');freeBytes=20*1024**3;
assert.equal((await app.request('/internal/analytics/overview')).status,401);
assert.equal((await app.request('/internal/analytics/overview',{headers:{'X-Analytics-Internal-Token':'fake-internal-secret'}})).status,200);
const limited=createAnalyticsApp({...options,globalRpm:1});assert.equal((await limited.request('/v1/device/analytics/events:batch',{method:'POST',headers:{authorization:'Bearer '+cred,'X-Request-Id':'limit'},body:JSON.stringify(batch('limit'))})).status,200);
r=await limited.request('/v1/device/analytics/events:batch',{method:'POST',headers:{authorization:'Bearer '+cred,'X-Request-Id':'limit2'},body:JSON.stringify(batch('limit2'))});assert.equal(r.status,429);assert.match(r.headers.get('Retry-After')!,/^\d+$/);
// Two incomplete bodies occupy both ingestion slots; the third request receives immediate backpressure.
const concurrent=createAnalyticsApp(options);const streams:ReadableStreamDefaultController<Uint8Array>[]=[];
const slow=()=>new ReadableStream<Uint8Array>({start(controller){streams.push(controller);}});
const req=(body:ReadableStream<Uint8Array>)=>concurrent.fetch(new Request('http://localhost/v1/device/analytics/events:batch',{method:'POST',headers:{Authorization:'Bearer '+cred,'X-Request-Id':'slow'},body,duplex:'half'} as any));
const first=req(slow()),second=req(slow());await new Promise(resolve=>setImmediate(resolve));
r=await concurrent.request('/v1/device/analytics/events:batch',{method:'POST',headers:{Authorization:'Bearer '+cred,'X-Request-Id':'third'},body:JSON.stringify(batch('third'))});assert.equal(r.status,503);assert.equal(r.headers.get('Retry-After'),'5');
// Closing the gate while reading a body must prevent the later commit.
writeFileSync(control,JSON.stringify({enabled:false}),{mode:0o600});
for(const stream of streams){stream.enqueue(new TextEncoder().encode(JSON.stringify(batch('slow'))));stream.close();}
assert.equal((await first).status,503);assert.equal((await second).status,503);
writeFileSync(control,JSON.stringify({enabled:true}),{mode:0o600});
const perDevice=createAnalyticsApp(options);
for(let i=0;i<60;i++){r=await perDevice.request('/v1/device/analytics/events:batch',{method:'POST',headers:{Authorization:'Bearer '+cred,'X-Request-Id':'rpm-'+i},body:JSON.stringify(batch('rpm'))});assert.equal(r.status,200);}
r=await perDevice.request('/v1/device/analytics/events:batch',{method:'POST',headers:{Authorization:'Bearer '+cred,'X-Request-Id':'rpm-61'},body:JSON.stringify(batch('rpm'))});assert.equal(r.status,429);
// Live policy is checked as one snapshot after the body/context; a retained list cannot override a closed master.
let reads=0,managed:any={version:1,revision:1,enabled:true,subjects:['allowed'],hour:23,updated_at_ms:Date.now()};
const dynamic=createAnalyticsApp({...options,reader:{...reader,uploadPolicy:()=>managed,readAnalyticsDeviceContext:sn=>{if(++reads===2)managed={...managed,enabled:false,revision:2};return reader.readAnalyticsDeviceContext(sn);}}});
r=await dynamic.request('/v1/device/analytics/events:batch',{method:'POST',headers:{Authorization:'Bearer '+cred,'X-Request-Id':'dynamic-off'},body:JSON.stringify(batch('dynamic-off'))});assert.equal(r.status,503);assert.equal((await r.json()).error_code,'ANALYTICS_UPLOAD_DISABLED');
assert.equal(store.db.prepare('SELECT count(*) n FROM analytics_event WHERE client_event_id=?').get('dynamic-off')!.n,0);
const broken=createAnalyticsApp({...options,reader:{...reader,uploadPolicy:()=>{throw new Error('broken');}}});assert.equal((await broken.request('/ready')).status,503);
const timed=createAnalyticsApp({...options,bodyTimeoutMs:10});
r=await timed.fetch(new Request('http://localhost/v1/device/analytics/events:batch',{method:'POST',headers:{Authorization:'Bearer '+cred,'X-Request-Id':'timeout'},body:new ReadableStream({start(){}}),duplex:'half'} as any));assert.equal(r.status,503);assert.equal((await r.json()).error_code,'ANALYTICS_BODY_TIMEOUT');
const afterTimeout=await(await timed.request('/ready')).json();assert.equal(afterTimeout.in_flight,0);assert.equal(afterTimeout.storage_failures,0);
for(const mode of [0o400,0o700,0o640]){
 chmodSync(control,mode);assert.deepEqual(readControl(control),{enabled:false,valid:false},'只有精确0600可用');
 assert.equal((await app.request('/ready')).status,503);
}
chmodSync(control,0o600);assert.deepEqual(readControl(control),{enabled:true,valid:true});
writeFileSync(control,'broken',{mode:0o600});assert.equal((await app.request('/ready')).status,503);assert.equal((await post()).status,503);
store.close();rmSync(dir,{recursive:true,force:true});console.log('analytics HTTP: PASS (auth/gates, JSON413, full-body limits, rates, disk, internal auth, readiness)');
