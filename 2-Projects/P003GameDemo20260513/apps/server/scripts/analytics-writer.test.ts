import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {AnalyticsStore,AnalyticsStorageUnavailable} from '../src/analytics/store.js';
import {validateAnalyticsBatch,type AnalyticsBatch} from '../src/analytics/contracts.js';
import {AnalyticsWriter,AnalyticsWriterBusy} from '../src/analytics/writer.js';

const dir=mkdtempSync(join(tmpdir(),'analytics-writer-'));
const context={deviceKey:'writer-fake-device',active:true,uploadEnabled:true,uploadHourCst:0};
const stamp=Date.now();
const event=(id:string,sequence=1)=>({schema_version:1,client_event_id:id,event_name:'app.session_started',occurred_at_ms:stamp,session_id:'writer-session',sequence,priority:'normal',context:{},properties:{platform:'Android',entry_mode:'launcher'}});
const batch=(events:unknown[]):AnalyticsBatch=>validateAnalyticsBatch({schema_version:1,batch_id:'writer-batch',sent_at_ms:stamp,client:{},events});
const send=(writer:AnalyticsWriter,id:string)=>writer.settle(context,batch([event(id)]),'request-'+id);
async function until(check:()=>boolean,timeout=5000){const end=Date.now()+timeout;while(!check()){assert.ok(Date.now()<end,'worker lifecycle deadline');await delay(5);}}
const writers:AnalyticsWriter[]=[],stores:AnalyticsStore[]=[];
const track=(writer:AnalyticsWriter)=>{writers.push(writer);return writer;};
let caseNumber=0;
const fixture=()=>{const store=new AnalyticsStore(join(dir,'case-'+caseNumber+++'.db'));stores.push(store);return store;};
const count=(store:AnalyticsStore,id:string)=>Number(store.db.prepare('SELECT count(*) n FROM analytics_event WHERE client_event_id=?').get(id)!.n);
const stableStorageError=(error:unknown)=>error instanceof AnalyticsStorageUnavailable&&error.message==='ANALYTICS_STORAGE_UNAVAILABLE';
const readyCode=`parentPort.postMessage({type:'ready'});`;
function workerFixture(name:string,onJob:string,withDatabase=false){
 const imports=withDatabase?`import {tsImport} from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))};
 const {AnalyticsStore}=await tsImport(${JSON.stringify(new URL('../src/analytics/store.ts',import.meta.url).href)},import.meta.url);
 const {settleAnalyticsBatch}=await tsImport(${JSON.stringify(new URL('../src/analytics/ingest.ts',import.meta.url).href)},import.meta.url);
 const store=new AnalyticsStore(workerData.path);`:'let store;';
 const path=join(dir,name+'.mjs');
 writeFileSync(path,`import {parentPort,workerData} from 'node:worker_threads';\n${imports}\n${readyCode}
 parentPort.on('message',m=>{if(m.type==='close'){store?.close();parentPort.postMessage({type:'closed'});parentPort.close();return;}if(m.type==='settle'){${onJob}}});`,{mode:0o600});
 return pathToFileURL(path);
}

try{
 // Real worker startup is asynchronous; before ready there is no hidden submission queue.
 const store=fixture(),writer=track(new AnalyticsWriter(store.path));
 assert.equal(writer.ready,false);
 await assert.rejects(send(writer,'before-ready'),stableStorageError);
 await until(()=>writer.ready);
 const A=event('A'),B=event('B');
 const first=writer.settle(context,batch([A,B]),'first');assert.equal(writer.busy,true,'busy须在postMessage前同步置位');
 assert.deepEqual((await first).accepted_event_ids,['A','B']);
 assert.equal(writer.busy,false);assert.equal(count(store,'A'),1,'ACK到达时另一连接已能读取COMMIT后的行');
 assert.deepEqual((await writer.settle(context,batch([A,B]),'replay')).duplicated_event_ids,['A','B']);
 assert.deepEqual((await writer.settle(context,batch([{...A,sequence:2}]),'conflict')).rejected,[{client_event_id:'A',reason:'client_event_id_conflict'}]);
 assert.equal(count(store,'A'),1);assert.equal(count(store,'before-ready'),0);

 // JSON nesting beyond structuredClone's stack must still receive per-event terminal outcomes.
 const deep=(id:string,depth:number,leaf=0)=>JSON.stringify({...event(id),properties:{extra:'DEEP_PLACEHOLDER'}}).replace('"DEEP_PLACEHOLDER"','['.repeat(depth)+leaf+']'.repeat(depth));
 const serialized=(events:string[])=>'{"schema_version":1,"batch_id":"deep-writer","sent_at_ms":'+stamp+',"client":{},"events":['+events.join(',')+']}';
 const sendSerialized=(events:string[],requestId:string)=>{const source=serialized(events);return writer.settle(context,validateAnalyticsBatch(JSON.parse(source)),requestId,source);};
 for(const depth of [4000,10000]){
  const id='deep-'+depth,good='deep-good-'+depth;
  const ack=await sendSerialized([JSON.stringify(event(good)),deep(id,depth)],'mixed-'+depth);
  assert.deepEqual(ack.accepted_event_ids,[good]);assert.deepEqual(ack.duplicated_event_ids,[]);
  assert.deepEqual(ack.rejected,[{client_event_id:id,reason:'invalid_event'}]);
  assert.equal(count(store,good),1);assert.equal(count(store,id),0);
 }
 assert.deepEqual((await sendSerialized([deep('deep-identical',4000),deep('deep-identical',4000)],'identical')).rejected,[{client_event_id:'deep-identical',reason:'invalid_event'}]);
 assert.deepEqual((await sendSerialized([deep('deep-conflict',4000),deep('deep-conflict',4000,1)],'deep-conflict')).rejected,[{client_event_id:'deep-conflict',reason:'client_event_id_conflict'}]);
 assert.deepEqual((await sendSerialized([JSON.stringify(event('valid-deep-conflict')),deep('valid-deep-conflict',10000)],'valid-deep-conflict')).rejected,[{client_event_id:'valid-deep-conflict',reason:'client_event_id_conflict'}]);
 assert.equal(count(store,'valid-deep-conflict'),0);

 // An actual external SQLite writer lock blocks the worker, while the main loop keeps ticking.
 store.db.exec('BEGIN IMMEDIATE');
 let heartbeats=0;const heartbeat=setInterval(()=>heartbeats++,5),began=performance.now();
 const locked=send(writer,'after-lock');
 const refusal=performance.now();await assert.rejects(send(writer,'must-not-queue'),e=>e instanceof AnalyticsWriterBusy);
 assert.ok(performance.now()-refusal<100,'忙请求应立即拒绝，不能排队等待数据库');
 const unlock=setTimeout(()=>store.db.exec('COMMIT'),75);
 try{assert.deepEqual((await locked).accepted_event_ids,['after-lock']);}finally{clearTimeout(unlock);clearInterval(heartbeat);if(store.db.isTransaction)store.db.exec('ROLLBACK');}
 assert.ok(performance.now()-began>=50);assert.ok(heartbeats>=3,'SQLite等待期间主线程计时器仍应执行');
 assert.equal(count(store,'must-not-queue'),0);

 // A SQLite lock timeout is a storage failure, distinct from refusing the occupied writer slot.
 store.db.exec('BEGIN IMMEDIATE');
 try{await assert.rejects(send(writer,'sqlite-busy'),error=>stableStorageError(error)&&(error as AnalyticsStorageUnavailable).busy);}
 finally{store.db.exec('ROLLBACK');}
 assert.equal(writer.ready,true);assert.equal(writer.busy,false);assert.equal(count(store,'sqlite-busy'),0);

 // Failed commits return stable errors and roll back all tables for the complete batch.
 store.db.exec("CREATE TRIGGER abort_event BEFORE INSERT ON analytics_event WHEN NEW.client_event_id='FAIL' BEGIN SELECT RAISE(ABORT,'test body must not escape'); END");
 const before=Number(store.db.prepare('SELECT count(*) n FROM analytics_event_seen').get()!.n);
 await assert.rejects(writer.settle(context,batch([event('ROLLBACK'),event('FAIL')]),'failure'),stableStorageError);
 assert.equal(count(store,'ROLLBACK'),0);assert.equal(count(store,'FAIL'),0);
 assert.equal(store.db.prepare('SELECT count(*) n FROM analytics_event_seen').get()!.n,before);
 store.db.exec('DROP TRIGGER abort_event');assert.equal(writer.ready,true);

 // A deferred constraint fails at COMMIT itself, after the raw/fact/seen/settlement inserts ran.
 const tables=['analytics_event','analytics_event_seen','analytics_rollup_fact','analytics_batch','analytics_settlement'];
 const counts=()=>tables.map(table=>Number(store.db.prepare('SELECT count(*) n FROM '+table).get()!.n));
 const beforeCommitFailure=counts();
 store.db.exec("CREATE TABLE writer_commit_parent(id INTEGER PRIMARY KEY); CREATE TABLE writer_commit_guard(id INTEGER PRIMARY KEY,missing_parent INTEGER REFERENCES writer_commit_parent(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER fail_commit AFTER INSERT ON analytics_event WHEN NEW.client_event_id='COMMIT_FAIL' BEGIN INSERT INTO writer_commit_guard VALUES (1,1); END");
 await assert.rejects(writer.settle(context,batch([event('COMMIT_ROLLBACK'),event('COMMIT_FAIL')]),'commit-failure'),stableStorageError);
 assert.deepEqual(counts(),beforeCommitFailure,'COMMIT失败后所有业务表都必须回到批次开始前');
 assert.equal(store.db.prepare('SELECT count(*) n FROM writer_commit_guard').get()!.n,0);
 store.db.exec('DROP TRIGGER fail_commit; DROP TABLE writer_commit_guard; DROP TABLE writer_commit_parent');
 assert.equal(writer.ready,true);

 // Serialization errors must release the one slot and cannot leak the rejected payload.
 const uncloneable={...batch([event('uncloneable')]),client:{bad:()=>{}}} as unknown as AnalyticsBatch;
 await assert.rejects(writer.settle(context,uncloneable,'clone'),stableStorageError);
 assert.equal(writer.busy,false);assert.equal(writer.ready,true);
 assert.deepEqual((await send(writer,'after-clone')).accepted_event_ids,['after-clone']);

 // Closing refuses new requests immediately but lets the already accepted transaction finish.
 store.db.exec('BEGIN IMMEDIATE');const last=send(writer,'finish-before-close');
 const closing=writer.close();assert.equal(writer.close(),closing,'关闭调用应复用同一个Promise');
 assert.equal(writer.ready,false);await assert.rejects(send(writer,'during-close'),stableStorageError);
 const release=setTimeout(()=>store.db.exec('COMMIT'),75);
 try{assert.deepEqual((await last).accepted_event_ids,['finish-before-close']);await closing;}finally{clearTimeout(release);if(store.db.isTransaction)store.db.exec('ROLLBACK');}
 assert.equal(writer.busy,false);assert.equal(count(store,'finish-before-close'),1);assert.equal(count(store,'during-close'),0);
 await assert.rejects(send(writer,'after-close'),stableStorageError);await writer.close();

 // A real FULL commit followed by worker exit loses the ACK, not the durable event.
 const crashStore=fixture();
 const crash=track(new AnalyticsWriter(crashStore.path,{workerUrl:workerFixture('commit-crash',`settleAnalyticsBatch(store,m.context,m.batch,m.requestId);process.exit(19);`,true)}));
 await until(()=>crash.ready);
 await assert.rejects(send(crash,'committed-before-crash'),stableStorageError);
 assert.equal(crash.ready,false);assert.equal(crash.busy,false);assert.equal(count(crashStore,'committed-before-crash'),1);
 const attempts=crashStore.db.prepare('SELECT count(*) n FROM analytics_batch').get()!.n;
 await delay(30);assert.equal(crashStore.db.prepare('SELECT count(*) n FROM analytics_batch').get()!.n,attempts,'writer故障不能自动重放');
 await assert.rejects(send(crash,'after-crash'),stableStorageError);
 const restarted=track(new AnalyticsWriter(crashStore.path));await until(()=>restarted.ready);
 assert.deepEqual((await send(restarted,'committed-before-crash')).duplicated_event_ids,['committed-before-crash']);
 assert.equal(count(crashStore,'committed-before-crash'),1);await restarted.close();

 // Uncaught thread errors and malformed results both fail closed instead of manufacturing ACKs.
 for(const [name,code] of [['throw','throw new Error("test credential must not escape")'],['bad-message','parentPort.postMessage({type:"result",id:m.id+1,ok:true,ack:{ok:true}})']] as const){
  const db=fixture(),broken=track(new AnalyticsWriter(db.path,{workerUrl:workerFixture(name,code)}));
  await until(()=>broken.ready);await assert.rejects(send(broken,name),stableStorageError);
  assert.equal(broken.ready,false);assert.equal(broken.busy,false);assert.equal(count(db,name),0);
 }

 // messageerror is a transport fault. Inject the documented Worker event, without a test-only API.
 const transport=track(new AnalyticsWriter(fixture().path,{workerUrl:workerFixture('message-error','')}));
 await until(()=>transport.ready);const lost=send(transport,'transport-lost');const lostRejected=assert.rejects(lost,stableStorageError);
 (transport as unknown as {worker:{emit:(event:string,error:Error)=>void}}).worker.emit('messageerror',new Error('must not escape'));
 await lostRejected;assert.equal(transport.ready,false);assert.equal(transport.busy,false);await transport.close();

 // Timeout is bounded and refuses work, but does not kill a normal transaction still completing.
 const slowStore=fixture(),slow=track(new AnalyticsWriter(slowStore.path,{closeTimeoutMs:20,workerUrl:workerFixture('slow-close',`setTimeout(()=>{const ack=settleAnalyticsBatch(store,m.context,m.batch,m.requestId);parentPort.postMessage({type:'result',id:m.id,ok:true,ack});},100);`,true)}));
 await until(()=>slow.ready);
 const slowJob=send(slow,'late-durable');const failedJob=assert.rejects(slowJob,stableStorageError);
 const timed=slow.close();await assert.rejects(timed,stableStorageError);await failedJob;
 assert.equal(slow.ready,false);await assert.rejects(send(slow,'after-timeout'),stableStorageError);
 await until(()=>!slow.busy);assert.equal(count(slowStore,'late-durable'),1,'close超时不能强杀正常提交');
 assert.equal(slow.close(),timed);await delay(30);

 // The request deadline fails closed before the proxy timeout, even if the commit later succeeds.
 const deadlineStore=fixture(),deadline=track(new AnalyticsWriter(deadlineStore.path,{jobTimeoutMs:20,workerUrl:workerFixture('job-deadline',`setTimeout(()=>{const ack=settleAnalyticsBatch(store,m.context,m.batch,m.requestId);parentPort.postMessage({type:'result',id:m.id,ok:true,ack});},100);`,true)}));
 await until(()=>deadline.ready);
 let lateSuccess=false;const deadlineStarted=performance.now();
 const deadlineJob=send(deadline,'deadline-durable').then(ack=>{lateSuccess=true;return ack;});
 await assert.rejects(deadlineJob,stableStorageError);
 assert.ok(performance.now()-deadlineStarted<500,'必须在主线程有界拒绝，不能等待迟到的SQL结果');
 assert.equal(deadline.ready,false);assert.equal(deadline.busy,true,'超时后保留实际在途状态');
 await assert.rejects(send(deadline,'after-job-timeout'),stableStorageError);
 await deadline.close();
 assert.equal(lateSuccess,false);assert.equal(deadline.ready,false);assert.equal(deadline.busy,false);
 assert.equal(count(deadlineStore,'deadline-durable'),1);assert.equal(count(deadlineStore,'after-job-timeout'),0);

 // Close during startup is also bounded and never briefly becomes ready to accept a job.
 const early=track(new AnalyticsWriter(fixture().path));const earlyClose=early.close();
 await assert.rejects(send(early,'startup-close'),stableStorageError);await earlyClose;assert.equal(early.ready,false);
 const badStartup=track(new AnalyticsWriter('relative-path-must-fail.db'));
 await assert.rejects(send(badStartup,'bad-startup'),stableStorageError);await assert.rejects(badStartup.close(),stableStorageError);
 assert.equal(badStartup.ready,false);assert.equal(badStartup.busy,false);
 console.log('analytics writer: PASS (real durable ACK, single slot, live heartbeat, atomic failure, worker crash/replay, bounded close and job deadline)');
}finally{
 await Promise.allSettled(writers.map(writer=>writer.close()));
 for(const store of stores){if(store.db.isTransaction)store.db.exec('ROLLBACK');store.close();}
 rmSync(dir,{recursive:true,force:true});
}
