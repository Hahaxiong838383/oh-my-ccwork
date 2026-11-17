/** T5 synthetic loopback harness; no production identities, credentials or endpoints. */
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,appendFileSync,readFileSync,existsSync,realpathSync,statfsSync,statSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash,randomBytes} from 'node:crypto';
import {serve} from '@hono/node-server';
import {SignJWT} from 'jose';
import {AnalyticsStore} from '../src/analytics/store.js';
import {installRollupPrefixIndex} from '../src/analytics/rollup-index.js';
import {AnalyticsWriter} from '../src/analytics/writer.js';
import {AnalyticsCheckpointer} from '../src/analytics/checkpointer.js';
import {createAnalyticsApp} from '../src/analytics/index.js';
import {ArkStore} from '../src/ark/store.js';
import {createArkRoutes} from '../src/ark/routes.js';
import {installArkHistoryIndexes} from '../src/ark/history-indexes.js';
import {loadDatabaseCounts} from '../deploy/analytics-smoke-and-load.mjs';
import {createLoadHealthRecorder} from './storage-load-health.js';
import {createStreamingAccounting,analyseRequests,readJsonl} from './storage-load-ledger.js';
import {linuxResources,createResourceRecorder} from './storage-load-resources.js';
import {soakPlan} from './storage-soak-schedule.js';
import {startSharedQuery} from './storage-shared-query-client.js';
import {sqlProfiler} from './storage-sql-profile.js';
import {startArkProducer} from './storage-ark-producer.js';

const mode=process.argv[2],root=resolve(process.argv[3]??'');
assert.ok(['run','client'].includes(mode),'run|client');
assert.ok(root.includes('p003-t5-')&&!root.includes('/server/data'),'synthetic directory required');
const configPath=join(root,'config.json');
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const number=(v:string|undefined,fallback:number,min:number,max:number)=>{const n=Number(v??fallback);assert.ok(Number.isSafeInteger(n)&&n>=min&&n<=max,'invalid numeric parameter');return n;};
if(mode==='run'){
 const soak=soakPlan(process.env,Date.now());let runMono=performance.now();
 assert.ok(!existsSync(root),'never reuse or overwrite a run');mkdirSync(root,{recursive:true,mode:0o700});assert.equal(realpathSync(root),root,'resolve parent symlinks first');
 const config={devices:number(process.env.T5_DEVICES,50,1,1000),events:number(process.env.T5_EVENTS,6000,1,60000),batch:number(process.env.T5_BATCH,200,1,200),seed:number(process.env.T5_SEED,17,1,2147483647),deadline_ms:number(process.env.T5_DEADLINE_MS,3600000,1000,172800000),maintenance:process.env.T5_MAINTENANCE==='1',backup:process.env.T5_BACKUP==='1',covering_index:process.env.T5_COVERING_INDEX==='1',ark_history_indexes:process.env.T5_ARK_HISTORY_INDEXES==='1',rollup_prefix_index:process.env.T5_ROLLUP_PREFIX_INDEX==='1',synthetic:true,started_ms:Date.now()};
 const productionScheduling=process.env.T5_DIAGNOSTIC_SCHEDULING==='production';
 if(process.env.T5_DIAGNOSTIC_SCHEDULING!==undefined){
  assert(productionScheduling&&process.platform==='linux'&&soak?.preflight&&process.env.T5_PROFILE_SQL==='1','scheduling experiment is Linux profiled preflight only');
  const stat=readFileSync('/proc/self/stat','utf8'),fields=stat.slice(stat.lastIndexOf(')')+2).split(/\s+/);
  assert.equal(Number(fields[16]),0,'match the observed production receiver nice=0');
  assert(existsSync('/usr/bin/ionice')&&existsSync('/usr/bin/nice'));
 }
 Object.assign(config,{scheduling_diagnostic:productionScheduling?'foreground_nice0_background_nice10_be7':null});
 if(soak?.fullDay||soak?.preflight)assert(config.devices===50&&config.events===6000&&config.batch===200&&config.deadline_ms===3600000&&config.maintenance&&config.backup&&config.ark_history_indexes&&config.rollup_prefix_index&&!config.covering_index,'real cadence requires fixed 50x6000 workload, 1h daily deadline and candidate indexes');
 Object.assign(config,{soak,continuous_ark:!!soak,receiver_pid:process.pid});
 writeFileSync(configPath,JSON.stringify(config,null,2),{mode:0o600});
 process.env.DEVICES_DB_PATH=join(root,'devices.db');
 const subjects=Array.from({length:config.devices},(_,i)=>'BJP003999999'+String(i+1).padStart(8,'0'));
 const identities=subjects.map((sn,i)=>({sn,account_id:'t5-synthetic-'+i,epoch:1}));
 const secret=randomBytes(32).toString('hex'),path=join(root,'analytics.db'),store=new AnalyticsStore(path);
 // Experiment on a newly-created synthetic DB only, before any writer starts.
 // No automatic index migration is added to production service startup.
 if(config.covering_index)store.db.exec('CREATE INDEX t5_experiment_cover ON analytics_rollup_fact(dimension,day,device_key,received_at_ms,id_digest,event_name,session_digest,clock_suspicious,semantic_json)');
 if(config.ark_history_indexes)installArkHistoryIndexes(store.db);
 if(config.rollup_prefix_index)installRollupPrefixIndex(store.db);
 // Match startAnalyticsServer's foreground connection; only the separate writer
 // may mutate Analytics. A generic AnalyticsStore defaults to a 64MiB writer cache.
 const genericReaderDiagnostic=process.env.T5_DIAGNOSTIC_GENERIC_READER==='1';
 if(genericReaderDiagnostic)assert(process.env.T5_PROFILE_SQL==='1'&&soak?.preflight,'generic reader allowed only in profiled diagnostic preflight, never full-day acceptance');
 else store.db.exec('PRAGMA query_only=ON; PRAGMA cache_size=-8192; PRAGMA shrink_memory');
 assert.equal(store.db.prepare('PRAGMA query_only').get()!.query_only,genericReaderDiagnostic?0:1);
 assert.equal(store.db.prepare('PRAGMA cache_size').get()!.cache_size,genericReaderDiagnostic?-65536:-8192);
 Object.assign(config,{reader_query_only:!genericReaderDiagnostic,reader_cache_kib:genericReaderDiagnostic?65536:8192,generic_reader_diagnostic:genericReaderDiagnostic});
 const earlyReclaim=process.env.T5_DIAGNOSTIC_WAL_RECLAIM==='64MiB';
 if(process.env.T5_DIAGNOSTIC_WAL_RECLAIM!==undefined)assert(earlyReclaim&&process.env.T5_PROFILE_SQL==='1'&&soak?.preflight,'WAL target experiment requires a profiled diagnostic preflight');
 Object.assign(config,{checkpoint_reclaim_target_bytes:earlyReclaim?64*1024**2:256*1024**2,writer_wal_hard_limit_bytes:256*1024**2});
 writeFileSync(configPath,JSON.stringify(config,null,2),{mode:0o600});
 const writer=new AnalyticsWriter(path),checkpointer=new AnalyticsCheckpointer(path,{runExclusive:run=>writer.withCheckpoint(run),...(earlyReclaim?{walMaxBytes:64*1024**2}:{})});
 const ark=new ArkStore(join(root,'ark.db'),undefined,()=>({enabled:true,limitBytes:8*1024**3,reserveBytes:4.5*1024**3,freeBytes:Number(statfsSync(root).bavail)*Number(statfsSync(root).bsize)}));
 // Preserve the original exception/HTTP result; isolate SQLite BUSY from other
 // causes of the deliberately generic public 503 without recording any payload.
 const acceptArk=ark.accept.bind(ark);
 ark.accept=(...args:Parameters<ArkStore['accept']>)=>{try{return acceptArk(...args);}catch(error){
  const e=error as {name?:string;code?:string;errcode?:number};
  appendFileSync(join(root,'ark-accept-errors.jsonl'),JSON.stringify({at_ms:Date.now(),name:e.name??null,code:e.code??null,sqlite_code:e.errcode??null})+'\n');throw error;
 }};
 for(const id of identities)ark.authorize(id,config.started_ms-1000);
 if(soak)ark.db.exec('PRAGMA query_only=ON'); // Only the existing Brain child accepts snapshots.
 writeFileSync(join(root,'control.json'),'{"enabled":true}',{mode:0o600});
 const deadline=Date.now()+30000;while(!writer.ready){assert.ok(Date.now()<deadline,'writer readiness timeout');await sleep(10);}checkpointer.start();
 const reader={arkDeviceKey:hash,readArkAuthorization:(sn:string)=>{const id=identities.find(i=>i.sn===sn),g=id&&ark.grant(id);return id&&g?{...id,not_before_ms:g.not_before_ms}:null;},readCredentialState:()=>({binding:null,revokedThroughSec:null}),acceptsCredential:()=>true,readiness:()=>true,readAnalyticsDeviceContext:(sn:string)=>({deviceKey:hash(sn),active:subjects.includes(sn),uploadEnabled:true,uploadHourCst:23})};
 const app=createAnalyticsApp({store,writer,reader,authSecret:secret,internalSecret:secret,controlPath:join(root,'control.json'),allowSubjects:subjects,checkpointStatus:()=>checkpointer.status()});
 if(!soak)app.route('/t5/ark',createArkRoutes({store:()=>ark,runtime:()=>({identity:(sn:string)=>identities.find(i=>i.sn===sn)??null} as any),secret:()=>secret,ceiling:()=>subjects,acceptsCredential:()=>true,isAdmin:()=>false}));
 const profile=process.env.T5_PROFILE_SQL==='1'?sqlProfiler([{name:'analytics',db:store.db},{name:'ark',db:ark.db}],sample=>appendFileSync(join(root,'sql-query-profile.jsonl'),JSON.stringify(sample)+'\n')):null;
 const server=serve({fetch:async request=>{const respond=async()=>{const start=performance.now(),receivedAt=Date.now(),response=await app.fetch(request);if(new URL(request.url).pathname==='/internal/analytics/ark-summary'){
  const ms=performance.now()-start;response.headers.set('X-T5-Service-Ms',String(ms));response.headers.set('X-T5-Receiver-Pid',String(process.pid));
  appendFileSync(join(root,'shared-reader.jsonl'),JSON.stringify({received_at_ms:receivedAt,done_at_ms:Date.now(),query_id:request.headers.get('X-T5-Query-Id'),ms,status:response.status,receiver_pid:process.pid})+'\n');
 }return response;};return profile&&new URL(request.url).pathname==='/internal/analytics/ark-summary'?profile.run(request.headers.get('X-T5-Query-Id')??'missing',respond):respond();},hostname:'127.0.0.1',port:0});if(!server.listening)await once(server,'listening');
 const tokens=await Promise.all(subjects.map(sn=>new SignJWT({kind:'p003-device'}).setSubject(sn).setProtectedHeader({alg:'HS256'}).setIssuedAt().setExpirationTime('48h').sign(new TextEncoder().encode(secret))));
 writeFileSync(join(root,'client-private.json'),JSON.stringify({url:'http://127.0.0.1:'+(server.address() as any).port,tokens}),{mode:0o600});
 const resources=createResourceRecorder(),maintenance:any[]=[],health=createLoadHealthRecorder(sample=>appendFileSync(join(root,'health.jsonl'),JSON.stringify(sample)+'\n')),children=new Set<ReturnType<typeof spawn>>();let maintaining=false,monitoring=false;let maintenanceError:unknown;
 const launch=(args:string[],name:string,env=process.env)=>new Promise<number|null>(done=>{
  const background=productionScheduling&&args.some(a=>['scripts/analytics-rollup.ts','scripts/storage-backup-job.py','scripts/storage-ark-export.py'].includes(a));
  const command=background?['/usr/bin/ionice','-c','2','-n','7','/usr/bin/nice','-n','10',...args]:args;
  const p=spawn(command[0],command.slice(1),{cwd:process.cwd(),env,stdio:['ignore','pipe','pipe']});children.add(p);
  if(productionScheduling)appendFileSync(join(root,'scheduling-launches.jsonl'),JSON.stringify({at_ms:Date.now(),pid:p.pid,name,background,requested_nice:background?10:0,requested_ioprio:background?'best-effort:7':'inherited'})+'\n');
  p.stdout.on('data',x=>appendFileSync(join(root,name+'.stdout'),x));p.stderr.on('data',x=>appendFileSync(join(root,name+'.stderr'),x));p.once('error',e=>appendFileSync(join(root,name+'.stderr'),e.message));p.once('close',code=>{children.delete(p);done(code);});
 });
 let queryService:Awaited<ReturnType<typeof startSharedQuery>>|undefined;
 if(soak)try{queryService=await startSharedQuery(root,'http://127.0.0.1:'+(server.address()as any).port,secret);}catch(error){
  writeFileSync(join(root,'FAILURE.json'),JSON.stringify({stage:'query_service_start',error:String(error)}));server.closeAllConnections();server.close();await writer.close();await checkpointer.stop();ark.close();store.close();throw error;
 }
 const queryReports:any[]=[];
 const maintain=async()=>{if(maintaining)return;maintaining=true;const start=Date.now();try{
  const queryName='mixed-query-'+start,query=soak&&arkRounds>0?queryService!.query(queryName).catch(error=>{appendFileSync(join(root,queryName+'.stderr'),String(error));return 1;}):null;
  const code=await launch([process.execPath,'--import','tsx','scripts/analytics-rollup.ts'],'maintenance-'+start,{...process.env,ANALYTICS_DB_PATH:path}),rollupDone=Date.now();
  if(query){const exit=await query;queryReports.push({start,done:Date.now(),name:queryName,exit,result:existsSync(join(root,queryName+'.json'))?JSON.parse(readFileSync(join(root,queryName+'.json'),'utf8')):null});assert.equal(exit,0,'mixed Ark reader failed');}
  const summaries=[];for await(const row of readJsonl(join(root,'maintenance-'+start+'.stdout')))summaries.push(row);assert.equal(summaries.length,1,'one maintenance report required');maintenance.push({start,done:Date.now(),rollup_done:rollupDone,code,report:summaries[0]});
 }catch(error){maintenanceError??=error;maintenance.push({start,done:Date.now(),error:String(error)});}finally{maintaining=false;}};
 let monitorError:unknown;
 const monitor=async()=>{if(monitoring)return;monitoring=true;let sample:any;try{const t=performance.now(),r=await fetch('http://127.0.0.1:'+(server.address() as any).port+'/ready',{signal:AbortSignal.timeout(5000)});sample={at:Date.now(),status:r.status,ms:performance.now()-t,...await r.json()};}catch(e){sample={at:Date.now(),error:String(e)};}finally{try{const resource={...linuxResources(root),monotonic_ms:performance.now(),at:Date.now()};appendFileSync(join(root,'resources.jsonl'),JSON.stringify(resource)+'\n');resources.record(resource);health.record(sample);}catch(e){monitorError=e;}finally{monitoring=false;}}};
 const timer=setInterval(()=>void monitor(),soak?.monitorIntervalMs??1000),maintenanceTimer=config.maintenance?setInterval(()=>void maintain(),soak?.maintenanceIntervalMs??300000):null;
 let firstMaintenance:ReturnType<typeof setTimeout>|undefined,backupTimer:ReturnType<typeof setTimeout>|undefined,backupPromise:Promise<number|null>|undefined;
 if(config.maintenance)firstMaintenance=setTimeout(()=>void maintain(),2000);
 if(config.backup&&!soak)backupTimer=setTimeout(()=>{backupPromise=launch(['python3','scripts/storage-backup-job.py','--database',path,'--root',join(root,'spool')],'backup');},5000);
 const before=loadDatabaseCounts(store.db);
 let arkRounds=0,dailyStarted=0,dailyFinished=0,firstAckMs=0,backupEligible=false,archiving=false,soakStop=false,soakError:unknown;
 const archiveReports:any[]=[];
 // Same test endpoints and existing exporter/Backup API. No production timer is installed.
 async function archiveCycle(){
  while(archiving)await sleep(20);archiving=true;try{
  const began=Date.now(),exportExit=await launch(['python3','scripts/storage-ark-export.py','--db',join(root,'ark.db'),'--root',join(root,'spool')],'ark-export-'+began);
  assert.equal(exportExit,0,'Ark export failed');
  let backupExit:number|null=null,backupReport:any=null,backupStarted:number|null=null,backupFinished:number|null=null;
  if(config.backup&&dailyStarted&&backupEligible){backupStarted=Date.now();backupExit=await launch(['python3','scripts/storage-backup-job.py','--database',path,'--root',join(root,'spool')],'backup-'+began);backupFinished=Date.now();assert.equal(backupExit,0,'daily backup job failed');backupReport=JSON.parse(readFileSync(join(root,'backup-'+began+'.stdout'),'utf8'));}
  const report={began,done:Date.now(),exportExit,backupExit,backupReport,backupStarted,backupFinished};archiveReports.push(report);appendFileSync(join(root,'archive-cycles.jsonl'),JSON.stringify(report)+'\n');
  }finally{archiving=false;}
 }
 async function archiveLoop(){
  while(!soakStop&&performance.now()-runMono<soak!.durationMs){await archiveCycle();const next=performance.now()+soak!.maintenanceIntervalMs;while(!soakStop&&performance.now()<next&&performance.now()-runMono<soak!.durationMs)await sleep(1000);}
 }
 await monitor();runMono=performance.now();
 const arkProducer=soak?startArkProducer({root,url:queryService!.arkUrl,brainPid:queryService!.brainPid,tokens,startedMs:config.started_ms,durationMs:soak.durationMs,intervalMs:soak.arkIntervalMs},n=>{arkRounds=n;}):null;
 const arkPromise=arkProducer?.promise.catch(e=>{soakError??=e;})??null;
 const archivePromise=soak?archiveLoop().catch(e=>{soakError??=e;}):null;
 try{
  if(soak)while(performance.now()-runMono<soak.dailyDelayMs){if(soakError)throw soakError;if(monitorError)throw monitorError;await sleep(1000);}
  dailyStarted=Date.now();
  let clientEnded=false;
  const clientTask=launch([process.execPath,'--import','tsx','scripts/storage-capacity-load.ts','client',root],'client').finally(()=>{clientEnded=true;});
  if(soak){
   const completedFile=join(root,'completed.jsonl');
   while(!(existsSync(completedFile)&&statSync(completedFile).size>0)&&!clientEnded){if(soakError)throw soakError;await sleep(50);}
   assert(existsSync(completedFile)&&statSync(completedFile).size>0,'daily never produced a real ACK');firstAckMs=Date.now();backupEligible=true;
   // Bind overlap to actual work, not the random phase of the five-minute timers.
   while(maintaining)await sleep(20);await Promise.all([maintain(),archiveCycle()]);
  }
  const code=await clientTask;dailyFinished=Date.now();
  if(soak){
   while(performance.now()-runMono<soak.durationMs){if(soakError)throw soakError;if(monitorError)throw monitorError;await sleep(1000);}
   soakStop=true;arkProducer?.stop();await arkPromise;await archivePromise;if(soakError)throw soakError;
   await archiveCycle();
   if(soak.fullDay){
    const drainDeadline=performance.now()+3600000;
    while(Number(ark.db.prepare('SELECT pending_records FROM ark_archive_stats').get()!.pending_records)>0||!archiveReports.some(r=>r.backupReport?.last_offsite_backup_ms)){
     assert(performance.now()<drainDeadline,'real-day NAS drain deadline exceeded; no synthetic ACK');
     if(monitorError)throw monitorError;await sleep(30000);await archiveCycle();
    }
    const completed=ark.db.prepare("SELECT SUM(record_count) n FROM ark_archive_batch WHERE state='complete'").get();assert.equal(Number(completed!.n),arkRounds*config.devices,'source receipt accounting');
   }
  }
  if(firstMaintenance)clearTimeout(firstMaintenance);if(backupTimer)clearTimeout(backupTimer);if(maintenanceTimer)clearInterval(maintenanceTimer);
  while(maintaining)await sleep(100);if(config.maintenance)await maintain();
  const backupCode=backupPromise?await backupPromise:null;
  clearInterval(timer);while(monitoring)await sleep(10);await monitor();if(monitorError)throw monitorError;
  if(!existsSync(join(root,'client-result.json'))){writeFileSync(join(root,'FAILURE.json'),JSON.stringify({stage:'client',exit:code,stderr_file:'client.stderr'}));throw new Error('client failed before result; inspect client.stderr');}
  const client=JSON.parse(readFileSync(join(root,'client-result.json'),'utf8'));assert.equal(client.evidence_version,3,'streamed client evidence required');
  const accounting=createStreamingAccounting({...config,prefix:client.prefix});
  for await(const b of readJsonl(join(root,'completed.jsonl')))accounting.record(b);
  const integrity=accounting.report(store.db,before,client.failures);
  const requests=await analyseRequests(join(root,'requests.jsonl'),join(root,'request-analysis.db'),config);
  const evidenceConsistent=requests.attempts===client.attempts&&requests.successes===client.completed_batches&&accounting.totals().batches===client.completed_batches;
  const arkRows=identities.map((id,i)=>{const current=ark.current(id);return {actor:i,correct:current?.snapshot.wallets.family_coin===(soak?arkRounds-1+i:100+i)&&current?.snapshot.inventory['M-CARD-001']===i%4&&(!soak||current?.snapshot.wallets.stardust===null),source_mode:current?.snapshot.source_mode};});
  const dirty=Number(store.db.prepare('SELECT count(*) n FROM analytics_dirty_day').get()!.n);
  const result={stage:'T5_INCREMENTAL_LOAD_NOT_FULL_ACCEPTANCE',evidence_version:3,synthetic:true,config,node:process.version,platform:process.platform,client_exit:code,integrity,ark:arkRows,maintenance,maintenance_error:maintenanceError?String(maintenanceError):null,backup_exit:backupCode,checkpoint:checkpointer.status(),dirty_days:dirty,acks:requests,evidence_consistent:evidenceConsistent,health:health.recent(),health_summary:health.summary(),resources:resources.summary(86400000),duration_ms:client.duration_ms};
  writeFileSync(join(root,'RESULT.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({root,complete:integrity.complete,acks:result.acks,ark_correct:arkRows.filter(x=>x.correct).length,seconds:client.duration_ms/1000}));
  if(soak){
   let firstRequest=Infinity,lastRequest=0;for await(const request of readJsonl(join(root,'requests.jsonl'))){assert(Number.isSafeInteger(request.sent_at_ms)&&Number.isSafeInteger(request.finished_at_ms));firstRequest=Math.min(firstRequest,request.sent_at_ms);lastRequest=Math.max(lastRequest,request.finished_at_ms);}
   const querySamples:any[]=[];for(const report of queryReports)if(existsSync(join(root,report.name+'.jsonl')))for await(const row of readJsonl(join(root,report.name+'.jsonl'))){assert(querySamples.length<25000,'bounded query evidence');querySamples.push(row);}
   const queryTimes=querySamples.map(x=>x.ms).sort((a,b)=>a-b),queryP99=queryTimes.length?queryTimes[Math.min(queryTimes.length-1,Math.floor(queryTimes.length*.99))]:null;
   const querySpan=queryReports.length>1?queryReports.at(-1).start-queryReports[0].start:0,maxQueryGap=queryReports.slice(1).reduce((m,r,i)=>Math.max(m,r.start-queryReports[i].start),0);
   const receiverRows:any[]=[];if(existsSync(join(root,'shared-reader.jsonl')))for await(const row of readJsonl(join(root,'shared-reader.jsonl')))receiverRows.push(row);
   const queryOverlap=receiverRows.some(q=>maintenance.some(m=>m.report?.work_started_at_ms<=q.done_at_ms&&m.report?.work_finished_at_ms>=q.received_at_ms));
   const queryEvidence={cycles:queryReports.length,failed_cycles:queryReports.filter(r=>r.exit!==0).length,samples:querySamples.length,p99_ms:queryP99,span_ms:querySpan,max_cycle_gap_ms:maxQueryGap,invalid:querySamples.filter(x=>!x.correct||x.status!==200||!x.body_complete||x.receiver_pid!==process.pid).length,receiver_requests:receiverRows.length,query_overlapped_maintenance:queryOverlap,scope:'persistent ArkRuntime -> SAME Analytics receiver HTTP handling uploads; changing per-device assets'};
   writeFileSync(join(root,'SOAK-QUERY-RESULT.json'),JSON.stringify(queryEvidence,null,2));
   assert(queryEvidence.failed_cycles===0,'all query cycles including failed children must be accounted');
   assert(queryEvidence.receiver_requests===queryEvidence.samples,'every measured query must hit the actual ingestion receiver');
   if(soak.fullDay)assert(queryEvidence.samples>=10000&&queryEvidence.invalid===0&&queryP99!==null&&queryP99<=100&&querySpan>=86400000-600000&&maxQueryGap<=600000,'full-day Ark query coverage/latency required');
   else if(soak.preflight)assert(queryEvidence.samples>=150&&queryEvidence.invalid===0&&queryP99!==null&&queryP99<=100&&querySpan>=540000&&maxQueryGap<=600000,'real-cadence preflight query gate');
   else assert(queryEvidence.samples>0&&queryEvidence.invalid===0,'smoke requires actual Ark queries');
   const evidence={full_day_requested:soak.fullDay,elapsed_ms:performance.now()-runMono,plan:soak,daily_started_ms:dailyStarted,daily_finished_ms:dailyFinished,first_ack_ms:firstAckMs,first_request_ms:firstRequest,last_request_ms:lastRequest,ark_rounds:arkRounds,ark_accepted:arkRounds*config.devices,archive_cycles:archiveReports,archive_stats:ark.db.prepare('SELECT * FROM ark_archive_stats').get(),maintenance_overlapped_daily:maintenance.some(m=>m.start<=lastRequest&&m.rollup_done>=firstRequest),backup_overlapped_daily:archiveReports.some(m=>m.backupReport?.state==='published'&&m.backupStarted<=lastRequest&&m.backupFinished>=firstRequest),resource_gate:result.resources.local_resource_gate,full_t5_pass:false};
   writeFileSync(join(root,'SOAK-RESULT.json'),JSON.stringify(evidence,null,2));assert(arkRounds>0);
   if(soak.fullDay){assert(evidence.elapsed_ms>=86400000);assert(result.resources.local_resource_gate,'real-day resource gate failed');}
   if(soak.fullDay||soak.preflight)assert(evidence.maintenance_overlapped_daily&&evidence.backup_overlapped_daily&&queryOverlap,'actual mixed overlap required');
  }
  assert.equal(code,0);assert.ok(integrity.complete);assert.ok(arkRows.every(x=>x.correct));assert.ok(evidenceConsistent&&requests.all_actors_finished,'request evidence completeness');assert.ok(requests.successes&&result.acks.p95!<=500&&result.acks.p99!<=2000,'ACK latency gate');
  if(config.maintenance){assert.equal(maintenanceError,undefined,'maintenance evidence failed');assert.ok(maintenance.every(r=>r.code===0&&!r.report?.rollup_error&&!r.report?.prune_error),'maintenance process failed');assert.equal(dirty,0);}if(config.backup&&!soak)assert.equal(backupCode,0,'backup must really run');
 }catch(error){writeFileSync(join(root,'FAILURE.json'),JSON.stringify({stage:'run',error:String(error),synthetic:true}));throw error;}finally{
  clearInterval(timer);if(maintenanceTimer)clearInterval(maintenanceTimer);if(firstMaintenance)clearTimeout(firstMaintenance);if(backupTimer)clearTimeout(backupTimer);
  soakStop=true;arkProducer?.stop();await arkPromise;await archivePromise;
  while(monitoring)await sleep(10);
  try{await queryService?.stop();}catch(error){writeFileSync(join(root,'QUERY-STOP-FAILURE.json'),JSON.stringify({error:String(error)}));process.exitCode=1;}
  for(const p of children)p.kill('SIGTERM');server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await writer.close();await checkpointer.stop();ark.close();store.close();
 }
}else{
 const config=JSON.parse(readFileSync(configPath,'utf8')),privateConfig=JSON.parse(readFileSync(join(root,'client-private.json'),'utf8'));assert.match(privateConfig.url,/^http:\/\/127\.0\.0\.1:\d+$/);
 const started=Date.now(),prefix='load-t5-'+config.seed+'-'+started,failures:any[]=[],arkRequests:any[]=[];let attempts=0,completed=0;
 for(const name of ['requests.jsonl','completed.jsonl'])writeFileSync(join(root,name),'',{flag:'wx',mode:0o600});
 let seed=config.seed;const random=()=>{seed=(seed*48271)%2147483647;return seed/2147483647;};
 const catalog=JSON.parse(readFileSync('src/analytics/event-property-schema-v1.json','utf8')).events;
 const sample=JSON.parse(readFileSync(new URL('../../../docs/ark-brain-20261031/snapshot-v1.example.json',import.meta.url),'utf8'));
 const progress=setInterval(()=>console.log(JSON.stringify({progress:true,at:Date.now(),completed_batches:completed,attempts})),20000);
 const actors=await Promise.allSettled(privateConfig.tokens.map(async(token:string,actor:number)=>{
  const stamp=Date.now(),snapshot={...sample,snapshot_id:prefix+'-ark-'+actor,boot_id:prefix,boot_started_at_ms:stamp-1,captured_at_ms:stamp,sequence:1,logical_day:new Date(stamp+8*3600000).toISOString().slice(0,10),wallets:{family_coin:100+actor,stardust:actor+1},inventory:{'M-CARD-001':actor%4}};
  if(!config.continuous_ark){const ar=await fetch(privateConfig.url+'/t5/ark/state',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(snapshot),signal:AbortSignal.timeout(20000)});const aj=await ar.json();arkRequests.push({actor,status:ar.status,result:aj});assert.equal(ar.status,200);assert.equal(aj.status,'accepted');}
  for(let offset=0;offset<config.events;offset+=config.batch){
   const events=Array.from({length:Math.min(config.batch,config.events-offset)},(_,i)=>{const n=offset+i,spec=catalog[n%catalog.length];return {schema_version:1,client_event_id:prefix+'-'+actor+'-'+n,event_name:spec.eventName,occurred_at_ms:config.continuous_ark?config.started_ms:started,session_id:hash(prefix+'-'+actor).slice(0,32),sequence:n,priority:'normal',context:{},properties:structuredClone(spec.sample)};});
   const ids=events.map(e=>e.client_event_id),body=JSON.stringify({schema_version:1,batch_id:prefix+'-'+actor+'-'+offset,sent_at_ms:started,client:{component:'synthetic-t5'},events});
   const batchStarted=performance.now();
   for(let attempt=0;;attempt++){
    assert.ok(Date.now()-started<config.deadline_ms,'load deadline exceeded');
    const start=performance.now(),sentAt=Date.now();let status=0,retry=0,j:any;
    try{const r=await fetch(privateConfig.url+'/v1/device/analytics/events:batch',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','X-Request-Id':prefix+'-'+actor+'-'+offset+'-'+attempt},body,signal:AbortSignal.timeout(20000)});status=r.status;retry=Number(r.headers.get('retry-after')??0)*1000;j=await r.json();}catch(e){j={error_code:'CLIENT_TRANSPORT',error:String(e)};retry=1000;}
    const finished=performance.now();
    const record={actor,offset,attempt,status,sent_at_ms:sentAt,finished_at_ms:Date.now(),ms:finished-start,batch_elapsed_ms:finished-batchStarted,retry_ms:retry,error:j.error_code??null};attempts++;appendFileSync(join(root,'requests.jsonl'),JSON.stringify(record)+'\n');
    if(status===200){assert.ok(j.ok&&j.rejected.length===0);assert.deepEqual([...j.accepted_event_ids,...j.duplicated_event_ids].sort(),[...ids].sort());appendFileSync(join(root,'completed.jsonl'),JSON.stringify({actor,offset,ack:j})+'\n');completed++;break;}
    assert.ok(status===0||status===429||status===503,'terminal HTTP '+status);assert.ok(Number.isFinite(retry)&&retry>=0&&retry<=3600000,'invalid Retry-After');await sleep(Math.max(100,retry)+Math.floor(random()*1000));
   }
   await sleep(2000);
  }
 }));
 clearInterval(progress);actors.forEach((r,i)=>{if(r.status==='rejected')failures.push({actor:i,error:String(r.reason).slice(0,500)});});
 writeFileSync(join(root,'client-result.json'),JSON.stringify({evidence_version:3,prefix,completed_batches:completed,attempts,completed_file:'completed.jsonl',requests_file:'requests.jsonl',arkRequests,failures,duration_ms:Date.now()-started}));
 console.log(JSON.stringify({completed,attempts,failures}));if(failures.length)process.exitCode=1;
}
