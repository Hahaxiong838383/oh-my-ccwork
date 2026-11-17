import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {once} from 'node:events';import {serve} from '@hono/node-server';import {SignJWT} from 'jose';
import {createAnalyticsApp} from '../src/analytics/index.js';
import {AnalyticsStore} from '../src/analytics/store.js';
import {createBatchPacer} from '../src/analytics/pacing.js';

test('opt-in pacing defers uploads without ACK, preserving ready, read paths and durable replay',async()=>{
 const root=mkdtempSync(join(tmpdir(),'analytics-pacing-')),control=join(root,'control.json');writeFileSync(control,'{"enabled":true}',{mode:0o600});
 const store=new AnalyticsStore(join(root,'analytics.db')),secret='synthetic-pacing-secret';
 const reader={readCredentialState:()=>({binding:null,revokedThroughSec:null}),acceptsCredential:()=>true,readiness:()=>true,readAnalyticsDeviceContext:()=>({deviceKey:'test-device',active:true,uploadEnabled:true,uploadHourCst:23})};
 const options={store,reader,authSecret:secret,internalSecret:secret,controlPath:control,allowSubjects:['test'],diskFreeBytes:()=>20*1024**3,minBatchIntervalMs:1000};
 const app=createAnalyticsApp(options),server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:0});if(!server.listening)await once(server,'listening');
 const url='http://127.0.0.1:'+(server.address()as any).port,token=await new SignJWT({kind:'p003-device'}).setSubject('test').setProtectedHeader({alg:'HS256'}).setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(secret));
 const body={schema_version:1,batch_id:'pacing-batch',sent_at_ms:Date.now(),client:{},events:[{schema_version:1,client_event_id:'pacing-event',event_name:'app.bridge_ready',occurred_at_ms:Date.now(),session_id:'test-session',sequence:1,priority:'normal',context:{},properties:{}}]};
 const post=(raw=JSON.stringify(body))=>fetch(url+'/v1/device/analytics/events:batch',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','X-Request-Id':'pacing-rid'},body:raw});
 try{
  assert.equal((await post('{invalid')).status,400,'invalid body must not consume a slot');
  let response=await post();assert.equal(response.status,200);assert.deepEqual((await response.json()).accepted_event_ids,['pacing-event']);
  response=await post();assert.equal(response.status,429);assert.equal(response.headers.get('Retry-After'),'1');assert.deepEqual(await response.json(),{ok:false,error_code:'ANALYTICS_RATE_LIMITED'});
  assert.equal(store.db.prepare('SELECT count(*) n FROM analytics_batch').get()!.n,1,'deferred upload has no durable ACK or new row');
  const ready=await fetch(url+'/ready');assert.equal(ready.status,200);assert.equal((await ready.json()).ingest_min_interval_ms,1000);
  assert.equal((await fetch(url+'/internal/analytics/ark-warmup',{method:'POST',headers:{'X-Analytics-Internal-Token':secret},body:'{}'})).status,200);
  await new Promise(r=>setTimeout(r,1050));response=await post();assert.equal(response.status,200);assert.deepEqual((await response.json()).duplicated_event_ids,['pacing-event']);assert.equal(store.db.prepare('SELECT count(*) n FROM analytics_event').get()!.n,1);
  // Both slow bodies can pass the early check before either obtains the slot.
  const concurrent=createAnalyticsApp(options),streams:ReadableStreamDefaultController<Uint8Array>[]=[];
  const slow=()=>concurrent.fetch(new Request('http://localhost/v1/device/analytics/events:batch',{method:'POST',headers:{authorization:'Bearer '+token,'X-Request-Id':'pacing-concurrent'},body:new ReadableStream<Uint8Array>({start(c){streams.push(c);}}),duplex:'half'}as any));
  const pending=[slow(),slow()];await new Promise(r=>setImmediate(r));
  const before=store.db.prepare('SELECT count(*) n FROM analytics_batch').get()!.n;
  for(const stream of streams){stream.enqueue(new TextEncoder().encode(JSON.stringify(body)));stream.close();}
  assert.deepEqual((await Promise.all(pending)).map(r=>r.status).sort(),[200,429]);
  assert.equal(store.db.prepare('SELECT count(*) n FROM analytics_batch').get()!.n,Number(before)+1);
  const normal=createAnalyticsApp({...options,minBatchIntervalMs:0});
  for(let i=0;i<2;i++)assert.equal((await normal.request('/v1/device/analytics/events:batch',{method:'POST',headers:{authorization:'Bearer '+token,'X-Request-Id':'disabled-pacer'},body:JSON.stringify(body)})).status,200);
  for(const bad of [-1,0.1,5001,NaN])assert.throws(()=>createAnalyticsApp({...options,minBatchIntervalMs:bad}));
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));store.close();rmSync(root,{recursive:true,force:true});}
});

test('a long idle period does not accumulate upload burst credit; rejection does not extend the wait',()=>{
 let now=0;const pacer=createBatchPacer(500,()=>now);assert.equal(pacer.acquire(),0);
 for(now=1;now<500;now++)assert.equal(pacer.acquire(),1);
 assert.equal(pacer.acquire(),0);now=100000;assert.equal(pacer.acquire(),0);assert.equal(pacer.acquire(),1);
 now+=500;assert.equal(pacer.acquire(),0);
 const off=createBatchPacer(0,()=>now);for(let i=0;i<50;i++)assert.equal(off.acquire(),0);
});
