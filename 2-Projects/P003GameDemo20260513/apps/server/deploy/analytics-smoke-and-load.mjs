// Real HTTP/nginx acceptance against the dedicated fake-key staging instance only.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import { SignJWT } from 'jose';
import { DatabaseSync } from 'node:sqlite';
export function loadDatabaseCounts(db){return {events:Number(db.prepare('SELECT count(*) n FROM analytics_event').get().n),seen:Number(db.prepare('SELECT count(*) n FROM analytics_event_seen').get().n),batches:Number(db.prepare('SELECT count(*) n FROM analytics_batch').get().n)};}
export function createLoadAccounting({expectedEvents=84000,expectedBatches=420}={}){
 assert.ok(Number.isSafeInteger(expectedEvents)&&expectedEvents>0&&Number.isSafeInteger(expectedBatches)&&expectedBatches>0,'invalid load target');
 const acknowledged=new Set();let accepted=0,duplicated=0,completed=0;
 const totals=()=>({batches:completed,events_accepted:accepted,events_duplicated:duplicated,events_acknowledged:accepted+duplicated,unique_acknowledged_events:acknowledged.size});
 return {totals,record(ack,expected){
  assert.equal(ack.ok,true);assert.equal(ack.rejected.length,0,'load ACK contains rejected events');
  const ids=[...ack.accepted_event_ids,...ack.duplicated_event_ids];
  assert.deepEqual([...ids].sort(),[...new Set(expected)].sort(),'load ACK partition must match the submitted IDs exactly');
  assert.equal(new Set(ids).size,ids.length,'load ACK partition must be disjoint');
  assert.ok(ids.every(id=>!acknowledged.has(id)),'load batch already acknowledged');
  for(const id of ids)acknowledged.add(id);
  accepted+=ack.accepted_event_ids.length;duplicated+=ack.duplicated_event_ids.length;completed++;
 },report(db,prefix,before,actorFailures){
  assert.match(prefix,/^load-[A-Za-z0-9-]+$/,'invalid load prefix');
  db.exec('BEGIN');
  try{
   const after=loadDatabaseCounts(db),delta=Object.fromEntries(Object.keys(after).map(key=>[key,after[key]-before[key]]));
   const seen=db.prepare('SELECT 1 present FROM analytics_event_seen WHERE device_key=? AND id_digest=?');
   const unique=new Set();let rows=0,matched=0,seenMatches=0;
   for(const row of db.prepare('SELECT device_key,client_event_id FROM analytics_event WHERE client_event_id GLOB ?').iterate(prefix+'-*')){
    rows++;unique.add(row.client_event_id);if(acknowledged.has(row.client_event_id))matched++;
    if(seen.get(row.device_key,createHash('sha256').update(row.client_event_id).digest('hex')))seenMatches++;
   }
   const exact=rows===expectedEvents&&unique.size===expectedEvents&&matched===expectedEvents&&seenMatches===expectedEvents&&delta.events===expectedEvents&&delta.seen===expectedEvents;
   return {...totals(),expected_events:expectedEvents,expected_batches:expectedBatches,counts:after,database_before:before,database_delta:delta,database_run_events:rows,database_unique_event_ids:unique.size,database_acknowledged_matches:matched,database_seen_matches:seenMatches,database_integrity:exact,
    complete:accepted+duplicated===expectedEvents&&acknowledged.size===expectedEvents&&completed===expectedBatches&&actorFailures.length===0&&exact};
  }finally{db.exec('COMMIT');}
 }};
}
async function main(){
const root=process.env.ANALYTICS_STAGE_ROOT||'/opt/p003/analytics-staging-20261013', server=root+'/server';
assert.match(root,/^\/opt\/p003\/analytics-(?:staging-20261013|control-staging-20261031)$/);
assert.equal(resolve(process.cwd()),server,'staging cwd required');
assert.equal(process.env.ANALYTICS_DB_PATH,server+'/data/analytics.db','isolated database required');
const actorCount=Number(process.env.ANALYTICS_TEST_DEVICES||14);assert.ok(actorCount===14||actorCount===20);assert.equal(process.env.ANALYTICS_SN_ALLOW.split(',').length,actorCount);
const out=root+'/evidence';mkdirSync(out,{recursive:true,mode:0o700});
const subjects=process.env.ANALYTICS_SN_ALLOW.split(','),mode=process.argv[2]||'smoke';
const catalog=JSON.parse(readFileSync('src/analytics/event-property-schema-v1.json','utf8')).events;
const proxy='http://127.0.0.1:13306', gateway='http://127.0.0.1:3005';
const tokens=await Promise.all(subjects.map(sn=>sign(sn)));
const httpTimings=[];
async function sign(sn){return new SignJWT({kind:'p003-device'}).setSubject(sn).setProtectedHeader({alg:'HS256'}).setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(process.env.AUTH_JWT_SECRET));}
function event(id,index=0,time=Date.now()) { const spec=catalog[index%catalog.length];return {schema_version:1,client_event_id:id,event_name:spec.eventName,occurred_at_ms:time,session_id:'synthetic-session-'+index%14,sequence:index,priority:'normal',context:{},properties:structuredClone(spec.sample)}; }
function batch(events,id='smoke'){return {schema_version:1,batch_id:'batch-'+id,sent_at_ms:Date.now(),client:{product:'p003',component:'synthetic_staging',protocol_version:'analytics-v1',content_version:'synthetic'},events};}
async function post(body,token=tokens[0],id='stage-'+Date.now()){
 const sent_ms=Date.now(),began=performance.now(); const response=await fetch(proxy+'/v1/device/analytics/events:batch',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token,'X-Request-Id':id},body:typeof body==='string'?body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
 const text=await response.text();let data;try{data=JSON.parse(text);}catch{throw Error('non-JSON proxy response status '+response.status);}
 const ms=performance.now()-began;
 if(mode==='load')httpTimings.push({request_digest:createHash('sha256').update(id).digest('hex'),sent_ms,done_ms:Date.now(),status:response.status});
 return {status:response.status,retry:response.headers.get('Retry-After'),data,ms};
}
function checkAck(r,expected){assert.equal(r.status,200);assert.equal(r.data.ok,true);const a=r.data.accepted_event_ids,d=r.data.duplicated_event_ids,x=r.data.rejected.map(i=>i.client_event_id);assert.deepEqual([...a,...d,...x].sort(),[...new Set(expected)].sort());assert.equal(new Set([...a,...d,...x]).size,a.length+d.length+x.length);assert.equal(r.data.retry_after_ms,0);}
function gate(enabled){const path=process.env.ANALYTICS_CONTROL_PATH,temp=path+'.acceptance.tmp';writeFileSync(temp,JSON.stringify({enabled}),{mode:0o600});renameSync(temp,path);}
function counts(){const db=new DatabaseSync(process.env.ANALYTICS_DB_PATH,{readOnly:true});try{return loadDatabaseCounts(db);}finally{db.close();}}
async function login(role){const username=process.env[role==='admin'?'STUDIO_USER':role==='editor'?'STUDIO_EDITOR_USERS':'STUDIO_GUEST_USER'],password=process.env[role==='admin'?'STUDIO_PASS':role==='editor'?'STUDIO_EDITOR_PASS':'STUDIO_GUEST_PASS'];const response=await fetch(gateway+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});assert.equal(response.status,200);const j=await response.json();assert.equal(j.role,role);return j;}
async function smoke(){
 const cases=[],stamp=Date.now(),prefix='smoke-'+stamp;
 const bad=await post(batch([event(prefix+'-bad')]),'invalid');assert.equal(bad.status,401);cases.push('invalid credential401');
 gate(false);try{const r=await post(batch([event(prefix+'-closed')]));assert.equal(r.status,503);assert.equal(r.retry,'900');assert.equal(r.data.error_code,'ANALYTICS_UPLOAD_DISABLED');}finally{gate(true);}cases.push('hot gate503/900');
 assert.equal((await post(batch([event(prefix+'-nongray')]),await sign('BJP00326101399999999'))).status,403);cases.push('independent allowlist403');
 assert.equal((await post('{bad-json')).status,400);cases.push('JSON400');
 for(const size of [2*1024*1024+1,3*1024*1024+1]){const r=await post('x'.repeat(size));assert.equal(r.status,413);}cases.push('application2MiB and nginx3MiB JSON413');
 const sampleEvents=catalog.map((_,i)=>event(prefix+'-catalog-'+i,i,stamp));let r=await post(batch(sampleEvents,prefix+'-catalog'));checkAck(r,sampleEvents.map(e=>e.client_event_id));assert.equal(r.data.accepted_event_ids.length,57);cases.push('57 source-derived event samples');
 const e=event(prefix+'-duplicate',0,stamp);r=await post(batch([e]));checkAck(r,[e.client_event_id]);assert.equal(r.data.accepted_event_ids.length,1);const before=counts();
 for(let i=0;i<3;i++){r=await post(batch([e],'new-batch-'+i));checkAck(r,[e.client_event_id]);assert.deepEqual(r.data.duplicated_event_ids,[e.client_event_id]);}const after=counts();assert.equal(before.events,after.events);assert.equal(before.seen,after.seen);cases.push('three replays with changed batch keep one row');
 const same=event(prefix+'-conflict',0,stamp),changed={...same,sequence:999};r=await post(batch([same,changed]));checkAck(r,[same.client_event_id]);assert.equal(r.data.rejected[0].reason,'client_event_id_conflict');cases.push('same-ID conflict settles once');
 const good=event(prefix+'-good',0,stamp),unknown={...event(prefix+'-unknown',0,stamp),event_name:'unregistered.event'};r=await post(batch([good,unknown]));checkAck(r,[good.client_event_id,unknown.client_event_id]);assert.deepEqual(r.data.accepted_event_ids,[good.client_event_id]);assert.equal(r.data.rejected[0].reason,'event_not_allowed');cases.push('mixed partial acceptance');
 const deep={...event(prefix+'-deep',0,stamp),properties:{extra:'DEPTH_REPLACE'}};const mixed=JSON.stringify(batch([event(prefix+'-deep-good',0,stamp),deep])).replace('"DEPTH_REPLACE"','['.repeat(4000)+'0'+']'.repeat(4000));r=await post(mixed);checkAck(r,[prefix+'-deep-good',prefix+'-deep']);assert.deepEqual(r.data.accepted_event_ids,[prefix+'-deep-good']);assert.equal(r.data.rejected.length,1);cases.push('deep malformed event isolated from normal event');
 const huge={...event(prefix+'-huge',0,stamp),properties:{extra:'x'.repeat(8192)}};r=await post(batch([huge]));checkAck(r,[huge.client_event_id]);assert.equal(r.data.rejected[0].reason,'event_too_large');cases.push('oversized event terminal rejection');
 const full=Array.from({length:200},(_,i)=>{const e={...event(prefix+'-full-'+i,0,stamp),event_name:'g1.reward_granted',properties:{logical_day:'2026-10-13',tank_id:'TANK-001',reward_instance_id:'reward-'+i,source_kind:'progress_stage',source_id:'REGULAR-01',rewards:Array.from({length:10},()=>({kind:'',item_id:'',quantity:1,tank_id:''}))}};let remaining=8192-Buffer.byteLength(JSON.stringify(e));for(const reward of e.properties.rewards)for(const key of ['kind','item_id','tank_id']){const n=Math.min(256,remaining);reward[key]='x'.repeat(n);remaining-=n;}assert.equal(remaining,0);assert.equal(Buffer.byteLength(JSON.stringify(e)),8192);return e;});
 const fullBatch=batch(full,prefix+'-full');r=await post(fullBatch,tokens[1]);checkAck(r,full.map(e=>e.client_event_id));assert.equal(r.data.accepted_event_ids.length,200);cases.push('real nginx200×8192B legal batch');
 assert.equal((await fetch('http://127.0.0.1:3306/internal/analytics/overview')).status,401);
 const roles={};for(const role of ['admin','editor','guest']){const j=await login(role);const response=await fetch(gateway+'/api/admin/analytics/overview',{headers:{Authorization:'Bearer '+j.token}});roles[role]=response.status;assert.equal(response.status,role==='admin'?200:403,'admin gateway role='+role+' status='+response.status);writeFileSync(out+'/browser-'+role+'.json',JSON.stringify({cookies:[],origins:[{origin:gateway,localStorage:[{name:'kidshub_admin_token',value:j.token},{name:'kidshub_admin_username',value:j.username},{name:'kidshub_admin_role',value:j.role}]}]}),{mode:0o600});}assert.equal((await fetch(gateway+'/api/admin/analytics/overview')).status,401);cases.push('actual gateway admin200/editor403/guest403/anonymous401');
 writeFileSync(out+'/replay-fixture.json',JSON.stringify({events:[e],expected:[e.client_event_id]}),{mode:0o600});
 const report={ok:true,mode,captured_at:new Date().toISOString(),source_samples_runtime_captured:false,real_device_data_used:false,cases,roles,full_batch_bytes:Buffer.byteLength(JSON.stringify(fullBatch)),counts:counts()};writeFileSync(out+'/smoke.json',JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report));
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const percentile=(values,p)=>{const a=[...values].sort((a,b)=>a-b);return a.length?a[Math.min(a.length-1,Math.floor(a.length*p))]:null;};
async function load(){
 const started=Date.now(),deadline=started+5*60*1000,prefix='load-'+started,latencies=[],voiceLatencies=[],retries={},retryReasons={},maxRssSamples=[],monitorFailures=[],actorFailures=[],before=counts(),accounting=createLoadAccounting({expectedEvents:actorCount*6000,expectedBatches:actorCount*30});let monitor=true;
 // Keep failed monitoring evidence and finish the load; an unhandled watcher rejection
 // previously killed Node before recording which server failed. Every failure still fails a gate.
 const watcher=(async()=>{while(monitor){for(const source of ['existing_health','stage_ready']){const start=performance.now();let status;try{const response=await fetch(source==='existing_health'?'http://127.0.0.1:3001/health':'http://127.0.0.1:3306/ready',{signal:AbortSignal.timeout(5000)});status=response.status;if(source==='existing_health'){assert.equal(status,200);await response.arrayBuffer();voiceLatencies.push(performance.now()-start);}else{assert.ok(status===200||status===503);const health=await response.json();assert.ok(Number.isFinite(health.rss_bytes));maxRssSamples.push(health.rss_bytes);}}catch(error){monitorFailures.push({source,status:status??null,error_type:error.name,elapsed_ms:performance.now()-start});}}await sleep(1000);}})();
 const progress=setInterval(()=>{const total=accounting.totals();console.log(JSON.stringify({progress:true,completed_batches:total.batches,accepted_events:total.events_accepted,duplicated_events:total.events_duplicated,acknowledged_events:total.events_acknowledged,retry_reasons:retryReasons,seconds:Math.round((Date.now()-started)/1000)}));},20000);
 try{const results=await Promise.allSettled(subjects.map(async(_,actor)=>{await sleep(actor*125);for(let b=0;b<30;b++){const events=Array.from({length:200},(_,i)=>event(prefix+'-'+actor+'-'+b+'-'+i,b*200+i,started));const body=batch(events,prefix+'-'+actor+'-'+b),ids=events.map(e=>e.client_event_id);let attempts=0;while(true){assert.ok(Date.now()<deadline,'load deadline');const r=await post(body,tokens[actor],prefix+'-'+actor+'-'+b);if(r.status===200){checkAck(r,ids);accounting.record(r.data,ids);latencies.push(r.ms);break;}assert.ok(r.status===429||r.status===503,'unexpected load status '+r.status);assert.match(r.retry||'',/^\d+$/);retries[r.status]=(retries[r.status]||0)+1;const reason=r.status+':'+r.data.error_code+':'+r.retry;retryReasons[reason]=(retryReasons[reason]||0)+1;assert.ok(++attempts<8,'retry budget');const wait=Number(r.retry)*1000+Math.floor(Math.random()*300);assert.ok(Date.now()+wait<deadline,'server backoff exceeds load deadline');await sleep(wait);}await sleep(2000);}}));results.forEach((result,actor)=>{if(result.status==='rejected')actorFailures.push({actor,error_type:result.reason.name,error:String(result.reason.message).slice(0,120)});});}finally{clearInterval(progress);monitor=false;await watcher;}
 const baseline=JSON.parse(readFileSync(out+'/voice-health-predeploy.json','utf8'));const oldP95=baseline.p95_ms??baseline.p95??baseline.latency_ms?.p95;
 const readerDb=new DatabaseSync(process.env.ANALYTICS_DB_PATH,{readOnly:true});let integrity;
 try{integrity=accounting.report(readerDb,prefix,before,actorFailures);}finally{readerDb.close();}
 const report={ok:true,mode,captured_at:new Date().toISOString(),real_device_data_used:false,synthetic_actors:actorCount,...integrity,duration_ms:Date.now()-started,retries,retry_reasons:retryReasons,actor_failures:actorFailures,monitor_failures:monitorFailures,proxy_latency_ms:{p50:percentile(latencies,.5),p95:percentile(latencies,.95),p99:percentile(latencies,.99),max:latencies.length?Math.max(...latencies):null},rss_peak_bytes:maxRssSamples.length?Math.max(...maxRssSamples):null,voice_health:{samples:voiceLatencies.length,p95_ms:percentile(voiceLatencies,.95),predeploy_p95_ms:oldP95,delta_p95_ms:voiceLatencies.length?percentile(voiceLatencies,.95)-oldP95:null,probe_only:true}};
 report.gates={complete:integrity.complete,monitoring:monitorFailures.length===0&&maxRssSamples.length>0,p95:latencies.length>0&&report.proxy_latency_ms.p95<=500,p99:latencies.length>0&&report.proxy_latency_ms.p99<=2000,rss:maxRssSamples.length>0&&report.rss_peak_bytes<=256*1024**2,existing_health:voiceLatencies.length>0&&!monitorFailures.some(f=>f.source==='existing_health')&&Number.isFinite(oldP95)&&report.voice_health.delta_p95_ms<=50};report.ok=Object.values(report.gates).every(Boolean);writeFileSync(out+'/load-'+started+'.json',JSON.stringify(report,null,2),{mode:0o600});writeFileSync(out+'/load.json',JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report));
 writeFileSync(out+'/load-http-timings-'+started+'.json',JSON.stringify({synthetic_only:true,records:httpTimings},null,2),{mode:0o600});
 assert.ok(report.gates.complete,'84000-event completion gate');assert.ok(report.gates.monitoring,'monitoring gate');
 assert.ok(report.gates.p95,'P95 latency gate');assert.ok(report.gates.p99,'P99 latency gate');assert.ok(report.gates.rss,'RSS gate');assert.ok(report.gates.existing_health,'existing health regression gate');
}
async function probe(){const times=[],prefix='probe-'+Date.now();for(let b=0;b<10;b++){const events=Array.from({length:200},(_,i)=>event(prefix+'-'+b+'-'+i,b*200+i));const r=await post(batch(events,prefix+'-'+b),tokens[3],prefix+'-'+b);checkAck(r,events.map(e=>e.client_event_id));times.push(r.ms);}console.log(JSON.stringify({ok:true,mode,serial_batches:10,p50_ms:percentile(times,.5),p95_ms:percentile(times,.95),samples_ms:times}));}
async function replay(){const f=JSON.parse(readFileSync(out+'/replay-fixture.json','utf8'));const before=counts(),r=await post(batch(f.events,'after-ingest-restart'));checkAck(r,f.expected);assert.deepEqual(r.data.duplicated_event_ids,f.expected);const after=counts();assert.equal(before.events,after.events);assert.equal(before.seen,after.seen);const report={ok:true,mode,captured_at:new Date().toISOString(),replay_after_process_restart:true,before,after};writeFileSync(out+'/restart-replay.json',JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report));}
try{if(mode==='smoke')await smoke();else if(mode==='load')await load();else if(mode==='replay')await replay();else if(mode==='probe')await probe();else throw Error('unknown mode');}catch(error){console.error(JSON.stringify({ok:false,mode,error:String(error.message).slice(0,240)}));process.exitCode=1;}
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1]))await main();
