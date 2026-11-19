import {createHash} from 'node:crypto';
import {deviceRegistryStore} from './device-registry-store.js';
import {accountStore} from './account-store.js';
import {telemetryStore} from './telemetry-store.js';
import {configuredHistoryScope,assertHistoryScope,readOnlyDatabase} from './history-scope.js';
import {ObservationError} from './history-observations.js';
import {parentObservationBundle} from './parent-observations.js';
import {buildHistoricalUsage} from './history-usage.js';
import {buildWeeklyCalculation,weekStartOf,dateAdd,validDate,type WeeklyEvent,type SupplementalDay} from './weekly-calculation.js';
import {weeklyReportStore,type WeeklyReport} from './weekly-report-store.js';

export class WeeklyReportError extends Error {constructor(public status:400|404|503,code:string){super(code);}}
type Reader={publicId:string;owner:string;role:string};
const hash=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
/** Fresh ownership checks surround every awaited dependency and every cache read/write. */
function authority(reader:Reader){
 const device=deviceRegistryStore.getByPublicId(reader.publicId);
 if(reader.role!=='parent'||!device||device.status!=='active'||device.parent_account_id!==reader.owner||accountStore.findAccount(reader.owner)?.role!=='parent')throw new WeeklyReportError(404,'not_found');
 const identity=deviceRegistryStore.arkIdentity(device.sn);
 let historical=false;
 const configured=configuredHistoryScope();
 if(configured?.public_id===reader.publicId&&configured.parent_account_id===reader.owner){
  try{assertHistoryScope(configured);historical=true;}catch(error){
   if(error instanceof ObservationError&&error.status===404)historical=false;
   else throw new WeeklyReportError(503,'weekly_authorization_dependency_unavailable');
  }
 }
 const key=hash({sn:device.sn,public_id:device.public_id,owner:reader.owner,account:device.account_id,
  binding:device.binding_version,status:device.status,epoch:identity?.epoch??null,historical,
  device_role:device.account_id?accountStore.findAccount(device.account_id)?.role:null});
 return {device,key,historical};
}
function unchanged(reader:Reader,key:string){if(authority(reader).key!==key)throw new WeeklyReportError(404,'not_found');}
function rawEvents(sn:string):WeeklyEvent[]{
 const db=readOnlyDatabase(process.env.TELEMETRY_DB_PATH??'./data/telemetry.db');
 try{
  const rows=db.prepare(`SELECT event_id,type,occurred_at_ms,server_received_ms,data_json FROM device_telemetry_event
   WHERE sn=? AND type IN ('focus_segment','posture_reminder','presence_transition','posture_round') ORDER BY server_received_ms,event_id LIMIT 100001`).all(sn);
  if(rows.length>100000)throw new Error('weekly_evidence_limit');
  return rows.map(row=>({event_id:String(row.event_id),type:String(row.type),occurred_at_ms:Number(row.occurred_at_ms),server_received_ms:Number(row.server_received_ms),data:JSON.parse(String(row.data_json))}));
 }finally{db.close();}
}
async function context(reader:Reader,now:number){
 const auth=authority(reader),store=weeklyReportStore(),opened=store.openScope(auth.key,now);
 let events:WeeklyEvent[]=[],telemetryAvailable=true;
 try{events=rawEvents(auth.device.sn).filter(e=>auth.historical||(e.server_received_ms>=opened&&e.occurred_at_ms>=opened&&
   (e.type!=='focus_segment'||typeof e.data.start_ms==='number'&&e.data.start_ms>=opened)));}catch{telemetryAvailable=false;}
 let days:SupplementalDay[]=[],supplementalAvailable=telemetryAvailable;
 if(auth.historical){
  try{const history=await parentObservationBundle(reader.publicId,reader.owner,reader.role);
   // Only unlocated reward counters use a durable high-water mark. Located windows
   // must remain correctable by late absent/transition evidence.
   days=buildHistoricalUsage([],history.bundle.progress,now).daily;
  }catch{supplementalAvailable=false;}
 }
 unchanged(reader,auth.key);
 store.retain(auth.key,events,days);
 const retainedEvents=store.evidence(auth.key);
 // Re-union retained located windows with late focus intervals after upstream cleanup.
 // A scalar daily max alone would lose old non-overlapping presence/posture windows.
 const located=buildHistoricalUsage(retainedEvents,[],now,{roundSeconds:false}).daily;
 const byDate=new Map<string,SupplementalDay>(store.supplements(auth.key).map(day=>[day.date,day]));
 for(const day of located){const counter=byDate.get(day.date);byDate.set(day.date,{...day,
  total_seconds:Math.max(day.total_seconds,counter?.total_seconds??0),
  updated_at_ms:Math.max(day.updated_at_ms,counter?.updated_at_ms??0)});}
 const retainedDays=[...byDate.values()];
 return {reader,auth,store,events:retainedEvents,days:retainedDays,telemetryAvailable,supplementalAvailable};
}
type Context=Awaited<ReturnType<typeof context>>;
function calculate(ctx:Context,week:string,now:number):WeeklyReport{
 unchanged(ctx.reader,ctx.auth.key);
 // Failure cannot overwrite a good durable report with empty or reduced results.
 if(!ctx.telemetryAvailable){
  const prior=ctx.store.report(ctx.auth.key,week);
  if(prior)return {...prior,coverage:{...prior.coverage,reason:'retained_dependency_unavailable'}};
 }
 const calculation=buildWeeklyCalculation({weekStart:week,events:ctx.events,supplementalDays:ctx.days,now,
  telemetryAvailable:ctx.telemetryAvailable||ctx.events.length>0,supplementalAvailable:ctx.telemetryAvailable||ctx.days.length>0});
 unchanged(ctx.reader,ctx.auth.key);
 const report=ctx.store.save(ctx.auth.key,ctx.reader.publicId,calculation,now);
 // A temporary read outage is not a revision of the underlying weekly facts.
 if(!ctx.supplementalAvailable)return {...report,coverage:{...report.coverage,supplemental_available:false,
  reason:ctx.days.length?'partial_history_retained_supplement':'partial_history_supplement_unavailable'}};
 return report;
}
export function selectedWeeklyDate(value:string|undefined,now=Date.now()):string{
 if(value!==undefined&&(!validDate(value)||value<'1970-01-05'||value>'9999-12-20'))throw new WeeklyReportError(400,'bad_request');
 return value??weekStartOf(now);
}
function legacy(sn:string,from:string){
 const daily=telemetryStore.dailyRange(sn,from,dateAdd(from,6)),correct=daily.reduce((s,d)=>s+d.correct_rounds,0),deviated=daily.reduce((s,d)=>s+d.deviated_rounds,0),denom=correct+deviated;
 return {week_start:from,eye_health_rate:denom>0?Math.round(correct/denom*100):null,
  guarded_minutes:Math.round(daily.reduce((s,d)=>s+d.guarded_ms,0)/60000),posture_alert_count:daily.reduce((s,d)=>s+d.reminder_played,0),
  percentile:null,highlights:[],data_quality:{valid_posture_rounds:denom,missing_hours:null}};
}
export async function readParentWeeklyReport(publicId:string,owner:string,role:string,requested?:string,now=Date.now()){
 const from=selectedWeeklyDate(requested,now),reader={publicId,owner,role};
 const device=deviceRegistryStore.getByPublicId(publicId);
 if(!device||device.parent_account_id!==owner)throw new WeeklyReportError(404,'not_found');
 // Legacy clients could query a disabled device or a pre-account binding. Keep their
 // original fields, but never expose the newly retained history without current authority.
 if(role!=='parent'||device.status!=='active'||accountStore.findAccount(owner)?.role!=='parent'){
  const data=legacy(device.sn,from);
  const current=deviceRegistryStore.getByPublicId(publicId);
  if(!current||current.sn!==device.sn||current.parent_account_id!==owner||current.binding_version!==device.binding_version)throw new WeeklyReportError(404,'not_found');
  return {ok:true as const,data:{...data,report:null as WeeklyReport|null,report_unavailable_reason:'current_binding_unavailable'}};
 }
 const ctx=await context(reader,now);
 // Preserve explicit legacy date windows; the additive report always uses its containing natural week.
 const week=weekStartOf(Date.parse(from+'T00:00:00+08:00'));
 const report=calculate(ctx,week,now);
 const data=legacy(ctx.auth.device.sn,from);
 unchanged(reader,ctx.auth.key);
 return {ok:true as const,data:{...data,report}};
}
export async function readAdminWeeklyReport(sn:string,requested?:string,now=Date.now()){
 const device=deviceRegistryStore.get(sn);
 if(!device?.public_id||!device.parent_account_id)throw new WeeklyReportError(404,'not_found');
 return readParentWeeklyReport(device.public_id,device.parent_account_id,'parent',requested,now);
}
let ticking=false;
/** Small in-process catch-up job; restart-safe persisted reports, no upload protocol changes. */
export async function refreshWeeklyReports(now=Date.now()){
 if(ticking)return;ticking=true;
 try{
  for(const device of deviceRegistryStore.list()){
   if(!device.public_id||!device.parent_account_id||device.status!=='active')continue;
   try{
    const ctx=await context({publicId:device.public_id,owner:device.parent_account_id,role:'parent'},now);
    const weeks=new Set([weekStartOf(now),dateAdd(weekStartOf(now),-7),...ctx.store.weeks(ctx.auth.key)]);
    for(const event of ctx.events){
     if(event.type!=='focus_segment'&&event.type!=='posture_reminder')continue;
     const times=event.type==='focus_segment'?[event.data.start_ms,event.data.end_ms]:[event.occurred_at_ms];
     for(const time of times)if(typeof time==='number'&&Number.isSafeInteger(time)&&time>0&&time<=now)weeks.add(weekStartOf(time));
    }
    for(const day of ctx.days)if(validDate(day.date))weeks.add(weekStartOf(Date.parse(day.date+'T00:00:00+08:00')));
    for(const week of weeks)calculate(ctx,week,now);
   }catch{console.warn('[weekly-report] refresh failed sn=****'+device.sn.slice(-4));}
  }
 }finally{ticking=false;}
}
export function startWeeklyReportScheduler(){
 void refreshWeeklyReports().catch(()=>console.warn('[weekly-report] refresh unavailable'));
 const timer=setInterval(()=>void refreshWeeklyReports().catch(()=>console.warn('[weekly-report] refresh unavailable')),60000);timer.unref();return timer;
}
