import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {serve} from '@hono/node-server';
import {SignJWT} from 'jose';
import {createAnalyticsApp} from '../src/analytics/index.js';
import {AnalyticsStore} from '../src/analytics/store.js';
import {AnalyticsWriter} from '../src/analytics/writer.js';
import {request as httpRequest} from 'node:http';
import {readAnalyticsBody} from '../src/analytics/http-body.js';
import {LIMITS} from '../src/analytics/contracts.js';

const dir=mkdtempSync(join(tmpdir(),'analytics-gzip-')),control=join(dir,'control.json');
writeFileSync(control,'{"enabled":true}',{mode:0o600});
const store=new AnalyticsStore(join(dir,'analytics.db')),writer=new AnalyticsWriter(store.path);
const context={deviceKey:'synthetic-gzip',active:true,uploadEnabled:true,uploadHourCst:23};
const app=createAnalyticsApp({store,writer,reader:{readCredentialState:()=>({binding:null,revokedThroughSec:null}),acceptsCredential:()=>true,readiness:()=>true,readAnalyticsDeviceContext:()=>context},authSecret:'synthetic-key',internalSecret:'synthetic-internal',controlPath:control,allowSubjects:['synthetic-device'],diskFreeBytes:()=>20*1024**3});
const server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:0});
await new Promise<void>(r=>server.listening?r():server.once('listening',r));
const address=server.address();assert.ok(address&&typeof address!=='string');const url='http://127.0.0.1:'+address.port;
const token=await new SignJWT({kind:'p003-device'}).setSubject('synthetic-device').setProtectedHeader({alg:'HS256'}).setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode('synthetic-key'));
const post=(body:Buffer|string,encoding?:string)=>fetch(url+'/v1/device/analytics/events:batch',{method:'POST',headers:{authorization:'Bearer '+token,'X-Request-Id':'synthetic-gzip-request',...(encoding?{'Content-Encoding':encoding}:{})},body});
const event=(id:string)=>({schema_version:1,client_event_id:id,event_name:'app.bridge_ready',occurred_at_ms:Date.now(),session_id:'synthetic-session',sequence:1,priority:'normal',context:{},properties:{}});
const body={schema_version:1,batch_id:'synthetic-batch',sent_at_ms:Date.now(),client:{},events:[event('synthetic-valid'),{...event('synthetic-invalid'),event_name:'not.allowed'}]};
try{
 const until=Date.now()+20000;while(!writer.ready){assert.ok(Date.now()<until,'writer readiness');await new Promise(r=>setTimeout(r,10));}
 let r=await post(gzipSync(JSON.stringify(body)),'gzip');assert.equal(r.status,200,'gzip must enter the same durable ingest path');
 let ack=await r.json();assert.deepEqual(ack.accepted_event_ids,['synthetic-valid']);assert.deepEqual(ack.rejected,[{client_event_id:'synthetic-invalid',reason:'event_not_allowed'}]);
 r=await post(JSON.stringify(body));assert.equal(r.status,200);ack=await r.json();assert.deepEqual(ack.duplicated_event_ids,['synthetic-valid']);assert.deepEqual(ack.accepted_event_ids,[]);
 assert.equal(store.db.prepare('SELECT count(*) n FROM analytics_event').get()!.n,1);
 const transport=store.db.prepare('SELECT encoding,wire_bytes,inflated_bytes FROM analytics_transport ORDER BY rowid').all();
 assert.equal(transport.length,2);assert.equal(transport[0].encoding,'gzip');assert.equal(transport[1].encoding,'identity');
 assert.equal(transport[0].inflated_bytes,Buffer.byteLength(JSON.stringify(body)));assert.ok(Number(transport[0].wire_bytes)<Number(transport[0].inflated_bytes));
 r=await post(Buffer.from('not-gzip'),'gzip');assert.equal(r.status,400);assert.equal((await r.json()).error_code,'INVALID_GZIP');
 const compressed=gzipSync(JSON.stringify(body));r=await post(compressed.subarray(0,-6),'gzip');assert.equal(r.status,400,'truncated gzip cannot be partially accepted');
 const corrupt=Buffer.from(compressed);corrupt[corrupt.length-8]^=0xff;r=await post(corrupt,'gzip');assert.equal(r.status,400,'CRC corruption rejected');
 let cancelled=false;const hanging=new Request('http://synthetic.test',{method:'POST',body:new ReadableStream({cancel(){cancelled=true;}}),duplex:'half'} as RequestInit);
 await assert.rejects(readAnalyticsBody(hanging,25),/ANALYTICS_BODY_TIMEOUT/);assert.equal(cancelled,true);
 r=await post(compressed,'gzip, gzip');assert.equal(r.status,415);
 r=await post(compressed,'br');assert.equal(r.status,415);
 r=await post(Buffer.alloc(LIMITS.bodyBytes+1),'gzip');assert.equal(r.status,413,'wire bytes bounded');
 r=await post(gzipSync(' '.repeat(LIMITS.bodyBytes+1)),'gzip');assert.equal(r.status,413,'inflated bytes bounded even when wire is tiny');
 assert.equal(store.db.prepare('SELECT count(*) n FROM analytics_event').get()!.n,1,'invalid encodings never persist');
 // Two held gzip requests occupy bounded slots; health stays responsive and a third is retriable.
 const held=Array.from({length:2},()=>{let finish:(code:number)=>void;const done=new Promise<number>(r=>finish=r);const req=httpRequest(url+'/v1/device/analytics/events:batch',{method:'POST',headers:{authorization:'Bearer '+token,'X-Request-Id':'synthetic-held','Content-Encoding':'gzip','Content-Length':compressed.length}},res=>{res.resume();res.on('end',()=>finish(res.statusCode!));});req.write(compressed.subarray(0,10));return {req,done};});
 try{
  const deadline=Date.now()+3000;while(true){const h=await(await fetch(url+'/internal/analytics/health',{headers:{'X-Analytics-Internal-Token':'synthetic-internal'},signal:AbortSignal.timeout(1000)})).json();if(h.in_flight===2)break;assert.ok(Date.now()<deadline);await new Promise(r=>setTimeout(r,10));}
  const third=await post(compressed,'gzip');assert.equal(third.status,503);assert.equal((await third.json()).error_code,'ANALYTICS_OVERLOADED');assert.equal(third.headers.get('retry-after'),'5');
 }finally{held.forEach(h=>h.req.end(compressed.subarray(10)));await Promise.all(held.map(h=>h.done));}
 const health=await(await fetch(url+'/internal/analytics/health',{headers:{'X-Analytics-Internal-Token':'synthetic-internal'}})).json();
 assert.equal(health.in_flight,0);assert.equal(health.storage_failures,0,'malformed clients are not disk failures');
 console.log('analytics gzip: PASS (real HTTP + writer, mixed ACK/raw duplicate, malformed/truncated/encoding/wire/inflated bounds)');
}finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await writer.close();store.close();rmSync(dir,{recursive:true,force:true});}
