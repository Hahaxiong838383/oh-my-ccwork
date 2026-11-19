import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {dateAdd,validDate,type WeeklyCalculation,type WeeklyEvent,type SupplementalDay} from './weekly-calculation.js';

export type WeeklyReport = WeeklyCalculation & {
 report_id:string; status:'collecting'|'published'|'revised'; revision:number;
 published_at_ms:number|null; updated_at_ms:number; generated_at_ms:number;
 scheduled_publish_at_ms:number; period_end_ms:number; data_cutoff_at_ms:number;
 scope:{kind:'device';public_id:string};
};
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Only derived evidence is retained. No conversation, phone number or arbitrary event payload. */
function minimal(event:WeeklyEvent):WeeklyEvent {
 const fields:Record<string,string[]>={focus_segment:['start_ms','end_ms'],posture_reminder:['outcome'],presence_transition:['state','to','presence_state','present'],posture_round:['valid_frames','result']};
 const data=Object.fromEntries((fields[event.type]??[]).filter(k=>{
  const value=event.data?.[k];
  return typeof value==='number'&&Number.isFinite(value)||typeof value==='boolean'||typeof value==='string'&&value.length<=40;
 }).map(k=>[k,event.data[k]]));
 return {event_id:event.event_id,type:event.type,occurred_at_ms:event.occurred_at_ms,server_received_ms:event.server_received_ms,data};
}
export class WeeklyReportStore {
 readonly db:DatabaseSync;
 constructor(path:string){
  if(path!==':memory:')mkdirSync(dirname(resolve(path)),{recursive:true});
  this.db=new DatabaseSync(path);this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=1000;
   CREATE TABLE IF NOT EXISTS weekly_scope(scope_key TEXT PRIMARY KEY,opened_at_ms INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS weekly_evidence(scope_key TEXT NOT NULL,event_id TEXT NOT NULL,event_json TEXT NOT NULL,PRIMARY KEY(scope_key,event_id));
   CREATE TABLE IF NOT EXISTS weekly_supplement(scope_key TEXT NOT NULL,date TEXT NOT NULL,day_json TEXT NOT NULL,PRIMARY KEY(scope_key,date));
   CREATE TABLE IF NOT EXISTS weekly_report(scope_key TEXT NOT NULL,week_start TEXT NOT NULL,fingerprint TEXT NOT NULL,report_json TEXT NOT NULL,PRIMARY KEY(scope_key,week_start));
   CREATE TABLE IF NOT EXISTS weekly_day(scope_key TEXT NOT NULL,date TEXT NOT NULL,day_json TEXT NOT NULL,PRIMARY KEY(scope_key,date));`);
 }
 openScope(key:string,now:number):number{
  this.db.prepare('INSERT OR IGNORE INTO weekly_scope VALUES(?,?)').run(key,now);
  return Number(this.db.prepare('SELECT opened_at_ms FROM weekly_scope WHERE scope_key=?').get(key)!.opened_at_ms);
 }
 retain(key:string,events:WeeklyEvent[],days:SupplementalDay[]){
  this.db.exec('BEGIN IMMEDIATE');
  try{
   const insert=this.db.prepare('INSERT OR IGNORE INTO weekly_evidence VALUES(?,?,?)');
   for(const event of events)insert.run(key,event.event_id,JSON.stringify(minimal(event)));
   const get=this.db.prepare('SELECT day_json FROM weekly_supplement WHERE scope_key=? AND date=?');
   const upsert=this.db.prepare('INSERT OR REPLACE INTO weekly_supplement VALUES(?,?,?)');
   for(const day of days){
    if(!validDate(day.date)||!day.available||day.total_seconds===null||!Number.isFinite(day.total_seconds)||day.total_seconds<0||day.total_seconds>86400||!Number.isSafeInteger(day.updated_at_ms)||day.updated_at_ms!<=0)continue;
    const row=get.get(key,day.date);const prior=row?JSON.parse(String(row.day_json)) as SupplementalDay:null;
    // Only unlocated reward counters go in this table; located windows stay in evidence.
    if(!prior||(prior.total_seconds??-1)<day.total_seconds||((prior.total_seconds??-1)===day.total_seconds&&(prior.updated_at_ms??0)<(day.updated_at_ms??0)))upsert.run(key,day.date,JSON.stringify(day));
   }
   this.db.exec('COMMIT');
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 evidence(key:string):WeeklyEvent[]{return this.db.prepare('SELECT event_json FROM weekly_evidence WHERE scope_key=? ORDER BY event_id').all(key).map(x=>JSON.parse(String(x.event_json)));}
 supplements(key:string):SupplementalDay[]{return this.db.prepare('SELECT day_json FROM weekly_supplement WHERE scope_key=? ORDER BY date').all(key).map(x=>JSON.parse(String(x.day_json)));}
 report(key:string,week:string):WeeklyReport|null{const row=this.db.prepare('SELECT report_json FROM weekly_report WHERE scope_key=? AND week_start=?').get(key,week);return row?JSON.parse(String(row.report_json)):null;}
 weeks(key:string):string[]{return this.db.prepare('SELECT week_start FROM weekly_report WHERE scope_key=?').all(key).map(x=>String(x.week_start));}
 save(key:string,publicId:string,calculation:WeeklyCalculation,now:number):WeeklyReport{
  const periodEnd=Date.parse(dateAdd(calculation.week_start,7)+'T00:00:00+08:00'),publishAt=periodEnd-2*3600000;
  const phase=now<publishAt?'collecting':now<periodEnd?'early':'ended';
  const fingerprint=digest({calculation,phase});
  const existing=this.db.prepare('SELECT fingerprint,report_json FROM weekly_report WHERE scope_key=? AND week_start=?').get(key,calculation.week_start);
  if(existing?.fingerprint===fingerprint)return JSON.parse(String(existing.report_json));
  const prior=existing?JSON.parse(String(existing.report_json)) as WeeklyReport:null;
  const isPublished=now>=publishAt,publishedAt=prior?.published_at_ms??(isPublished?now:null);
  const report:WeeklyReport={...calculation,report_id:'wr_'+digest([key,calculation.week_start]).slice(0,24),
   status:!isPublished?'collecting':prior?.published_at_ms?'revised':'published',revision:(prior?.revision??0)+1,
   published_at_ms:publishedAt,updated_at_ms:now,generated_at_ms:now,scheduled_publish_at_ms:publishAt,
   period_end_ms:periodEnd,data_cutoff_at_ms:Math.min(now,periodEnd),scope:{kind:'device',public_id:publicId}};
  this.db.exec('BEGIN IMMEDIATE');
  try{
   this.db.prepare('INSERT OR REPLACE INTO weekly_report VALUES(?,?,?,?)').run(key,calculation.week_start,fingerprint,JSON.stringify(report));
   const saveDay=this.db.prepare('INSERT OR REPLACE INTO weekly_day VALUES(?,?,?)');
   for(const day of calculation.daily)saveDay.run(key,day.date,JSON.stringify(day));
   this.db.exec('COMMIT');
  }catch(error){this.db.exec('ROLLBACK');throw error;}
  return report;
 }
 close(){this.db.close();}
}
let singleton:WeeklyReportStore|undefined;
export function weeklyReportStore(){return singleton??=new WeeklyReportStore(process.env.WEEKLY_REPORTS_DB_PATH??'./data/weekly-reports.db');}
