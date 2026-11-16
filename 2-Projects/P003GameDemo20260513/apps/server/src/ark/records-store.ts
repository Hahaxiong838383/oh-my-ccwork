import {DatabaseSync} from 'node:sqlite';
import {statfsSync} from 'node:fs';
import {createHash,createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {isDeviceCredentialBindingAllowed,type DeviceCredentialState} from '../device-credential.js';
import {canonical,limits,RecordsError,emptyCoverage,dashboardRecords,type BusinessRecord,type RecordQuery} from './records-contract.js';

type Identity={sn:string;public_id:string;account_id:string;parent_account_id:string;epoch:number;grant_id:string;not_before_ms:number};
export type Credential={sn:string;iat:number;exp:number;bindingVersion?:number};
type Options={arkPath:string;devicesPath:string;allowed:(sn:string)=>boolean;validAccount:(id:string)=>boolean;secret:()=>string};
type Row={ingest_id:number;sn:string;record_id:string;save_id:string;sequence:number;origin_parent_account_id:string;origin_device_account_id:string;origin_epoch:number;origin_grant_id:string;body:string;received_at_ms:number;sort_ms:number;time_status:'reported'|'unknown'|'clock_suspect'};
type Cursor={v:1;scope:string;filter:string;water:number;expires:number;last:[number,string,number,string]};
/** One synchronous connection owns the authorization + write linearization point.
 * ATTACH participates in BEGIN IMMEDIATE; devices is never modified by this class.
 * No awaited IO/body parsing while the transaction is open. */
export class RecordsStore{
 readonly db:DatabaseSync;
 constructor(private o:Options){
  this.db=new DatabaseSync(o.arkPath);this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=40; PRAGMA synchronous=FULL;');
  this.db.prepare('ATTACH DATABASE ? AS devices').run(o.devicesPath);
  this.db.exec(`
 CREATE TABLE IF NOT EXISTS ark_record(
  ingest_id INTEGER PRIMARY KEY AUTOINCREMENT,sn TEXT NOT NULL,record_id TEXT NOT NULL,save_id TEXT NOT NULL,sequence INTEGER NOT NULL,
  origin_parent_account_id TEXT NOT NULL,origin_device_account_id TEXT NOT NULL,origin_epoch INTEGER NOT NULL,origin_grant_id TEXT NOT NULL,
  reason TEXT NOT NULL,business_source_id TEXT,body TEXT NOT NULL,payload_bytes INTEGER NOT NULL,
  received_at_ms INTEGER NOT NULL,time_status TEXT NOT NULL,sort_ms INTEGER NOT NULL,occurred_day TEXT,
  UNIQUE(sn,record_id),UNIQUE(sn,save_id,sequence));
 CREATE UNIQUE INDEX IF NOT EXISTS ark_record_source ON ark_record(sn,save_id,reason,business_source_id)
  WHERE reason IN ('reward_claim','tank_unlock','makeup_card_use','resource_spend','item_activation');
 CREATE INDEX IF NOT EXISTS ark_record_page ON ark_record(sn,origin_parent_account_id,origin_epoch,origin_grant_id,sort_ms DESC,save_id,sequence DESC,record_id);
 CREATE TABLE IF NOT EXISTS ark_record_resource(sn TEXT NOT NULL,record_id TEXT NOT NULL,resource_id TEXT NOT NULL,
  PRIMARY KEY(sn,record_id,resource_id),FOREIGN KEY(sn,record_id) REFERENCES ark_record(sn,record_id));
 CREATE INDEX IF NOT EXISTS ark_record_resource_filter ON ark_record_resource(sn,resource_id,record_id);
 CREATE TABLE IF NOT EXISTS ark_record_item(sn TEXT NOT NULL,record_id TEXT NOT NULL,save_id TEXT NOT NULL,item_instance_id TEXT NOT NULL,
  operation TEXT NOT NULL,acquired_record_id TEXT,PRIMARY KEY(sn,record_id,item_instance_id),FOREIGN KEY(sn,record_id) REFERENCES ark_record(sn,record_id));
 CREATE UNIQUE INDEX IF NOT EXISTS ark_record_item_acquired ON ark_record_item(sn,save_id,item_instance_id) WHERE operation='acquired';
 CREATE INDEX IF NOT EXISTS ark_record_item_reference ON ark_record_item(sn,acquired_record_id);
 CREATE TABLE IF NOT EXISTS ark_record_usage(scope TEXT PRIMARY KEY,records INTEGER NOT NULL,bytes INTEGER NOT NULL);
 INSERT OR IGNORE INTO ark_record_usage SELECT '*',COUNT(*),COALESCE(SUM(payload_bytes),0) FROM ark_record;
 INSERT OR IGNORE INTO ark_record_usage SELECT sn,COUNT(*),SUM(payload_bytes) FROM ark_record GROUP BY sn;
 CREATE TRIGGER IF NOT EXISTS ark_record_usage_insert AFTER INSERT ON ark_record BEGIN
  INSERT INTO ark_record_usage VALUES(NEW.sn,1,NEW.payload_bytes) ON CONFLICT(scope) DO UPDATE SET records=records+1,bytes=bytes+NEW.payload_bytes;
  UPDATE ark_record_usage SET records=records+1,bytes=bytes+NEW.payload_bytes WHERE scope='*'; END;
 CREATE TABLE IF NOT EXISTS ark_record_rate(scope TEXT NOT NULL,kind TEXT NOT NULL,window_ms INTEGER NOT NULL,bucket INTEGER NOT NULL,hits INTEGER NOT NULL,
  PRIMARY KEY(scope,kind,window_ms,bucket));`);
 }
 close(){this.db.close();}
 private transaction<T>(fn:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(e){if(this.db.isTransaction)this.db.exec('ROLLBACK');throw e;}}
 credentialState(sn:string):DeviceCredentialState{
  const r=this.db.prepare('SELECT binding_policy,binding_version,status,parent_account_id FROM devices.device_registry WHERE sn=?').get(sn) as any;
  const p=this.db.prepare('SELECT binding_policy,binding_version FROM devices.device_binding_state WHERE sn=?').get(sn) as any;
  const binding=r?(p&&p.binding_policy!=='legacy'?{...r,binding_policy:r.binding_policy==='legacy'?p.binding_policy:r.binding_policy,binding_version:Math.max(r.binding_version,p.binding_version)}:r):(p&&p.binding_policy!=='legacy'?{...p,status:'disabled',parent_account_id:null}:null);
  const rev=this.db.prepare('SELECT not_before_sec FROM devices.device_credential_revocation WHERE sn=?').get(sn) as {not_before_sec:number}|undefined;
  return {binding,revokedThroughSec:rev?.not_before_sec??null};
 }
 private checkCredential(c:Credential){const s=this.credentialState(c.sn),now=Math.floor(Date.now()/1000);
  if(!Number.isSafeInteger(c.iat)||c.iat<=0||c.iat>now||!Number.isSafeInteger(c.exp)||c.exp<=now||c.exp<=c.iat||!isDeviceCredentialBindingAllowed(s.binding,c.bindingVersion)||(s.revokedThroughSec!==null&&c.iat<=s.revokedThroughSec))throw new RecordsError(401,'invalid_device_credential');
 }
 private identity(sn:string):Identity|null{
  if(!this.o.allowed(sn))return null;
  const i=this.db.prepare(`SELECT d.sn,d.public_id,d.account_id,d.parent_account_id,e.epoch,g.grant_id,g.not_before_ms
   FROM devices.device_registry d JOIN devices.ark_device_epoch e ON e.sn=d.sn
   JOIN ark_grant g ON g.sn=d.sn AND g.account_id=d.account_id AND g.epoch=e.epoch
   JOIN ark_settings s ON s.id=1 AND s.enabled=1
   WHERE d.sn=? AND d.status='active' AND d.parent_account_id IS NOT NULL AND d.parent_account_id<>''`).get(sn) as Identity|undefined;
  return i&&this.o.validAccount(i.account_id)?i:null;
 }
 private device(c:Credential){this.checkCredential(c);const i=this.identity(c.sn);if(!i)throw new RecordsError(403,'not_enabled_or_authorized');return i;}
 private parent(publicId:string,owner:string){
  const d=this.db.prepare('SELECT sn FROM devices.device_registry WHERE public_id=? AND parent_account_id=? AND status=?').get(publicId,owner,'active') as {sn:string}|undefined;
  const i=d&&this.identity(d.sn);if(!i||i.parent_account_id!==owner)throw new RecordsError(404,'not_found');return i;
 }
 private origin(i:Identity,r:{origin_grant_id?:unknown;origin_epoch?:unknown}){if(r.origin_grant_id!==i.grant_id||r.origin_epoch!==i.epoch)throw new RecordsError(403,'origin_context_mismatch');}
 private rate(sn:string,kind:'context'|'upload',now:number){
  const l=limits(),rules: [string,number,number][]=kind==='context'?[[sn,60000,l.context_per_minute]]:[[sn,60000,l.upload_per_minute],[sn,3600000,l.upload_per_hour],['*',60000,l.global_upload_per_minute],['*',3600000,l.global_upload_per_hour]];
  this.db.prepare('DELETE FROM ark_record_rate WHERE bucket < CAST(? / window_ms AS INTEGER)-1').run(now);
  for(const [scope,window,max] of rules){const r=this.db.prepare('SELECT hits FROM ark_record_rate WHERE scope=? AND kind=? AND window_ms=? AND bucket=?').get(scope,kind,window,Math.floor(now/window)) as {hits:number}|undefined;if((r?.hits??0)>=max)throw new RecordsError(429,'rate_limited');}
  for(const [scope,window] of rules)this.db.prepare('INSERT INTO ark_record_rate VALUES(?,?,?,?,1) ON CONFLICT(scope,kind,window_ms,bucket) DO UPDATE SET hits=hits+1').run(scope,kind,window,Math.floor(now/window));
 }
 context(c:Credential){return this.transaction(()=>{const i=this.device(c),now=Date.now();this.rate(c.sn,'context',now);return {schema_version:1,contract_version:'p003.ark.records.r1',origin_grant_id:i.grant_id,origin_epoch:i.epoch,not_before_ms:i.not_before_ms,server_time_ms:now,limits:limits()};});}
 preflight(c:Credential,records:{origin_grant_id?:unknown;origin_epoch?:unknown}[]){return this.transaction(()=>{const i=this.device(c);for(const r of records)this.origin(i,r);this.rate(c.sn,'upload',Date.now());return i;});}
 private sameIdentity(a:Identity,b:Identity){return a.account_id===b.account_id&&a.parent_account_id===b.parent_account_id&&a.epoch===b.epoch&&a.grant_id===b.grant_id;}
 private record(sn:string,id:string){return this.db.prepare('SELECT * FROM ark_record WHERE sn=? AND record_id=?').get(sn,id) as Row|undefined;}
 private referenceMatches(i:Identity,r:BusinessRecord,acquired:Row,itemId:string){
  if(acquired.save_id!==r.save_id||acquired.origin_parent_account_id!==i.parent_account_id||acquired.origin_device_account_id!==i.account_id||acquired.origin_epoch!==i.epoch||acquired.origin_grant_id!==i.grant_id||acquired.sequence>=r.sequence)return false;
  return (JSON.parse(acquired.body) as BusinessRecord).item_changes.some(x=>x.operation==='acquired'&&x.item_instance_id===itemId);
 }
 private validReferences(i:Identity,r:BusinessRecord){
  for(const item of r.item_changes){
   if(item.operation==='activated'){
    const target=this.record(i.sn,item.acquired_record_id);if(target&&!this.referenceMatches(i,r,target,item.item_instance_id))return false;
    const acquired=this.db.prepare("SELECT record_id FROM ark_record_item WHERE sn=? AND save_id=? AND item_instance_id=? AND operation='acquired'").get(i.sn,r.save_id,item.item_instance_id) as {record_id:string}|undefined;
    if(acquired&&acquired.record_id!==item.acquired_record_id)return false;
   }else if(this.db.prepare("SELECT 1 FROM ark_record_item WHERE sn=? AND save_id=? AND item_instance_id=? AND operation='acquired'").get(i.sn,r.save_id,item.item_instance_id))return false;
  }
  // An already received activation referencing this ID must agree when its target arrives.
  const pending=this.db.prepare(`SELECT r.*,x.item_instance_id FROM ark_record_item x JOIN ark_record r ON r.sn=x.sn AND r.record_id=x.record_id WHERE x.sn=? AND x.acquired_record_id=?`).all(i.sn,r.record_id) as (Row&{item_instance_id:string})[];
  for(const p of pending)if(p.save_id!==r.save_id||p.origin_parent_account_id!==i.parent_account_id||p.origin_device_account_id!==i.account_id||p.origin_epoch!==i.epoch||p.origin_grant_id!==i.grant_id||p.sequence<=r.sequence||!r.item_changes.some(x=>x.operation==='acquired'&&x.item_instance_id===p.item_instance_id))return false;
  return true;
 }
 accept(c:Credential,expected:Identity,r:BusinessRecord):string{return this.transaction(()=>{
  const i=this.device(c);if(!this.sameIdentity(i,expected))throw new RecordsError(403,'origin_context_mismatch');this.origin(i,r);
  const body=canonical(r),old=this.record(i.sn,r.record_id);
  if(old)return old.body===body?'duplicate':'record_id_conflict';
  if(this.db.prepare('SELECT 1 FROM ark_record WHERE sn=? AND save_id=? AND sequence=?').get(i.sn,r.save_id,r.sequence))return 'sequence_conflict';
  if(!['unknown','gm_adjustment'].includes(r.reason)&&this.db.prepare('SELECT 1 FROM ark_record WHERE sn=? AND save_id=? AND reason=? AND business_source_id=?').get(i.sn,r.save_id,r.reason,r.business_source_id))return 'business_source_conflict';
  if(r.occurred_at_ms!==null&&r.occurred_at_ms<i.not_before_ms)return 'before_origin_grant';
  if(!this.validReferences(i,r))return 'item_reference_conflict';
  const l=limits(),bytes=Buffer.byteLength(body),u=(scope:string)=>this.db.prepare('SELECT records,bytes FROM ark_record_usage WHERE scope=?').get(scope) as {records:number;bytes:number}|undefined;
  const snUsage=u(i.sn),globalUsage=u('*');
  if((snUsage?.records??0)>=l.per_sn_records||(snUsage?.bytes??0)+bytes>l.per_sn_payload_bytes||(globalUsage?.records??0)>=l.global_records||(globalUsage?.bytes??0)+bytes>l.global_payload_bytes)return 'capacity_exceeded';
  const fs=statfsSync(this.o.arkPath,{bigint:true});if(fs.bavail*fs.bsize<BigInt(l.min_free_disk_bytes)+BigInt(bytes*4+65536))return 'capacity_exceeded';
  const now=Date.now(),status=r.occurred_at_ms===null?'unknown':r.occurred_at_ms>now+l.future_clock_tolerance_ms?'clock_suspect':'reported',sort=status==='reported'?r.occurred_at_ms!:0;
  this.db.prepare(`INSERT INTO ark_record(sn,record_id,save_id,sequence,origin_parent_account_id,origin_device_account_id,origin_epoch,origin_grant_id,reason,business_source_id,body,payload_bytes,received_at_ms,time_status,sort_ms,occurred_day) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(i.sn,r.record_id,r.save_id,r.sequence,i.parent_account_id,i.account_id,i.epoch,i.grant_id,r.reason,r.business_source_id,body,bytes,now,status,sort,sort?new Date(sort+8*3600000).toISOString().slice(0,10):null);
  for(const resource of r.resource_changes)this.db.prepare('INSERT INTO ark_record_resource VALUES(?,?,?)').run(i.sn,r.record_id,resource.resource_id);
  for(const item of r.item_changes)this.db.prepare('INSERT INTO ark_record_item VALUES(?,?,?,?,?,?)').run(i.sn,r.record_id,r.save_id,item.item_instance_id,item.operation,item.operation==='activated'?item.acquired_record_id:null);
  return 'accepted';
 });}
 private scope(i:Identity){return canonical([i.public_id,i.parent_account_id,i.account_id,i.epoch,i.grant_id]);}
 private cursorKey(){const secret=this.o.secret();if(!secret)throw new RecordsError(503,'records_dependency_unavailable');return createHash('sha256').update('p003.ark.records.r1.cursor\0'+secret).digest();}
 private encodeCursor(c:Cursor){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.cursorKey(),iv),body=Buffer.concat([cipher.update(JSON.stringify(c),'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64url');}
 private decodeCursor(s:string):Cursor{try{if(!/^[A-Za-z0-9_-]+$/.test(s))throw Error();const b=Buffer.from(s,'base64url'),d=createDecipheriv('aes-256-gcm',this.cursorKey(),b.subarray(0,12));d.setAuthTag(b.subarray(12,28));const c=JSON.parse(Buffer.concat([d.update(b.subarray(28)),d.final()]).toString());if(c.v!==1||!Number.isSafeInteger(c.water)||c.water<0||!Number.isSafeInteger(c.expires)||!Array.isArray(c.last)||c.last.length!==4)throw Error();return c;}catch{throw new RecordsError(400,'invalid_cursor');}}
 private where(i:Identity,q:Omit<RecordQuery,'cursor'|'limit'>,water:number){
  let sql='r.sn=? AND r.origin_parent_account_id=? AND r.origin_device_account_id=? AND r.origin_epoch=? AND r.origin_grant_id=? AND r.ingest_id<=?';const args:(string|number)[]=[i.sn,i.parent_account_id,i.account_id,i.epoch,i.grant_id,water];
  if(q.save_id){sql+=' AND r.save_id=?';args.push(q.save_id);}if(q.resource_id){sql+=' AND EXISTS(SELECT 1 FROM ark_record_resource x WHERE x.sn=r.sn AND x.record_id=r.record_id AND x.resource_id=?)';args.push(q.resource_id);}
  if(q.from_day){sql+=' AND r.occurred_day>=?';args.push(q.from_day);}if(q.to_day){sql+=' AND r.occurred_day<=?';args.push(q.to_day);}return {sql,args};
 }
 private coverage(where:ReturnType<RecordsStore['where']>){const r=this.db.prepare(`SELECT MIN(NULLIF(r.sort_ms,0)) min_occurred_at_ms,MAX(NULLIF(r.sort_ms,0)) max_occurred_at_ms,MIN(r.received_at_ms) first_received_at_ms,MAX(r.received_at_ms) last_received_at_ms FROM ark_record r WHERE ${where.sql}`).get(...where.args);return {...emptyCoverage(),...r} as ReturnType<typeof emptyCoverage>;}
 private water(){return Number(this.db.prepare('SELECT COALESCE(MAX(ingest_id),0) n FROM ark_record').get()!.n);}
 page(publicId:string,owner:string,q:RecordQuery){return this.transaction(()=>{
  const i=this.parent(publicId,owner),{cursor,limit,...filters}=q,filter=canonical({limit,...filters}),scope=this.scope(i),now=Date.now();
  const c=cursor?this.decodeCursor(cursor):null;
  if(c&&(c.scope!==scope||c.filter!==filter))throw new RecordsError(400,'invalid_cursor');if(c&&c.expires<=now)throw new RecordsError(410,'cursor_expired');
  const water=c?.water??this.water(),where=this.where(i,filters,water),coverage=this.coverage(where),args=[...where.args];let after='';
  if(c){const [sort,save,sequence,id]=c.last;after=' AND (r.sort_ms<? OR (r.sort_ms=? AND (r.save_id>? OR (r.save_id=? AND (r.sequence<? OR (r.sequence=? AND r.record_id>?))))))';args.push(sort,sort,save,save,sequence,sequence,id);}
  const rows=this.db.prepare(`SELECT r.* FROM ark_record r WHERE ${where.sql}${after} ORDER BY r.sort_ms DESC,r.save_id ASC,r.sequence DESC,r.record_id ASC LIMIT ?`).all(...args,limit+1) as Row[],has_more=rows.length>limit,visible=rows.slice(0,limit);
  const items=visible.map(row=>{const {origin_grant_id,origin_epoch,...r}=JSON.parse(row.body) as BusinessRecord;return {...r,received_at_ms:row.received_at_ms,time_status:row.time_status,item_references:r.item_changes.filter(x=>x.operation==='activated').map(x=>{if(x.operation!=='activated')throw Error('unreachable');const a=this.record(i.sn,x.acquired_record_id);return {item_instance_id:x.item_instance_id,acquired_record_id:x.acquired_record_id,status:a&&a.ingest_id<=water&&this.referenceMatches(i,JSON.parse(row.body),a,x.item_instance_id)?'resolved':'pending'};})};});
  const last=visible.at(-1),next_cursor=has_more&&last?this.encodeCursor({v:1,scope,filter,water,expires:c?.expires??now+limits().cursor_ttl_ms,last:[last.sort_ms,last.save_id,last.sequence,last.record_id]}):null;
  return {schema_version:1,items,next_cursor,has_more,coverage,updated_at_ms:coverage.last_received_at_ms};
 });}
 dashboard(publicId:string,owner:string){return this.transaction(()=>{let i:Identity;try{i=this.parent(publicId,owner);}catch(e){if(e instanceof RecordsError&&e.status===404)return dashboardRecords(emptyCoverage(),'not_enabled');throw e;}return dashboardRecords(this.coverage(this.where(i,{},this.water())));});}
}
