import {DatabaseSync} from 'node:sqlite';
import {statSync,realpathSync} from 'node:fs';
import {createHmac} from 'node:crypto';
import {dayBounds,DAY_MS,MAX_ROWS,parseInput,type Observation,type ReplayInput} from './contracts.js';
export type SourceOptions={analyticsPath:string;telemetryPath:string;deviceKeySecret:string;subject:string;day:string;cutoff_ms:number;rowLimit?:number};
export function openReadOnly(path:string){
 const real=realpathSync(path);if(!statSync(real).isFile())throw new Error('source_not_file');
 const db=new DatabaseSync(real,{readOnly:true,enableDoubleQuotedStringLiterals:false});
 db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=100; PRAGMA cache_size=-2048;');return db;
}
const keys=new Set(['logical_day','elapsed_seconds','checkpoint_minutes','completed_slots','current_slot','counting','status','eligible','present','presence_source','gm_override','source_mode','command','source_kind','revision','previous_revision','config_revision','reward_instance_id','source_id','stage_id','usage_day_index','rewards','start_ms','end_ms','focus_id']);
function fields(text:unknown){
 if(typeof text!=='string'||Buffer.byteLength(text)>16384)throw new Error('invalid_source_payload');
 const raw=JSON.parse(text);if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('invalid_source_payload');
 return Object.fromEntries(Object.entries(raw).filter(([k])=>keys.has(k)));
}
function safeId(x:unknown):string|null{return typeof x==='string'&&/^[A-Za-z0-9_.:/@+\-]{1,128}$/.test(x)?x:null;}
/** Must be run under source-worker's process timeout for operational reads. No Store singletons. */
export function readReplay(o:SourceOptions):ReplayInput{
 const {start,end}=dayBounds(o.day),limit=o.rowLimit??MAX_ROWS;
 if(!Number.isSafeInteger(limit)||limit<1||limit>MAX_ROWS||!o.deviceKeySecret)throw new Error('invalid_source_options');
 const result=parseInput({schema_version:1,subject:o.subject,day:o.day,cutoff_ms:o.cutoff_ms,analytics:[],telemetry:[],truncated:{analytics:false,telemetry:false}});
 const key=createHmac('sha256',o.deviceKeySecret).update('p003-analytics-v1\0'+o.subject).digest('hex');
 const a=openReadOnly(o.analyticsPath);
 try{
  a.exec('BEGIN');
  const rows=a.prepare(`SELECT e.client_event_id,e.event_name,e.session_id,e.occurred_at_ms,e.received_at_ms,e.clock_suspicious,e.properties_json,b.client_json
   FROM analytics_event e LEFT JOIN analytics_batch b ON b.attempt_id=e.batch_attempt_id
   WHERE e.device_key=? AND e.received_at_ms<=? AND (
     (e.occurred_at_ms>=? AND e.occurred_at_ms<?) OR
     (e.received_at_ms>=? AND (json_extract(e.properties_json,'$.logical_day')=? OR e.clock_suspicious<>0) AND
       (json_extract(e.properties_json,'$.gm_override')=1 OR json_extract(e.properties_json,'$.source_mode')='gm' OR
        lower(coalesce(json_extract(e.properties_json,'$.command'),'')||' '||coalesce(json_extract(e.properties_json,'$.source_kind'),'')) GLOB '*gm*' OR
        lower(coalesce(json_extract(e.properties_json,'$.command'),'')||' '||coalesce(json_extract(e.properties_json,'$.source_kind'),'')) GLOB '*debug*' OR
        lower(coalesce(json_extract(e.properties_json,'$.command'),'')||' '||coalesce(json_extract(e.properties_json,'$.source_kind'),'')) GLOB '*test*')))
   AND e.event_name IN ('g1.presence_state_changed','g1.progress_checkpoint','g1.progress_counting_changed','g1.logical_day_changed','g1.config_revision_changed','g1.runtime_state_restored','g1.runtime_command_completed','g1.command_failed','g1.gift_became_available','g1.gift_claimed','g1.reward_granted','g1.progress_reward_settled','g1.progress_stage_reached')
   ORDER BY e.occurred_at_ms,e.client_event_id LIMIT ?`).all(key,o.cutoff_ms,start,end,start-14*DAY_MS,o.day,limit+1) as Record<string,unknown>[];
  result.truncated.analytics=rows.length>limit;
  result.analytics=rows.slice(0,limit).map(r=>{
   let version:null|string=null;
   if(typeof r.client_json==='string'&&Buffer.byteLength(r.client_json)<=4096)version=safeId(JSON.parse(r.client_json).content_version);
   return {id:r.client_event_id,name:r.event_name,session:safeId(r.session_id),occurred_at_ms:r.occurred_at_ms,received_at_ms:r.received_at_ms,clock_suspicious:!!r.clock_suspicious,clock_skew_ms:null,version,data:fields(r.properties_json)} as Observation;
  });a.exec('COMMIT');
 }finally{a.close();}
 const t=openReadOnly(o.telemetryPath);
 try{
  t.exec('BEGIN');
  // A <=24h interval ending next day can overlap this day. Keep the lookahead bounded.
  const rows=t.prepare(`SELECT event_id,type,occurred_at_ms,server_received_ms,clock_skew_ms,data_json FROM device_telemetry_event
   WHERE sn=? AND type IN ('focus_segment','presence_transition','focus_session_started','focus_session_ended')
   AND occurred_at_ms>=? AND occurred_at_ms<? AND server_received_ms<=?
   ORDER BY occurred_at_ms,event_id LIMIT ?`).all(o.subject,start,end+DAY_MS,o.cutoff_ms,limit+1) as Record<string,unknown>[];
  result.truncated.telemetry=rows.length>limit;
  result.telemetry=rows.slice(0,limit).map(r=>({id:r.event_id,name:r.type,session:safeId(fields(r.data_json).focus_id),occurred_at_ms:r.occurred_at_ms,received_at_ms:r.server_received_ms,clock_suspicious:false,clock_skew_ms:r.clock_skew_ms,version:null,data:fields(r.data_json)}) as Observation);
  t.exec('COMMIT');
 }finally{t.close();}
 return parseInput(result);
}
