#!/usr/bin/env node
/** Local script check only. A fast temp database does not stand in for the cloud 600k result. */
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';

const node=process.execPath;
const script=new URL('./profile-first-request.mjs',import.meta.url).pathname;
const root=realpathSync(mkdtempSync(join(tmpdir(),'p003-t5-grok-profile-')));
const dbPath=join(root,'analytics.db');
const now=1794931199000;
const sn='BJP00399999900000001';
const key=createHash('sha256').update(sn).digest('hex');
const events=[
  ['g1.logical_day_changed','{"gm_override":false,"logical_day":"2026-11-17"}'],
  ['g1.wallet_balance_changed','{"item_id":"C-FAMILY-001","before":0,"after":20,"delta":20}'],
  ['g1.reward_granted','{"reward_instance_id":"r","rewards":[{"item_id":"C-FAMILY-001","quantity":1}]}'],
  ['voice.session_state_changed','{}'],
];
const db=new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode=WAL');
db.exec(`CREATE TABLE analytics_event (
 device_key TEXT NOT NULL, client_event_id TEXT NOT NULL, event_name TEXT NOT NULL,
 occurred_at_ms INTEGER NOT NULL, received_at_ms INTEGER NOT NULL, session_id TEXT NOT NULL,
 sequence INTEGER NOT NULL, priority TEXT NOT NULL, context_json TEXT NOT NULL, properties_json TEXT NOT NULL,
 batch_attempt_id TEXT NOT NULL, occurred_day TEXT, received_day TEXT NOT NULL, clock_suspicious INTEGER NOT NULL,
 PRIMARY KEY(device_key,client_event_id));
CREATE TABLE analytics_batch (
 attempt_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, batch_id TEXT NOT NULL, device_key TEXT NOT NULL,
 received_at_ms INTEGER NOT NULL, sent_at_ms INTEGER NOT NULL, client_json TEXT NOT NULL,
 accepted INTEGER NOT NULL, duplicated INTEGER NOT NULL, rejected INTEGER NOT NULL,
 http_status INTEGER NOT NULL, processing_ms INTEGER NOT NULL);
CREATE INDEX analytics_ark_device_event_received ON analytics_event(device_key,event_name,received_at_ms DESC,occurred_at_ms DESC);
CREATE INDEX analytics_ark_evidence_cover_v1 ON analytics_event(device_key,event_name,received_at_ms DESC,occurred_at_ms DESC,clock_suspicious,properties_json,batch_attempt_id,session_id,client_event_id) WHERE event_name IN ('g1.logical_day_changed','g1.command_failed','g1.runtime_command_completed','g1.gift_became_available','g1.gift_claimed','g1.reward_granted');
CREATE INDEX analytics_ark_assets_cover_v1 ON analytics_event(device_key,event_name,received_at_ms DESC,occurred_at_ms DESC,clock_suspicious,properties_json,batch_attempt_id,session_id,client_event_id) WHERE event_name IN ('g1.wallet_balance_changed','g1.inventory_changed','g1.makeup_card_balance_changed');
CREATE INDEX analytics_ark_daily_cover_v1 ON analytics_event(device_key,event_name,received_at_ms DESC,occurred_at_ms DESC,clock_suspicious,properties_json,batch_attempt_id,session_id,client_event_id) WHERE event_name IN ('g1.progress_checkpoint','g1.reward_granted');
`);
db.prepare('INSERT INTO analytics_batch VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run('batch-1','req','batch',key,now-1000,now-1000,'{"content_version":"selftest"}',1,0,0,200,1);
const insert=db.prepare('INSERT INTO analytics_event VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
events.forEach((e,i)=>insert.run(key,'e'+i,e[0],now-1000,now-1000,'sess',i,'normal','{}',e[1],'batch-1','2026-11-17','2026-11-17',0));
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
db.close();
const ark=new DatabaseSync(join(root,'ark.db'));
ark.exec(`CREATE TABLE ark_settings(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL,revision INTEGER NOT NULL);
INSERT INTO ark_settings VALUES (1,1,1);
CREATE TABLE ark_grant(sn TEXT PRIMARY KEY,account_id TEXT NOT NULL,epoch INTEGER NOT NULL,grant_id TEXT NOT NULL,not_before_ms INTEGER NOT NULL);
INSERT INTO ark_grant VALUES ('${sn}','t5-synthetic-0',1,'g',${now-86400000});`);
ark.exec('PRAGMA wal_checkpoint(TRUNCATE)');
ark.close();
const before=readFileSync(dbPath);
const run=(args,env={})=>spawnSync(node,['--experimental-sqlite',script,...args],{env:{...process.env,...env},encoding:'utf8'});
const good=run([dbPath],{T5_PROFILE_ALLOW_SMALL:'1',T5_PROFILE_NOW_MS:String(now),T5_PROFILE_SECOND_ACTOR:'0'});
const after=readFileSync(dbPath);
const bad=run(['/tmp/analytics.db']);
const nested=run(['/tmp/p003-t5-bad/server/data/analytics.db']);
let writeBlocked=false;
const ro=new DatabaseSync(dbPath,{readOnly:true,timeout:0});
ro.exec('PRAGMA query_only=ON');
try{ro.exec('CREATE TABLE nope(a)');}catch{writeBlocked=true;}
ro.close();
const body=good.stdout?JSON.parse(good.stdout):null;
const plans=body?.phases?.find(p=>p.name==='explain_after')?.value?.plans;
const planText=JSON.stringify(plans??{});
const checks={
  exit_zero:good.status===0,
  bytes_unchanged:before.equals(after),
  write_blocked:writeBlocked,
  bad_path:bad.status===2,
  nested_path:nested.status===2,
  query_only:body?.sqlite?.query_only===1,
  evidence_rows:body?.phases?.find(p=>p.name==='request_cold.prepare_exec_evidence')?.value?.rows===1,
  asset_rows:body?.phases?.find(p=>p.name==='request_cold.prepare_exec_assets')?.value?.rows===1,
  daily_rows:body?.phases?.find(p=>p.name==='request_cold.prepare_exec_daily')?.value?.rows===1,
  grant_found:body?.phases?.find(p=>p.name==='request_cold.ark_grant')?.value?.grant_found===true,
  covering:planText.includes('COVERING INDEX'),
  no_phase_error:body?.phases?.every(p=>p.error==null),
  size_flag:body?.db_or_wal_size_changed===false,
};
const failed=Object.entries(checks).filter(([,v])=>v!==true);
const out={checks,failed:failed.map(([k])=>k),stderr:good.stderr,status:good.status,plan_details:Object.fromEntries(Object.entries(plans??{}).map(([k,v])=>[k,v.map(x=>x.detail)])),plans,request_cold_ms:body?.request_cold_ms};
process.stdout.write(JSON.stringify(out,null,2)+'\n');
rmSync(root,{recursive:true,force:true});
if(failed.length||good.status!==0)process.exit(1);
