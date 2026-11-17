/** Real independent processes, production Analytics lifecycle and history-only facts. */
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fork,type ChildProcess} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {AnalyticsStore} from '../src/analytics/store.js';
import {settleAnalyticsBatch} from '../src/analytics/ingest.js';
import {ArkStore} from '../src/ark/store.js';
import {cstDay,unknownHistory} from '../src/ark/contracts.js';
const mode=process.argv[2],dir=process.argv[3]??mkdtempSync(join(tmpdir(),'ark-warmup-'));
const identity={sn:'BJP00399999999999901',account_id:'warmup-test',epoch:1},key='d'.repeat(64),secret='warmup-synthetic-only';
const url='http://127.0.0.1:3306';
const config={internalUrl:url,internalSecret:secret};
if(mode==='reader'){
 const {startAnalyticsServer}=await import('../src/analytics/index.js');
 const store=new AnalyticsStore(join(dir,'analytics.db')),ark=new ArkStore(join(dir,'ark.db'));
 const reader={acceptsCredential:()=>false,readCredentialState:()=>({binding:null,revokedThroughSec:null}),readiness:()=>true,
  readAnalyticsDeviceContext:()=>({deviceKey:key,active:false,uploadEnabled:false,uploadHourCst:23}),arkDeviceKey:()=>key,
  readArkAuthorization:()=>({...identity,not_before_ms:ark.grant(identity)!.not_before_ms})};
 const service=startAnalyticsServer({store,reader,authSecret:secret,internalSecret:secret,controlPath:join(dir,'control.json'),allowSubjects:[],diskFreeBytes:()=>20*1024**3},3306);
 assert.equal(store.db.prepare('PRAGMA query_only').get()!.query_only,1);assert.equal(store.db.prepare('PRAGMA cache_size').get()!.cache_size,-8192);
 if(!service.server.listening)await once(service.server,'listening');process.send?.({ready:true});
 await once(process,'message');await service.stop();ark.close();process.disconnect();
}else if(mode==='client'){
 const {warmArkHistory}=await import('../src/ark/warmup.js');
 const {ArkRuntime}=await import('../src/ark/runtime.js');
 const ark=new ArkStore(join(dir,'ark.db'));
 const result=await warmArkHistory(config);assert.equal(result.status,'ready');
 assert.equal(ark.current(identity),null,'no snapshot can mask a lost history result');
 const runtime=new ArkRuntime({workerAccountId:'test',store:ark,readIdentity:()=>identity,validAccount:()=>true,...config});
 const start=performance.now(),facts=await runtime.preview(identity.sn),ms=performance.now()-start;
 assert.equal(facts.facts_v1?.daily?.progress_seconds,600,'first actual history must be adopted');
 assert.equal(facts.facts_v1?.assets.family_coin?.value,17);
 assert.match(facts.prompt,/600秒/);assert(ms<125,'first real history within unchanged budget');
 console.log(JSON.stringify({warmup:result.status,first_ms:ms,daily:600,snapshot:false}));ark.close();
}else{
 const children:ChildProcess[]=[];
 const child=(role:string)=>{const p=fork(fileURLToPath(import.meta.url),[role,dir],{execArgv:['--import','tsx'],stdio:['ignore','pipe','pipe','ipc']});children.push(p);let logs='';p.stdout!.on('data',b=>logs+=b);p.stderr!.on('data',b=>logs+=b);return {p,logs:()=>logs};};
 const deadline=async<T>(p:Promise<T>,ms=15000)=>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([p,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('test deadline')),ms);})]);}finally{clearTimeout(timer);}};
 try{
  writeFileSync(join(dir,'control.json'),'{"enabled":false}',{mode:0o600});
  const now=Date.now(),day=cstDay(now),ark=new ArkStore(join(dir,'ark.db'));ark.configure(true,[identity],now-10000);ark.close();
  const store=new AnalyticsStore(join(dir,'analytics.db'));
  const events=[['g1.logical_day_changed',{previous_logical_day:cstDay(now-86400000),logical_day:day,previous_usage_day_index:1,usage_day_index:2,gm_override:false}],['g1.wallet_balance_changed',{item_id:'C-FAMILY-001',before:0,after:17,delta:17}],['g1.progress_checkpoint',{logical_day:day,elapsed_seconds:600,checkpoint_minutes:10,completed_slots:1,current_slot:1}]].map(([name,properties],i)=>({schema_version:1,client_event_id:'warm'+i,event_name:name,occurred_at_ms:now-3000+i*500,session_id:'s',sequence:i,priority:'normal',context:{},properties}));
  const ack=settleAnalyticsBatch(store,{deviceKey:key,active:true,uploadEnabled:true,uploadHourCst:23},{schema_version:1,batch_id:'warm-batch',sent_at_ms:now,client:{content_version:'warm-content'},events} as any,'warm-rid',now);assert.equal(ack.rejected.length,0);store.close();
  const reader=child('reader');await deadline(once(reader.p,'message'));
  const endpoint=url+'/internal/analytics/ark-warmup';
  const request=(body:string,token=secret)=>fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json','X-Analytics-Internal-Token':token},body});
  let r=await request('{}');assert.equal(r.status,200,'production warmup endpoint');assert.equal(r.headers.get('cache-control'),'no-store');assert.deepEqual(await r.json(),unknownHistory());
  r=await request('{}','wrong');assert.equal(r.status,401);await r.body?.cancel();
  for(const b of ['null','[]','{"subject":"'+identity.sn+'"}']){r=await request(b);assert.equal(r.status,400);await r.body?.cancel();}
  r=await request(' '.repeat(1025));assert.equal(r.status,413);await r.body?.cancel();
  for(let i=0;i<3;i++){const c=child('client');const [code]=await deadline(once(c.p,'exit'));assert.equal(code,0,c.logs());console.log(c.logs().trim());}
  const {warmArkHistory}=await import('../src/ark/warmup.js');
  for(const bad of ['https://127.0.0.1:3306','http://example.com','http://user@127.0.0.1:3306'])assert.equal((await warmArkHistory({...config,internalUrl:bad})).status,'skipped');
  assert.equal((await warmArkHistory({...config,internalSecret:''})).status,'skipped');
  assert.equal((await warmArkHistory({...config,internalSecret:'wrong'})).status,'degraded');
  const closed=once(reader.p,'exit');reader.p.send({stop:true});assert.equal((await deadline(closed))[0],0,reader.logs());
  const start=performance.now();assert.equal((await warmArkHistory(config)).status,'degraded');assert(performance.now()-start<1500);
  const check=new AnalyticsStore(join(dir,'analytics.db'));assert.equal(check.db.prepare('SELECT count(*) n FROM analytics_event').get()!.n,3);assert.equal(check.db.prepare('SELECT count(*) n FROM analytics_event_seen').get()!.n,3);check.close();
  console.log('ark warmup: PASS (real HTTP, no enrollment, strict auth/body, 8MiB reader, first history-only adoption, degraded startup)');
 }finally{for(const p of children)if(p.exitCode===null){const exit=once(p,'exit');p.kill('SIGTERM');await deadline(exit).catch(()=>p.kill('SIGKILL'));}rmSync(dir,{recursive:true,force:true});}
}
