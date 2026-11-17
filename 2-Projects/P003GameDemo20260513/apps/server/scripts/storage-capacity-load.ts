/** T5 synthetic loopback harness; no production identities, credentials or endpoints. */
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,appendFileSync,readFileSync,existsSync,realpathSync,statfsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash,randomBytes} from 'node:crypto';
import {serve} from '@hono/node-server';
import {SignJWT} from 'jose';
import {AnalyticsStore} from '../src/analytics/store.js';
import {AnalyticsWriter} from '../src/analytics/writer.js';
import {AnalyticsCheckpointer} from '../src/analytics/checkpointer.js';
import {createAnalyticsApp} from '../src/analytics/index.js';
import {ArkStore} from '../src/ark/store.js';
import {createArkRoutes} from '../src/ark/routes.js';
import {createLoadAccounting,loadDatabaseCounts} from '../deploy/analytics-smoke-and-load.mjs';
import {createLoadHealthRecorder} from './storage-load-health.js';

const mode=process.argv[2],root=resolve(process.argv[3]??'');
assert.ok(['run','client'].includes(mode),'run|client');
assert.ok(root.includes('p003-t5-')&&!root.includes('/server/data'),'synthetic directory required');
const configPath=join(root,'config.json');
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const percentile=(a:number[],p:number)=>{const sorted=[...a].sort((a,b)=>a-b);return sorted.length?sorted[Math.min(sorted.length-1,Math.floor(sorted.length*p))]:null;};
const number=(v:string|undefined,fallback:number,min:number,max:number)=>{const n=Number(v??fallback);assert.ok(Number.isSafeInteger(n)&&n>=min&&n<=max,'invalid numeric parameter');return n;};
if(mode==='run'){
 assert.ok(!existsSync(root),'never reuse or overwrite a run');mkdirSync(root,{recursive:true,mode:0o700});assert.equal(realpathSync(root),root,'resolve parent symlinks first');
 const config={devices:number(process.env.T5_DEVICES,50,1,1000),events:number(process.env.T5_EVENTS,6000,1,60000),batch:number(process.env.T5_BATCH,200,1,200),seed:number(process.env.T5_SEED,17,1,2147483647),deadline_ms:number(process.env.T5_DEADLINE_MS,3600000,1000,172800000),maintenance:process.env.T5_MAINTENANCE==='1',backup:process.env.T5_BACKUP==='1',covering_index:process.env.T5_COVERING_INDEX==='1',synthetic:true,started_ms:Date.now()};
 writeFileSync(configPath,JSON.stringify(config,null,2),{mode:0o600});
 process.env.DEVICES_DB_PATH=join(root,'devices.db');
 const subjects=Array.from({length:config.devices},(_,i)=>'BJP003999999'+String(i+1).padStart(8,'0'));
 const identities=subjects.map((sn,i)=>({sn,account_id:'t5-synthetic-'+i,epoch:1}));
 const secret=randomBytes(32).toString('hex'),path=join(root,'analytics.db'),store=new AnalyticsStore(path);
 // Experiment on a newly-created synthetic DB only, before any writer starts.
 // No automatic index migration is added to production service startup.
 if(config.covering_index)store.db.exec('CREATE INDEX t5_experiment_cover ON analytics_rollup_fact(dimension,day,device_key,received_at_ms,id_digest,event_name,session_digest,clock_suspicious,semantic_json)');
 const writer=new AnalyticsWriter(path),checkpointer=new AnalyticsCheckpointer(path);
 const ark=new ArkStore(join(root,'ark.db'),undefined,()=>({enabled:true,limitBytes:8*1024**3,reserveBytes:4.5*1024**3,freeBytes:Number(statfsSync(root).bavail)*Number(statfsSync(root).bsize)}));
 for(const id of identities)ark.authorize(id,config.started_ms-1000);
 writeFileSync(join(root,'control.json'),'{"enabled":true}',{mode:0o600});
 const deadline=Date.now()+30000;while(!writer.ready){assert.ok(Date.now()<deadline,'writer readiness timeout');await sleep(10);}checkpointer.start();
 const reader={readCredentialState:()=>({binding:null,revokedThroughSec:null}),acceptsCredential:()=>true,readiness:()=>true,readAnalyticsDeviceContext:(sn:string)=>({deviceKey:hash(sn),active:subjects.includes(sn),uploadEnabled:true,uploadHourCst:23})};
 const app=createAnalyticsApp({store,writer,reader,authSecret:secret,internalSecret:secret,controlPath:join(root,'control.json'),allowSubjects:subjects,checkpointStatus:()=>checkpointer.status()});
 app.route('/t5/ark',createArkRoutes({store:()=>ark,runtime:()=>({identity:(sn:string)=>identities.find(i=>i.sn===sn)??null} as any),secret:()=>secret,ceiling:()=>subjects,acceptsCredential:()=>true,isAdmin:()=>false}));
 const server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:0});if(!server.listening)await once(server,'listening');
 const tokens=await Promise.all(subjects.map(sn=>new SignJWT({kind:'p003-device'}).setSubject(sn).setProtectedHeader({alg:'HS256'}).setIssuedAt().setExpirationTime('48h').sign(new TextEncoder().encode(secret))));
 writeFileSync(join(root,'client-private.json'),JSON.stringify({url:'http://127.0.0.1:'+(server.address() as any).port,tokens}),{mode:0o600});
 const maintenance:any[]=[],health=createLoadHealthRecorder(sample=>appendFileSync(join(root,'health.jsonl'),JSON.stringify(sample)+'\n')),children=new Set<ReturnType<typeof spawn>>();let maintaining=false,monitoring=false;
 const launch=(args:string[],name:string,env=process.env)=>new Promise<number|null>(done=>{const p=spawn(args[0],args.slice(1),{cwd:process.cwd(),env,stdio:['ignore','pipe','pipe']});children.add(p);p.stdout.on('data',x=>appendFileSync(join(root,name+'.stdout'),x));p.stderr.on('data',x=>appendFileSync(join(root,name+'.stderr'),x));p.once('error',e=>appendFileSync(join(root,name+'.stderr'),e.message));p.once('close',code=>{children.delete(p);done(code);});});
 const maintain=async()=>{if(maintaining)return;maintaining=true;const start=Date.now();try{const code=await launch([process.execPath,'--import','tsx','scripts/analytics-rollup.ts'],'maintenance-'+start,{...process.env,ANALYTICS_DB_PATH:path});maintenance.push({start,done:Date.now(),code});}finally{maintaining=false;}};
 let monitorError:unknown;
 const monitor=async()=>{if(monitoring)return;monitoring=true;let sample:any;try{const t=performance.now(),r=await fetch('http://127.0.0.1:'+(server.address() as any).port+'/ready',{signal:AbortSignal.timeout(5000)});sample={at:Date.now(),status:r.status,ms:performance.now()-t,...await r.json()};}catch(e){sample={at:Date.now(),error:String(e)};}finally{try{health.record(sample);}catch(e){monitorError=e;}finally{monitoring=false;}}};
 const timer=setInterval(()=>void monitor(),1000),maintenanceTimer=config.maintenance?setInterval(()=>void maintain(),300000):null;
 let firstMaintenance:ReturnType<typeof setTimeout>|undefined,backupTimer:ReturnType<typeof setTimeout>|undefined,backupPromise:Promise<number|null>|undefined;
 if(config.maintenance)firstMaintenance=setTimeout(()=>void maintain(),2000);
 if(config.backup)backupTimer=setTimeout(()=>{backupPromise=launch(['python3','scripts/storage-backup-job.py','--database',path,'--root',join(root,'spool')],'backup');},5000);
 const before=loadDatabaseCounts(store.db);
 try{
  const code=await launch([process.execPath,'--import','tsx','scripts/storage-capacity-load.ts','client',root],'client');
  if(firstMaintenance)clearTimeout(firstMaintenance);if(backupTimer)clearTimeout(backupTimer);if(maintenanceTimer)clearInterval(maintenanceTimer);
  while(maintaining)await sleep(100);if(config.maintenance)await maintain();
  const backupCode=backupPromise?await backupPromise:null;
  clearInterval(timer);while(monitoring)await sleep(10);if(monitorError)throw monitorError;
  if(!existsSync(join(root,'client-result.json'))){writeFileSync(join(root,'FAILURE.json'),JSON.stringify({stage:'client',exit:code,stderr_file:'client.stderr'}));throw new Error('client failed before result; inspect client.stderr');}
  const client=JSON.parse(readFileSync(join(root,'client-result.json'),'utf8')),accounting=createLoadAccounting({expectedEvents:config.devices*config.events,expectedBatches:config.devices*Math.ceil(config.events/config.batch)});
  for(const b of client.completed)accounting.record(b.ack,b.ids);
  const integrity=accounting.report(store.db,client.prefix,before,client.failures),success=client.requests.filter((x:any)=>x.status===200).map((x:any)=>x.ms);
  const arkRows=identities.map((id,i)=>{const current=ark.current(id);return {actor:i,correct:current?.snapshot.wallets.family_coin===100+i&&current?.snapshot.inventory['M-CARD-001']===i%4,source_mode:current?.snapshot.source_mode};});
  const dirty=Number(store.db.prepare('SELECT count(*) n FROM analytics_dirty_day').get()!.n);
  const result={stage:'T5_INCREMENTAL_LOAD_NOT_FULL_ACCEPTANCE',evidence_version:2,synthetic:true,config,node:process.version,platform:process.platform,client_exit:code,integrity,ark:arkRows,maintenance,backup_exit:backupCode,checkpoint:checkpointer.status(),dirty_days:dirty,acks:{p95:percentile(success,.95),p99:percentile(success,.99),attempts:client.requests.length,statuses:client.requests.reduce((a:any,x:any)=>(a[x.status]=(a[x.status]??0)+1,a),{})},health:health.recent(),health_summary:health.summary(),duration_ms:client.duration_ms};
  writeFileSync(join(root,'RESULT.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({root,complete:integrity.complete,acks:result.acks,ark_correct:arkRows.filter(x=>x.correct).length,seconds:client.duration_ms/1000}));
  assert.equal(code,0);assert.ok(integrity.complete);assert.ok(arkRows.every(x=>x.correct));assert.ok(success.length&&result.acks.p95!<=500&&result.acks.p99!<=2000,'ACK latency gate');
  if(config.maintenance)assert.equal(dirty,0);if(config.backup)assert.equal(backupCode,0,'backup must really run');
 }finally{
  clearInterval(timer);if(maintenanceTimer)clearInterval(maintenanceTimer);if(firstMaintenance)clearTimeout(firstMaintenance);if(backupTimer)clearTimeout(backupTimer);
  while(monitoring)await sleep(10);
  for(const p of children)p.kill('SIGTERM');server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await writer.close();await checkpointer.stop();ark.close();store.close();
 }
}else{
 const config=JSON.parse(readFileSync(configPath,'utf8')),privateConfig=JSON.parse(readFileSync(join(root,'client-private.json'),'utf8'));assert.match(privateConfig.url,/^http:\/\/127\.0\.0\.1:\d+$/);
 const started=Date.now(),prefix='load-t5-'+config.seed+'-'+started,requests:any[]=[],completed:any[]=[],failures:any[]=[],arkRequests:any[]=[];
 let seed=config.seed;const random=()=>{seed=(seed*48271)%2147483647;return seed/2147483647;};
 const catalog=JSON.parse(readFileSync('src/analytics/event-property-schema-v1.json','utf8')).events;
 const sample=JSON.parse(readFileSync(new URL('../../../docs/ark-brain-20261031/snapshot-v1.example.json',import.meta.url),'utf8'));
 const progress=setInterval(()=>console.log(JSON.stringify({progress:true,at:Date.now(),completed_batches:completed.length,attempts:requests.length})),20000);
 const actors=await Promise.allSettled(privateConfig.tokens.map(async(token:string,actor:number)=>{
  const stamp=Date.now(),snapshot={...sample,snapshot_id:prefix+'-ark-'+actor,boot_id:prefix,boot_started_at_ms:stamp-1,captured_at_ms:stamp,sequence:1,logical_day:new Date(stamp+8*3600000).toISOString().slice(0,10),wallets:{family_coin:100+actor,stardust:actor+1},inventory:{'M-CARD-001':actor%4}};
  const ar=await fetch(privateConfig.url+'/t5/ark/state',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(snapshot),signal:AbortSignal.timeout(20000)});const aj=await ar.json();arkRequests.push({actor,status:ar.status,result:aj});assert.equal(ar.status,200);assert.equal(aj.status,'accepted');
  for(let offset=0;offset<config.events;offset+=config.batch){
   const events=Array.from({length:Math.min(config.batch,config.events-offset)},(_,i)=>{const n=offset+i,spec=catalog[n%catalog.length];return {schema_version:1,client_event_id:prefix+'-'+actor+'-'+n,event_name:spec.eventName,occurred_at_ms:started,session_id:hash(prefix+'-'+actor).slice(0,32),sequence:n,priority:'normal',context:{},properties:structuredClone(spec.sample)};});
   const ids=events.map(e=>e.client_event_id),body=JSON.stringify({schema_version:1,batch_id:prefix+'-'+actor+'-'+offset,sent_at_ms:started,client:{component:'synthetic-t5'},events});
   for(let attempt=0;;attempt++){
    assert.ok(Date.now()-started<config.deadline_ms,'load deadline exceeded');
    const start=performance.now();let status=0,retry=0,j:any;
    try{const r=await fetch(privateConfig.url+'/v1/device/analytics/events:batch',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','X-Request-Id':prefix+'-'+actor+'-'+offset+'-'+attempt},body,signal:AbortSignal.timeout(20000)});status=r.status;retry=Number(r.headers.get('retry-after')??0)*1000;j=await r.json();}catch(e){j={error_code:'CLIENT_TRANSPORT',error:String(e)};retry=1000;}
    const record={actor,offset,attempt,status,ms:performance.now()-start,retry_ms:retry,error:j.error_code??null};requests.push(record);appendFileSync(join(root,'requests.jsonl'),JSON.stringify(record)+'\n');
    if(status===200){assert.ok(j.ok&&j.rejected.length===0);assert.deepEqual([...j.accepted_event_ids,...j.duplicated_event_ids].sort(),[...ids].sort());completed.push({ids,ack:j});break;}
    assert.ok(status===0||status===429||status===503,'terminal HTTP '+status);assert.ok(Number.isFinite(retry)&&retry>=0&&retry<=3600000,'invalid Retry-After');await sleep(Math.max(100,retry)+Math.floor(random()*1000));
   }
   await sleep(2000);
  }
 }));
 clearInterval(progress);actors.forEach((r,i)=>{if(r.status==='rejected')failures.push({actor:i,error:String(r.reason)});});
 writeFileSync(join(root,'client-result.json'),JSON.stringify({prefix,completed,requests,arkRequests,failures,duration_ms:Date.now()-started}));
 console.log(JSON.stringify({completed:completed.length,attempts:requests.length,failures}));if(failures.length)process.exitCode=1;
}
