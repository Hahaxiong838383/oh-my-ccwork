import assert from 'node:assert/strict';
import {spawn,type ChildProcess} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {SignJWT} from 'jose';
import {AnalyticsStore} from '../src/analytics/store.js';

const dir=mkdtempSync(join(tmpdir(),'analytics-recovery-'));
const children:ChildProcess[]=[];
const source=(name:string)=>new URL('../src/'+name,import.meta.url).href;
const control=join(dir,'control.json');writeFileSync(control,'{"enabled":true}',{mode:0o600});
const worker=join(dir,'delayed-commit.mjs');
writeFileSync(worker,`import {parentPort,workerData} from 'node:worker_threads';
import {writeFileSync} from 'node:fs';
import {tsImport} from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))};
const {AnalyticsStore}=await tsImport(${JSON.stringify(source('analytics/store.ts'))},import.meta.url);
const {settleAnalyticsBatch}=await tsImport(${JSON.stringify(source('analytics/ingest.ts'))},import.meta.url);
const store=new AnalyticsStore(workerData.path);
parentPort.on('message',m=>{
 if(m.type==='close'){store.close();parentPort.postMessage({type:'closed'});parentPort.close();return;}
 if(m.type==='settle')setTimeout(()=>{
  const ack=settleAnalyticsBatch(store,m.context,JSON.parse(m.serializedBatch),m.requestId);
  writeFileSync(workerData.path+'.committed','yes');
  parentPort.postMessage({type:'result',id:m.id,ok:true,ack});
 },250);
});parentPort.postMessage({type:'ready'});`);
const entry=join(dir,'server.mts');
writeFileSync(entry,`import {AnalyticsStore} from ${JSON.stringify(source('analytics/store.ts'))};
import {AnalyticsWriter} from ${JSON.stringify(source('analytics/writer.ts'))};
import {startAnalyticsServer} from ${JSON.stringify(source('analytics/index.ts'))};
import {pathToFileURL} from 'node:url';
const store=new AnalyticsStore(process.env.TEST_DB!);
const writer=new AnalyticsWriter(store.path,process.env.TEST_DELAY==='1'?{workerUrl:pathToFileURL(${JSON.stringify(worker)}),jobTimeoutMs:30,closeTimeoutMs:Number(process.env.TEST_CLOSE_MS??30000)}:{});
const service=startAnalyticsServer({store,writer,reader:{readCredentialState:()=>({binding:null,revokedThroughSec:null}),acceptsCredential:()=>true,readiness:()=>true,readAnalyticsDeviceContext:()=>({deviceKey:'recovery-synthetic',active:true,uploadEnabled:true,uploadHourCst:0})},authSecret:'recovery-test-only',internalSecret:'recovery-internal-only',controlPath:${JSON.stringify(control)},allowSubjects:['recovery-synthetic'],diskFreeBytes:()=>20*1024**3},3306);
const timer=setInterval(()=>{if(writer.ready&&service.checkpointer.status().last_success_ms!==null){clearInterval(timer);process.send?.({ready:true});}},10);timer.unref();`);
async function start(db:string,slow:boolean,closeMs=30000){
 const child=spawn(process.execPath,['--import','tsx',entry],{cwd:process.cwd(),env:{...process.env,TEST_DB:db,TEST_DELAY:slow?'1':'0',TEST_CLOSE_MS:String(closeMs)},stdio:['ignore','pipe','pipe','ipc']});children.push(child);
 let logs='';child.stdout!.on('data',b=>logs+=b);child.stderr!.on('data',b=>logs+=b);
 await new Promise<void>((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('server startup timed out: '+logs)),10000);
  child.on('message',m=>{if((m as {ready?:boolean}).ready){clearTimeout(timer);resolve();}});
  child.once('exit',code=>{clearTimeout(timer);reject(new Error('server exited during startup: '+code+' '+logs));});
 });
 return child;
}
async function until(predicate:()=>boolean,timeout=3000){const deadline=Date.now()+timeout;while(!predicate()&&Date.now()<deadline)await delay(10);return predicate();}
const token=await new SignJWT({kind:'p003-device'}).setSubject('recovery-synthetic').setProtectedHeader({alg:'HS256'}).setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode('recovery-test-only'));
const stamp=Date.now();
const batch=(id:string)=>({schema_version:1,batch_id:id,sent_at_ms:stamp,client:{},events:[0,1].map(i=>({schema_version:1,client_event_id:id+'-'+i,event_name:'app.bridge_ready',occurred_at_ms:stamp,session_id:'recovery-test',sequence:i,priority:'normal',context:{},properties:{}}))});
const post=(body:unknown)=>fetch('http://127.0.0.1:3306/v1/device/analytics/events:batch',{method:'POST',headers:{authorization:'Bearer '+token,'X-Request-Id':'recovery-test-request'},body:JSON.stringify(body),signal:AbortSignal.timeout(2000)});
try{
 for(const [name,closeMs]of [['late-commit',30000],['late-after-close-timeout',40]]as const){
  const db=join(dir,name+'.db'),body=batch(name),child=await start(db,true,closeMs);
  const response=await post(body);assert.equal(response.status,503);assert.equal((await response.json()).error_code,'ANALYTICS_STORAGE_UNAVAILABLE');
  assert.equal(child.exitCode,null,'request deadline must not kill the in-flight transaction');
  assert.equal(existsSync(db+'.committed'),false,'503 is delivered before the delayed commit');
  assert.ok(await until(()=>existsSync(db+'.committed')),'late commit must finish');
  assert.ok(await until(()=>child.exitCode!==null),'failed writer drained but HTTP process did not exit for supervisor recovery');
  assert.equal(child.exitCode,1,'storage failure must request a supervisor restart');
  const observer=new AnalyticsStore(db);
  const counts=()=>['analytics_event','analytics_event_seen','analytics_rollup_fact'].map(t=>Number(observer.db.prepare('SELECT count(*) n FROM '+t).get()!.n));
  const before=counts();assert.equal(before[0],2);assert.equal(before[1],2);
  const recovered=await start(db,false);
  const replay=await post(body);assert.equal(replay.status,200);const ack=await replay.json();
  assert.deepEqual(ack.accepted_event_ids,[]);assert.deepEqual(ack.duplicated_event_ids,body.events.map(e=>e.client_event_id));assert.deepEqual(ack.rejected,[]);
  assert.deepEqual(counts(),before,'retry after restart must not duplicate events, seen or rollup facts');
  recovered.kill('SIGTERM');assert.ok(await until(()=>recovered.exitCode!==null));assert.equal(recovered.exitCode,0,'ordinary shutdown must remain successful');observer.close();
 }
 console.log('analytics recovery: PASS (HTTP 503, late durable commit, actual writer exit, supervisor restart signal, replay dedup, normal close)');
}finally{
 for(const child of children)if(child.exitCode===null){child.kill('SIGTERM');if(!await until(()=>child.exitCode!==null,3000))child.kill('SIGKILL');}
 rmSync(dir,{recursive:true,force:true});
}
