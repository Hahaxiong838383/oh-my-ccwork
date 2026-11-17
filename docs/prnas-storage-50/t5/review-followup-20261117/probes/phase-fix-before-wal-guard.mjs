#!/usr/bin/env node
/**
 * Read-only phase profile for one Ark history request on an isolated T5 DB.
 *
 * It does not open AnalyticsStore, so it does not run startup DDL.
 * It does not read analytics_rollup_fact and does not maintain or checkpoint.
 * It does not drop the host page cache.
 *
 * Cloud wrapper, 1 CPU / 768 MiB / 90s, after the isolated writer is stopped:
 *   systemd-run --unit=p003-t5-grok-next-profile --collect \
 *     --property=CPUQuota=100% --property=MemoryMax=768M --property=Nice=15 \
 *     --property=IOWeight=20 --property=RuntimeMaxSec=90 \
 *     --working-directory=/opt/p003/archive-t5-20261117 \
 *     /opt/p003/server/.runtime/node-v24.19.0-linux-x64/bin/node --experimental-sqlite \
 *     profile-first-request.mjs \
 *     /opt/p003/archive-t5-20261117/p003-t5-50x12000-cover01/analytics.db
 *
 * Optional: T5_PROFILE_NOW_MS=1794931199000 pins the window to the end of
 * 2026-11-17 CST. T5_PROFILE_ALLOW_SMALL=1 is only for the local self-test.
 */
import {createHash} from 'node:crypto';
import {existsSync,readFileSync,realpathSync,statSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {dirname,join} from 'node:path';

const DAY=86400000;
const PAGE_FLOOR=100000;
const TIME_BUDGET_MS=80000;
const COLUMNS='e.event_name,e.occurred_at_ms,e.received_at_ms,e.clock_suspicious,e.properties_json,b.client_json';
const INDEX_NAMES=['analytics_ark_evidence_cover_v1','analytics_ark_assets_cover_v1','analytics_ark_daily_cover_v1'];
const FALLBACK='analytics_ark_device_event_received';
const ALLOWED_EXEC=new Set([
  'BEGIN','COMMIT','ROLLBACK',
  'PRAGMA query_only=ON','PRAGMA busy_timeout=0','PRAGMA cache_size=-65536',
]);
const startedAt=Date.now();
const notes=[
  'request_cold is the first history pass in this process; later passes are comparison samples, not a warmup procedure',
  'the OS page cache is not dropped; read_bytes near 0 means this run did not observe cold disk IO',
  'HTTP parse, token compare, and response encoding are outside these phases',
  'a result here is not a T5, A07, A08, A09, or A14 pass',
];

function die(code,error,extra={}){
  process.stdout.write(JSON.stringify({ok:false,exit:code,error:String(error),...extra,notes,do_not_interpret_as_t5_pass:true},null,2)+'\n');
  process.exit(code);
}
function assertBudget(){
  if(Date.now()-startedAt>TIME_BUDGET_MS)throw new Error('PROFILE_TIME_BUDGET');
}
function execAllowed(db,sql){
  if(!ALLOWED_EXEC.has(sql))throw new Error('refusing SQL exec');
  db.exec(sql);
}
function readProc(path){
  try{return readFileSync(path,'utf8');}catch{return null;}
}
function ioSnap(){
  const text=readProc('/proc/self/io');
  if(!text)return null;
  const out={};
  for(const line of text.trim().split('\n')){
    const i=line.indexOf(':');
    if(i>0)out[line.slice(0,i)]=Number(line.slice(i+1).trim());
  }
  return out;
}
function faultSnap(){
  const text=readProc('/proc/self/stat');
  if(!text)return null;
  const parts=text.slice(text.lastIndexOf(')')+2).trim().split(/\s+/);
  return {minflt:Number(parts[7]),majflt:Number(parts[9])};
}
function fileSnap(path){
  if(!existsSync(path))return null;
  const s=statSync(path);
  return {path,size:s.size,mtime_ms:Math.floor(s.mtimeMs),ino:s.ino};
}
function delta(before,after){
  if(!before||!after)return null;
  const out={};
  for(const key of new Set([...Object.keys(before),...Object.keys(after)])){
    if(typeof after[key]==='number'&&typeof before[key]==='number')out[key]=after[key]-before[key];
  }
  return out;
}
function phase(name,fn){
  assertBudget();
  const io0=ioSnap(),fault0=faultSnap(),cpu0=process.cpuUsage(),t0=performance.now();
  let error=null,value;
  try{value=fn();}catch(e){error=e instanceof Error?e.message:String(e);}
  const cpu=process.cpuUsage(cpu0);
  return {name,ms:performance.now()-t0,cpu_user_us:cpu.user,cpu_system_us:cpu.system,io:delta(io0,ioSnap()),faults:delta(fault0,faultSnap()),error,value};
}
function snOf(actor){return 'BJP003999999'+String(actor+1).padStart(8,'0');}
function deviceKey(actor){return createHash('sha256').update(snOf(actor)).digest('hex');}
function assertIndex(name){
  if(!INDEX_NAMES.includes(name)&&name!==FALLBACK)throw new Error('unexpected index');
  return name;
}

const dbPath=process.argv[2]??'';
if(!dbPath.startsWith('/'))die(2,'absolute analytics.db path required');
let real;
try{real=realpathSync(dbPath);}catch(e){die(2,e.message);}
if(real!==dbPath)die(2,'path must already be canonical',{real});
if(!real.includes('p003-t5-')||real.includes('/server/data')||!real.endsWith('/analytics.db'))die(2,'refusing path outside an isolated p003-t5 analytics.db',{real});
const actor=Number(process.env.T5_PROFILE_ACTOR??0);
const second=Number(process.env.T5_PROFILE_SECOND_ACTOR??1);
if(!Number.isInteger(actor)||actor<0||actor>999||!Number.isInteger(second)||second<0||second>999)die(2,'bad actor');
const now=Number(process.env.T5_PROFILE_NOW_MS??Date.now());
if(!Number.isSafeInteger(now)||now<1e12)die(2,'bad T5_PROFILE_NOW_MS');
const notBefore=0;
const receivedLower=Math.max(notBefore,now-14*DAY);
const today=new Date(now+8*3600000).toISOString().slice(0,10);
const dayStart=Date.parse(today+'T00:00:00+08:00');
const beforeFiles={db:fileSnap(real),wal:fileSnap(real+'-wal'),shm:fileSnap(real+'-shm')};
const report={
  ok:false,do_not_interpret_as_t5_pass:true,
  source_pin:'65c86916e1e6a64352ec75d3c2b6eebb364e649a',
  node:process.version,platform:process.platform,db:real,now_ms:now,cst_day:today,
  received_lower_ms:receivedLower,day_start_ms:dayStart,actor,sn:snOf(actor),
  device_key:deviceKey(actor),second_actor:second===actor?null:second,phases:[],notes,
};

let db;
try{
  db=new DatabaseSync(real,{readOnly:true,timeout:0});
  execAllowed(db,'PRAGMA query_only=ON');
  execAllowed(db,'PRAGMA busy_timeout=0');
  execAllowed(db,'PRAGMA cache_size=-65536');
  const version=db.prepare('SELECT sqlite_version() v').get().v;
  const page=db.prepare('PRAGMA page_count').get();
  const pageSize=db.prepare('PRAGMA page_size').get();
  const journal=db.prepare('PRAGMA journal_mode').get();
  const queryOnly=db.prepare('PRAGMA query_only').get();
  report.sqlite={version,page_count:page.page_count,page_size:pageSize.page_size,journal_mode:journal.journal_mode,query_only:queryOnly.query_only};
  if(queryOnly.query_only!==1)die(4,'query_only did not stick',report);
  if(page.page_count<PAGE_FLOOR&&process.env.T5_PROFILE_ALLOW_SMALL!=='1')die(2,'database is below the 600k page floor',report);
}catch(e){die(4,e.message??String(e),report);}

report.phases.push(phase('before_request_schema',()=>db.prepare("SELECT count(*) n FROM sqlite_schema WHERE type IN ('table','index')").get()));

function chooseIndexes(){
  const present=new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND tbl_name='analytics_event' AND name IN (?,?,?)").all(...INDEX_NAMES).map(row=>row.name));
  return {
    evidence:assertIndex(present.has(INDEX_NAMES[0])?INDEX_NAMES[0]:FALLBACK),
    assets:assertIndex(present.has(INDEX_NAMES[1])?INDEX_NAMES[1]:FALLBACK),
    daily:assertIndex(present.has(INDEX_NAMES[2])?INDEX_NAMES[2]:FALLBACK),
    present:[...present],
  };
}
function evidenceSql(index){
  return `SELECT ${COLUMNS} FROM analytics_event e INDEXED BY ${assertIndex(index)} LEFT JOIN analytics_batch b ON b.attempt_id=e.batch_attempt_id
 WHERE e.device_key=? AND e.received_at_ms>=? AND e.received_at_ms<=?
 AND e.event_name IN ('g1.logical_day_changed','g1.command_failed','g1.runtime_command_completed','g1.gift_became_available','g1.gift_claimed','g1.reward_granted')
 AND (e.event_name='g1.logical_day_changed' OR json_extract(e.properties_json,'$.gm_override')=1 OR json_extract(e.properties_json,'$.source_mode')='gm'
 OR lower(coalesce(json_extract(e.properties_json,'$.command'),'')||' '||coalesce(json_extract(e.properties_json,'$.source_kind'),'')) GLOB '*gm*'
 OR lower(coalesce(json_extract(e.properties_json,'$.command'),'')||' '||coalesce(json_extract(e.properties_json,'$.source_kind'),'')) GLOB '*debug*'
 OR lower(coalesce(json_extract(e.properties_json,'$.command'),'')||' '||coalesce(json_extract(e.properties_json,'$.source_kind'),'')) GLOB '*test*')
 ORDER BY e.received_at_ms DESC LIMIT 513`;
}
function assetsSql(index){
  return `SELECT ${COLUMNS} FROM analytics_event e INDEXED BY ${assertIndex(index)} LEFT JOIN analytics_batch b ON b.attempt_id=e.batch_attempt_id
 WHERE e.device_key=? AND e.received_at_ms>=? AND e.received_at_ms<=?
 AND e.occurred_at_ms>=? AND e.occurred_at_ms<=? AND e.event_name IN ('g1.wallet_balance_changed','g1.inventory_changed','g1.makeup_card_balance_changed')
 ORDER BY e.occurred_at_ms DESC,e.received_at_ms DESC LIMIT 513`;
}
function dailySql(index){
  return `SELECT ${COLUMNS},e.session_id FROM analytics_event e INDEXED BY ${assertIndex(index)} LEFT JOIN analytics_batch b ON b.attempt_id=e.batch_attempt_id
 WHERE e.device_key=? AND e.received_at_ms>=? AND e.received_at_ms<=? AND e.occurred_at_ms>=? AND e.occurred_at_ms<=?
 AND e.event_name IN ('g1.progress_checkpoint','g1.reward_granted') ORDER BY e.occurred_at_ms,e.client_event_id LIMIT 513`;
}
function measureRows(rows){
  let property=0,client=0;
  for(const row of rows){
    property+=row.properties_json?.length??0;
    client+=row.client_json?.length??0;
    if(row.properties_json)JSON.parse(row.properties_json);
    if(row.client_json)JSON.parse(row.client_json);
  }
  return {rows:rows.length,property_bytes:property,client_json_bytes:client};
}
function arkPhase(actorIndex){
  const path=join(dirname(real),'ark.db');
  if(!existsSync(path))return {skipped:true,reason:'ark.db absent'};
  const arkReal=realpathSync(path);
  if(!arkReal.includes('p003-t5-')||arkReal.includes('/server/data'))throw new Error('refusing ark.db outside the isolated run');
  const ark=new DatabaseSync(arkReal,{readOnly:true,timeout:0});
  try{
    execAllowed(ark,'PRAGMA query_only=ON');
    execAllowed(ark,'PRAGMA busy_timeout=0');
    const settings=ark.prepare('SELECT enabled,revision FROM ark_settings WHERE id=1').get();
    const subjects=ark.prepare('SELECT sn FROM ark_grant ORDER BY sn').all();
    const grant=ark.prepare('SELECT grant_id,not_before_ms FROM ark_grant WHERE sn=? AND account_id=? AND epoch=?').get(snOf(actorIndex),'t5-synthetic-'+actorIndex,1);
    return {settings_enabled:settings?!!settings.enabled:null,grant_rows:subjects.length,grant_found:!!grant,not_before_ms:grant?.not_before_ms??null};
  }finally{ark.close();}
}
function historyPass(label,actorIndex){
  const key=deviceKey(actorIndex);
  const bucket=[];
  const run=(name,fn)=>bucket.push(phase(label+'.'+name,fn));
  let indexes;
  run('ark_grant',()=>arkPhase(actorIndex));
  run('begin',()=>execAllowed(db,'BEGIN'));
  run('index_lookup',()=>{indexes=chooseIndexes();return indexes;});
  if(!indexes){run('rollback',()=>execAllowed(db,'ROLLBACK'));return bucket;}
  let evidenceRows=[];
  run('prepare_exec_evidence',()=>{
    evidenceRows=db.prepare(evidenceSql(indexes.evidence)).all(key,receivedLower,now);
    return {rows:evidenceRows.length,index:indexes.evidence};
  });
  let assetRows=[];
  run('prepare_exec_assets',()=>{
    assetRows=db.prepare(assetsSql(indexes.assets)).all(key,receivedLower,now,receivedLower,now);
    return {rows:assetRows.length,index:indexes.assets};
  });
  run('parse_evidence_assets',()=>measureRows(evidenceRows.concat(assetRows)));
  evidenceRows=[];assetRows=[];
  const dailyLower=Math.max(notBefore,dayStart);
  let dailyRows=[];
  run('prepare_exec_daily',()=>{
    dailyRows=db.prepare(dailySql(indexes.daily)).all(key,dailyLower,now,dailyLower,now);
    return {rows:dailyRows.length,index:indexes.daily};
  });
  run('parse_daily',()=>measureRows(dailyRows));
  run('commit',()=>execAllowed(db,'COMMIT'));
  return bucket;
}

let failed=null;
try{
  report.phases.push(...historyPass('request_cold',actor));
  report.phases.push(...historyPass('warm_repeat',actor));
  if(second!==actor)report.phases.push(...historyPass('second_device',second));
  report.phases.push(phase('explain_after',()=>{
    const indexes=chooseIndexes();
    const key=deviceKey(actor);
    return {indexes,plans:{
      evidence:db.prepare('EXPLAIN QUERY PLAN '+evidenceSql(indexes.evidence)).all(key,receivedLower,now),
      assets:db.prepare('EXPLAIN QUERY PLAN '+assetsSql(indexes.assets)).all(key,receivedLower,now,receivedLower,now),
      daily:db.prepare('EXPLAIN QUERY PLAN '+dailySql(indexes.daily)).all(key,Math.max(notBefore,dayStart),now,Math.max(notBefore,dayStart),now),
    }};
  }));
}catch(e){failed=e instanceof Error?e.message:String(e);}
try{if(db.isTransaction)execAllowed(db,'ROLLBACK');}catch(e){failed??=e instanceof Error?e.message:String(e);}
try{db.close();}catch{}

const afterFiles={db:fileSnap(real),wal:fileSnap(real+'-wal'),shm:fileSnap(real+'-shm')};
report.files={before:beforeFiles,after:afterFiles};
report.db_or_wal_size_changed=[['db',beforeFiles.db,afterFiles.db],['wal',beforeFiles.wal,afterFiles.wal]].some(([,a,b])=>(a?.size??null)!==(b?.size??null));
report.shm_changed=JSON.stringify(beforeFiles.shm)!==JSON.stringify(afterFiles.shm);
report.phase_errors=report.phases.filter(p=>p.error!==null).map(p=>({name:p.name,error:p.error}));
if(report.phase_errors.length)failed??='PROFILE_PHASE_FAILED';
report.error=failed;
const cold=report.phases.filter(p=>p.name.startsWith('request_cold.'));
report.request_cold_ms=cold.reduce((sum,p)=>sum+p.ms,0);
report.request_cold_read_bytes=cold.reduce((sum,p)=>sum+(p.io?.read_bytes??0),0);
const returned=cold.filter(p=>p.name.endsWith('prepare_exec_evidence')||p.name.endsWith('prepare_exec_assets')||p.name.endsWith('prepare_exec_daily')).reduce((sum,p)=>sum+(p.value?.rows??0),0);
if(returned===0)notes.push('request_cold returned no rows; the clock window likely missed the fixture, so these times are not the 137ms query');
report.ok=!failed&&!report.db_or_wal_size_changed;
process.stdout.write(JSON.stringify(report,null,2)+'\n');
process.exit(report.db_or_wal_size_changed?3:failed?4:0);
