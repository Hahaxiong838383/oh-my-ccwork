import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';

export const amapAdjustmentSchema=z.object({
 request_id:z.string().uuid(),mode:z.enum(['add','set_remaining']),
 amount:z.number().int().min(0).max(100_000_000),expected_revision:z.number().int().nonnegative(),
}).strict().refine(v=>v.mode!=='add'||v.amount>0);
type Adjustment=z.infer<typeof amapAdjustmentSchema>;
type Kind='weather'|'geocode';
type Outcome='success'|'rejected'|'unknown';

/** Local conservative estimate, NOT an Amap account balance. No key, IP,
 * device identity, place or user text is stored. Each outbound attempt counts;
 * cache hits and coalesced subscribers do not create new attempts. */
export class AmapUsageStore {
 private db:DatabaseSync;
 constructor(path:string,private now:()=>number=Date.now){
  if(path!==':memory:')mkdirSync(dirname(path),{recursive:true,mode:0o700});
  this.db=new DatabaseSync(path);this.db.exec(`PRAGMA busy_timeout=100; PRAGMA journal_mode=WAL;
   CREATE TABLE IF NOT EXISTS amap_meta(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);
   INSERT OR IGNORE INTO amap_meta VALUES(1,0);
   CREATE TABLE IF NOT EXISTS amap_credit(id TEXT PRIMARY KEY,body TEXT NOT NULL,delta INTEGER NOT NULL,who TEXT NOT NULL,at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS amap_request(id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('weather','geocode')),at INTEGER NOT NULL,outcome TEXT NOT NULL CHECK(outcome IN ('unknown','success','rejected')),code TEXT);
   CREATE INDEX IF NOT EXISTS amap_request_kind ON amap_request(kind);`);
 }
 close(){this.db.close();}
 private tx<T>(fn:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const r=fn();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 private bump(){this.db.exec('UPDATE amap_meta SET revision=revision+1 WHERE id=1');}
 private counts(){
  const row=this.db.prepare(`SELECT
   (SELECT revision FROM amap_meta WHERE id=1) revision,
   (SELECT COALESCE(SUM(delta),0) FROM amap_credit) registered_total,
   COUNT(CASE WHEN kind='weather' THEN 1 END) weather_requests,
   COUNT(CASE WHEN kind='geocode' THEN 1 END) geocode_requests,
   COUNT(CASE WHEN kind='weather' AND outcome='success' THEN 1 END) weather_successes,
   COUNT(CASE WHEN kind='weather' AND outcome='rejected' THEN 1 END) weather_rejected,
   COUNT(CASE WHEN kind='weather' AND outcome='unknown' THEN 1 END) weather_unconfirmed,
   MIN(at) first_request_at_ms,MAX(at) last_request_at_ms FROM amap_request`).get() as any;
  return {...row,remaining:Math.max(0,row.registered_total-row.weather_requests)};
 }
 snapshot(){
  // A read transaction keeps the counters and audit history on one snapshot.
  this.db.exec('BEGIN');try{
   const r={...this.counts(),estimate:true,observed_at_ms:this.now(),history:this.db.prepare('SELECT id,body,delta,who,at FROM amap_credit ORDER BY rowid DESC LIMIT 10').all().map((v:any)=>({...JSON.parse(v.body),delta:v.delta,who:v.who,at_ms:v.at}))};this.db.exec('COMMIT');return r;
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 adjust(raw:Adjustment,who:string){
  const v=amapAdjustmentSchema.parse(raw),body=JSON.stringify(v);
  return this.tx(()=>{
   const old=this.db.prepare('SELECT body,who FROM amap_credit WHERE id=?').get(v.request_id) as any;
   if(old){if(old.body!==body||old.who!==who)throw new Error('idempotency_conflict');return;}
   const current=this.counts();if(current.revision!==v.expected_revision)throw new Error('revision_conflict');
   const delta=v.mode==='add'?v.amount:v.amount-current.remaining;
   if(current.registered_total+delta>1_000_000_000)throw new Error('budget_too_large');
   this.db.prepare('INSERT INTO amap_credit VALUES(?,?,?,?,?)').run(v.request_id,body,delta,who.slice(0,100),this.now());this.bump();
  });
 }
 reserve(kind:Kind){
  return this.tx(()=>{
   if(kind==='weather'&&this.counts().remaining<1)throw new Error('quota_exhausted');
   const id=randomUUID();this.db.prepare('INSERT INTO amap_request VALUES(?,?,?,?,NULL)').run(id,kind,this.now(),'unknown');this.bump();return id;
  });
 }
 finish(id:string,outcome:Outcome,code?:string){
  this.db.prepare("UPDATE amap_request SET outcome=?,code=? WHERE id=? AND outcome='unknown'").run(outcome,code&&/^\d{5}$/.test(code)?code:null,id);
 }
}
