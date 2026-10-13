import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {serve} from '@hono/node-server';
import {SignJWT} from 'jose';
import {AnalyticsStore,AnalyticsStorageUnavailable} from '../src/analytics/store.js';
import {createAnalyticsApp} from '../src/analytics/index.js';
import {settleAnalyticsBatch} from '../src/analytics/ingest.js';

const dir=mkdtempSync(join(tmpdir(),'analytics-writer-http-')),control=join(dir,'control.json');
writeFileSync(control,'{"enabled":true}',{mode:0o600});
const store=new AnalyticsStore(join(dir,'analytics.db'));
let complete:(()=>void)|undefined,fail:(()=>void)|undefined;
const writer={ready:false,busy:false,
 settle(context:Parameters<typeof settleAnalyticsBatch>[1],batch:Parameters<typeof settleAnalyticsBatch>[2],requestId:string){
  assert.equal(this.busy,false);this.busy=true;
  return new Promise<ReturnType<typeof settleAnalyticsBatch>>((resolve,reject)=>{
   complete=()=>{this.busy=false;resolve(settleAnalyticsBatch(store,context,batch,requestId));};
   fail=()=>{this.busy=false;this.ready=false;reject(new AnalyticsStorageUnavailable());};
  });
 },async close(){this.ready=false;}
};
const context={deviceKey:'fake-http-writer-device',active:true,uploadEnabled:true,uploadHourCst:0};
const options={store,writer,reader:{acceptsCredential:()=>true,readiness:()=>true,readAnalyticsDeviceContext:()=>context},authSecret:'fake-worker-http-key',internalSecret:'fake-worker-internal',controlPath:control,allowSubjects:['fake-worker'],diskFreeBytes:()=>20*1024**3};
const app=createAnalyticsApp(options),server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:0});
await new Promise<void>(resolve=>server.listening?resolve():server.once('listening',resolve));
const address=server.address();assert.ok(address&&typeof address!=='string');const base='http://127.0.0.1:'+address.port;
const token=await new SignJWT({kind:'p003-device'}).setSubject('fake-worker').setProtectedHeader({alg:'HS256'}).setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(options.authSecret));
const body=(id:string)=>({schema_version:1,batch_id:id,sent_at_ms:Date.now(),client:{},events:[{schema_version:1,client_event_id:id,event_name:'app.bridge_ready',occurred_at_ms:Date.now(),session_id:'fake-session',sequence:1,priority:'normal',context:{},properties:{}}]});
const post=(id:string)=>fetch(base+'/v1/device/analytics/events:batch',{method:'POST',headers:{authorization:'Bearer '+token,'X-Request-Id':id},body:JSON.stringify(body(id))});
const count=()=>Number(store.db.prepare('SELECT count(*) n FROM analytics_event').get()!.n);
const until=async(fn:()=>boolean)=>{const end=Date.now()+2000;while(!fn()){if(Date.now()>end)throw new Error('HTTP writer integration timeout');await new Promise(r=>setTimeout(r,5));}};
try{
 assert.equal((await fetch(base+'/ready')).status,503,'worker未就绪不能报告ready');
 let response=await post('not-ready');assert.equal(response.status,503);assert.equal((await response.json()).error_code,'ANALYTICS_STORAGE_UNAVAILABLE');assert.equal(count(),0);
 writer.ready=true;assert.equal((await fetch(base+'/ready')).status,200);
 let ackResolved=false;
 const pending=post('durable').then(r=>{ackResolved=true;return r;});await until(()=>writer.busy);
 assert.equal((await fetch(base+'/health')).status,200,'等待worker时HTTP仍可接入');
 assert.equal(ackResolved,false,'worker入队不是成功ACK');assert.equal(count(),0);
 response=await post('overloaded');assert.equal(response.status,503);assert.equal(response.headers.get('Retry-After'),'5');assert.equal((await response.json()).error_code,'ANALYTICS_OVERLOADED');
 complete!();response=await pending;assert.equal(response.status,200);assert.deepEqual((await response.json()).accepted_event_ids,['durable']);assert.equal(count(),1);
 // A worker failure after dispatch must release the HTTP slot, report unavailable and never ACK.
 const failed=post('failed');await until(()=>writer.busy);fail!();response=await failed;
 assert.equal(response.status,503);assert.equal(response.headers.get('Retry-After'),'30');assert.equal((await response.json()).error_code,'ANALYTICS_STORAGE_UNAVAILABLE');assert.equal(count(),1);
 const health=await(await fetch(base+'/ready')).json();assert.equal(health.ready,false);assert.equal(health.in_flight,0);assert.equal(health.storage_failures,1);
 writer.ready=true;
 // Switches are checked after the asynchronous body read, before dispatch to the worker.
 writeFileSync(control,'{"enabled":false}',{mode:0o600});response=await post('gate-closed');assert.equal(response.status,503);assert.equal(response.headers.get('Retry-After'),'900');assert.equal(writer.busy,false);assert.equal(count(),1);
 console.log('analytics writer HTTP: PASS (readiness, responsive backpressure, ACK after commit, failure/gate handling)');
}finally{
 server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));store.close();rmSync(dir,{recursive:true,force:true});
}
