/** 独立验收：复制至固定候选 apps/server/scripts 后用 node --import tsx 运行。
 * 仅合成身份、临时SQLite、localhost；不读取环境中的生产配置，不调用模型。
 */
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHmac} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {serve} from '@hono/node-server';
import {SignJWT} from 'jose';
import {AnalyticsStore} from '../src/analytics/store.js';
import {AnalyticsWriter} from '../src/analytics/writer.js';
import {createAnalyticsApp} from '../src/analytics/index.js';

const directory=mkdtempSync(join(tmpdir(),'p003-audit45-'));
const database=join(directory,'analytics.db'),control=join(directory,'control.json');
writeFileSync(control,JSON.stringify({enabled:true}),{mode:0o600});
const subjects=['audit45-synthetic-a','audit45-synthetic-b'];
const secret='audit45-synthetic-local-jwt-secret';
const key=(subject:string)=>createHmac('sha256','audit45-synthetic-hmac').update(subject).digest('hex');
const reader={
  readiness:()=>true,acceptsCredential:()=>true,
  readCredentialState:()=>({binding:null,revokedThroughSec:null}),
  readAnalyticsDeviceContext:(subject:string)=>({deviceKey:key(subject),active:true,uploadEnabled:true,uploadHourCst:23}),
};
const sign=(subject:string)=>new SignJWT({kind:'p003-device'}).setSubject(subject)
  .setProtectedHeader({alg:'HS256'}).setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(secret));
const tokens=await Promise.all(subjects.map(sign));
const results:{name:string;status:string;milliseconds:number}[]=[];
let store:AnalyticsStore,writer:AnalyticsWriter,server:ReturnType<typeof serve>,base='';
const until=async(predicate:()=>boolean)=>{const deadline=Date.now()+8000;while(!predicate()){
  if(Date.now()>deadline)throw Error('audit45 readiness timeout');await new Promise(r=>setTimeout(r,10));
}};
async function start(){
  store=new AnalyticsStore(database);writer=new AnalyticsWriter(database);await until(()=>writer.ready);
  const app=createAnalyticsApp({store,writer,reader,authSecret:secret,internalSecret:'audit45-private-internal',controlPath:control,
    allowSubjects:subjects,globalRpm:600,diskFreeBytes:()=>20*1024**3,bodyTimeoutMs:1000});
  server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:0});await until(()=>server.listening);
  const address=server.address();assert.ok(address&&typeof address!=='string');base='http://127.0.0.1:'+address.port;
}
async function stop(){
  if(server){server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
  if(writer)await writer.close();if(store)store.close();
}
const event=(id:string)=>({schema_version:1,client_event_id:id,event_name:'app.bridge_ready',occurred_at_ms:Date.now(),
  session_id:'audit45-synthetic-session',sequence:1,priority:'normal',context:{},properties:{}});
const batch=(events:unknown[])=>({schema_version:1,batch_id:'audit45-batch',sent_at_ms:Date.now(),client:{content_version:'audit45-synthetic'},events});
let rid=0;
async function request(body:unknown,{gzip=false,token=tokens[0],encoding}: {gzip?:boolean;token?:string;encoding?:string}={}){
  const requestId='audit45-rid-'+ ++rid;
  const bytes=Buffer.isBuffer(body)?body:Buffer.from(JSON.stringify(body));
  const response=await fetch(base+'/v1/device/analytics/events:batch',{method:'POST',headers:{
    Authorization:'Bearer '+token,'X-Request-Id':requestId,'Content-Type':'application/json',
    ...(encoding?{'Content-Encoding':encoding}:gzip?{'Content-Encoding':'gzip'}:{}),
  },body:gzip?gzipSync(bytes):bytes});
  const contentType=response.headers.get('content-type')??'';
  const text=await response.text();let json:any;try{json=JSON.parse(text);}catch{throw Error('Non-JSON response '+response.status);}
  return {status:response.status,json,requestId,contentType};
}
function exact(result:Awaited<ReturnType<typeof request>>,accepted:string[],duplicated:string[],rejected:string[]){
  assert.equal(result.status,200);assert.equal(result.json.ok,true);assert.equal(result.json.request_id,result.requestId);
  assert.deepEqual([...result.json.accepted_event_ids].sort(),[...accepted].sort());
  assert.deepEqual([...result.json.duplicated_event_ids].sort(),[...duplicated].sort());
  assert.deepEqual(result.json.rejected.map((x:any)=>x.client_event_id).sort(),[...rejected].sort());
  const all=[...result.json.accepted_event_ids,...result.json.duplicated_event_ids,...result.json.rejected.map((x:any)=>x.client_event_id)];
  assert.equal(new Set(all).size,all.length,'ACK三集合必须互斥');
}
const count=()=>Number(store.db.prepare('SELECT count(*) n FROM analytics_event').get()!.n);
async function check(name:string,run:()=>Promise<void>){const start=performance.now();try{await run();results.push({name,status:'PASS',milliseconds:performance.now()-start});}
catch(error){results.push({name,status:'FAIL',milliseconds:performance.now()-start});throw error;}}
try{
 await start();
 const stable=event('audit45-stable');
 await check('gzip/raw同义、精确混批ACK、提交后可查',async()=>{
   exact(await request(batch([stable]),{gzip:true}),[stable.client_event_id],[],[]);
   assert.equal(count(),1,'ACK之后SQLite已持久化可查');
   const invalid={...event('audit45-invalid'),event_name:'audit45.not_allowed'};
   const good=event('audit45-second');
   exact(await request(batch([stable,good,invalid])),[good.client_event_id],[stable.client_event_id],[invalid.client_event_id]);
   assert.equal(count(),2);
 });
 await check('同ID内容冲突不得覆盖',async()=>{
   exact(await request(batch([{...stable,sequence:2}])),[],[],[stable.client_event_id]);assert.equal(count(),2);
 });
 await check('设备主体隔离及认证失败无写入',async()=>{
   exact(await request(batch([stable]),{token:tokens[1]}),[stable.client_event_id],[],[]);
   const n=count();assert.equal((await request(batch([event('audit45-unauthorized')]),{token:'invalid'})).status,401);assert.equal(count(),n);
 });
 await check('writer和HTTP重启后仍duplicated',async()=>{
   await stop();await start();exact(await request(batch([stable]),{gzip:true}),[],[stable.client_event_id],[]);assert.equal(count(),3);
 });
 await check('gzip截断、CRC错误及垃圾不写库',async()=>{
   const valid=gzipSync(Buffer.from(JSON.stringify(batch([event('audit45-gzip-error')]))));
   const corrupt=Buffer.from(valid);corrupt[corrupt.length-8]^=0xff;
   for(const bytes of [valid.subarray(0,valid.length-5),corrupt,Buffer.from('not-a-gzip')]){
     const n=count(),r=await request(bytes,{encoding:'gzip'});assert.equal(r.status,400);assert.equal(count(),n);
   }
 });
 await check('多重Content-Encoding拒绝且无写入',async()=>{
   const n=count(),r=await request(gzipSync(Buffer.from(JSON.stringify(batch([event('audit45-double-encoding')])))),{encoding:'gzip, gzip'});
   assert.ok([400,415].includes(r.status));assert.equal(count(),n);
 });
 await check('wire和inflated各2MiB上界、JSON413',async()=>{
   for(const gzip of [false,true]){
     const n=count(),r=await request(Buffer.from(' '.repeat(2*1024*1024+1)),{gzip});
     assert.equal(r.status,413);assert.match(r.contentType,/application\/json/);assert.equal(count(),n);
   }
 });
 await check('关闭总闸保留重试语义、健康可读',async()=>{
   writeFileSync(control,'{"enabled":false}',{mode:0o600});const n=count();
   assert.equal((await request(batch([event('audit45-off')]))).status,503);assert.equal(count(),n);
   assert.equal((await fetch(base+'/health')).status,200);writeFileSync(control,'{"enabled":true}',{mode:0o600});
 });
 console.log(JSON.stringify({suite:'audit45-independent-http',status:'PASS',scope:'synthetic localhost HTTP+real writer+SQLite',results,
   not_verified:['new aggregate/sample authorization and TTL','production','Android runtime','real voice','7-day savings']},null,2));
}catch(error){
 console.error(JSON.stringify({suite:'audit45-independent-http',status:'FAIL',results,error:String(error)},null,2));process.exitCode=1;
}finally{await stop();rmSync(directory,{recursive:true,force:true});}
