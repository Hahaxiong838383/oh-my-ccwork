import {DatabaseSync} from 'node:sqlite';
import {statfsSync} from 'node:fs';
import {createHash,createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {z} from 'zod';
import {isDeviceCredentialBindingAllowed,type DeviceCredentialState} from '../device-credential.js';
import {canonical,limits,RecordsError,emptyCoverage,dashboardRecords,type BusinessRecord,type RecordQuery} from './records-contract.js';
import {projectLegacyRecord,legacyIncomeGrants,legacyActivations,legacyHasAcquisition,type LegacyRecord} from './records-legacy.js';

type Identity={sn:string;public_id:string;account_id:string;parent_account_id:string;binding_version:number;epoch:number;grant_id:string;not_before_ms:number};
export type Credential={sn:string;iat:number;exp:number;bindingVersion?:number};
type Options={arkPath:string;devicesPath:string;allowed:(sn:string)=>boolean;validAccount:(id:string)=>boolean;validParentAccount?:(id:string)=>boolean;secret:()=>string};
type Row={ingest_id:number;sn:string;record_id:string;save_id:string;sequence:number;origin_parent_account_id:string;origin_device_account_id:string;origin_epoch:number;origin_grant_id:string;body:string;received_at_ms:number;sort_ms:number;time_status:'reported'|'unknown'|'clock_suspect'};
type Cursor={v:1;scope:string;filter:string;water:number;legacy_water?:number;expires:number;last:[number,string,number,string]};
type LegacyRow={ingest_id:number;sn:string;record_id:string;save_id:string;sequence:number;scope_key:string;body:string;body_hash:string;payload_bytes:number;received_at_ms:number;sort_ms:number;time_status:Row['time_status'];coverage_from_ms:number;dropped_records:number};
const legacyId=z.string().min(1).max(96).regex(/^[A-Za-z0-9_.:-]+$/);
const LegacyScopeSchema=z.object({sn:z.string(),public_id:z.string(),account_id:z.string().min(1),parent_account_id:z.string().min(1),binding_version:z.number().int().nonnegative().safe(),epoch:z.number().int().positive().safe(),grant_id:z.string().uuid(),save_ids:z.union([z.literal('*'),z.array(legacyId).min(1).max(128)])}).strict();
type LegacyScope=z.infer<typeof LegacyScopeSchema>;
type LegacyEnvelope={save_id:string;coverage_from_ms:number;dropped_records:number};
const sortRows=(a:{sort_ms:number;save_id:string;sequence:number;record_id:string},b:typeof a)=>b.sort_ms-a.sort_ms||(a.save_id<b.save_id?-1:a.save_id>b.save_id?1:0)||b.sequence-a.sequence||(a.record_id<b.record_id?-1:a.record_id>b.record_id?1:0);
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
  PRIMARY KEY(scope,kind,window_ms,bucket));
 CREATE TABLE IF NOT EXISTS ark_record_legacy(
  ingest_id INTEGER PRIMARY KEY AUTOINCREMENT,sn TEXT NOT NULL,record_id TEXT NOT NULL,save_id TEXT NOT NULL,sequence INTEGER NOT NULL,
  scope_key TEXT NOT NULL,body TEXT NOT NULL,body_hash TEXT NOT NULL,payload_bytes INTEGER NOT NULL,received_at_ms INTEGER NOT NULL,
  sort_ms INTEGER NOT NULL,time_status TEXT NOT NULL,occurred_day TEXT,coverage_from_ms INTEGER NOT NULL,dropped_records INTEGER NOT NULL,
  UNIQUE(sn,record_id),UNIQUE(sn,save_id,sequence));
 CREATE INDEX IF NOT EXISTS ark_record_legacy_page ON ark_record_legacy(sn,scope_key,sort_ms DESC,save_id,sequence DESC,record_id);
 CREATE TRIGGER IF NOT EXISTS ark_record_legacy_usage_insert AFTER INSERT ON ark_record_legacy BEGIN
  INSERT INTO ark_record_usage VALUES(NEW.sn,1,NEW.payload_bytes) ON CONFLICT(scope) DO UPDATE SET records=records+1,bytes=bytes+NEW.payload_bytes;
  UPDATE ark_record_usage SET records=records+1,bytes=bytes+NEW.payload_bytes WHERE scope='*'; END;`);
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
  const i=this.db.prepare(`SELECT d.sn,d.public_id,d.account_id,d.parent_account_id,d.binding_version,e.epoch,g.grant_id,g.not_before_ms
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
 private legacyScope(i:Identity):{scope:LegacyScope;key:string}|null{
  const raw=process.env.ARK_RECORDS_LEGACY_SCOPE_JSON?.trim();if(!raw)return null;
  let scope:LegacyScope;try{scope=LegacyScopeSchema.parse(JSON.parse(raw));}catch{throw new RecordsError(503,'records_configuration_invalid');}
  const {save_ids,...identity}=scope;
  if(Object.entries(identity).some(([k,v])=>i[k as keyof Identity]!==v))return null;
  if(this.o.validParentAccount&&!this.o.validParentAccount(i.parent_account_id))return null;
  if(this.db.prepare('SELECT COUNT(*) n FROM devices.device_registry WHERE account_id=?').get(i.account_id)!.n!==1)return null;
  // The immutable key represents explicit read/import authorization, never a claimed original owner.
  return {scope,key:createHash('sha256').update(canonical(scope)).digest('hex')};
 }
 private requireLegacy(i:Identity,save?:string){const s=this.legacyScope(i);if(!s||(save&&s.scope.save_ids!=='*'&&!s.scope.save_ids.includes(save)))throw new RecordsError(403,'legacy_scope_not_authorized');return s;}
 legacyUploadEnabled(sn:string){const i=this.identity(sn);if(!i||!this.legacyScope(i))return false;return this.authorizedRead(i.public_id,i.parent_account_id,current=>this.legacyScope(current)!==null);}
 preflightLegacy(c:Credential,save:string){return this.transaction(()=>{const i=this.device(c),s=this.requireLegacy(i,save);this.rate(c.sn,'upload',Date.now());return s.key;});}
 acceptLegacy(c:Credential,expected:string,b:LegacyEnvelope,r:LegacyRecord):string{return this.transaction(()=>{
  const i=this.device(c),s=this.requireLegacy(i,r.save_id);if(s.key!==expected)throw new RecordsError(403,'legacy_scope_not_authorized');
  const body=canonical(r),hash=createHash('sha256').update(body).digest('hex');
  const old=this.db.prepare('SELECT * FROM ark_record_legacy WHERE sn=? AND record_id=?').get(i.sn,r.record_id) as LegacyRow|undefined;
  if(old){if(old.scope_key!==s.key)throw new RecordsError(403,'legacy_scope_not_authorized');if(old.body_hash!==hash||old.body!==body)return 'record_id_conflict';if(old.coverage_from_ms!==b.coverage_from_ms)return 'coverage_start_conflict';
   this.db.prepare('UPDATE ark_record_legacy SET dropped_records=MAX(dropped_records,?) WHERE sn=? AND scope_key=? AND save_id=?').run(b.dropped_records,i.sn,s.key,r.save_id);return 'duplicate';}
  if(this.record(i.sn,r.record_id))return 'record_id_conflict';
  if(this.db.prepare('SELECT 1 FROM ark_record WHERE sn=? AND save_id=? AND sequence=? UNION ALL SELECT 1 FROM ark_record_legacy WHERE sn=? AND save_id=? AND sequence=?').get(i.sn,r.save_id,r.sequence,i.sn,r.save_id,r.sequence))return 'sequence_conflict';
  const prior=this.db.prepare('SELECT MIN(coverage_from_ms) started,MAX(dropped_records) dropped FROM ark_record_legacy WHERE sn=? AND scope_key=? AND save_id=?').get(i.sn,s.key,r.save_id) as {started:number|null;dropped:number|null};
  if(prior.started!==null&&prior.started!==b.coverage_from_ms)return 'coverage_start_conflict';
  const l=limits(),bytes=Buffer.byteLength(body),usage=(scope:string)=>this.db.prepare('SELECT records,bytes FROM ark_record_usage WHERE scope=?').get(scope) as {records:number;bytes:number}|undefined;
  const per=usage(i.sn),all=usage('*');
  if((per?.records??0)>=l.per_sn_records||(per?.bytes??0)+bytes>l.per_sn_payload_bytes||(all?.records??0)>=l.global_records||(all?.bytes??0)+bytes>l.global_payload_bytes)throw new RecordsError(503,'capacity_exceeded');
  const fs=statfsSync(this.o.arkPath,{bigint:true});if(fs.bavail*fs.bsize<BigInt(l.min_free_disk_bytes)+BigInt(bytes*4+65536))throw new RecordsError(503,'capacity_exceeded');
  const now=Date.now(),status=r.occurred_at_ms<=0?'unknown':r.occurred_at_ms>now+l.future_clock_tolerance_ms?'clock_suspect':'reported',sort=status==='reported'?r.occurred_at_ms:0;
  this.db.prepare(`INSERT INTO ark_record_legacy(sn,record_id,save_id,sequence,scope_key,body,body_hash,payload_bytes,received_at_ms,sort_ms,time_status,occurred_day,coverage_from_ms,dropped_records) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(i.sn,r.record_id,r.save_id,r.sequence,s.key,body,hash,bytes,now,sort,status,sort?new Date(sort+8*3600000).toISOString().slice(0,10):null,b.coverage_from_ms,Math.max(prior.dropped??0,b.dropped_records));
  this.db.prepare('UPDATE ark_record_legacy SET dropped_records=MAX(dropped_records,?) WHERE sn=? AND scope_key=? AND save_id=?').run(b.dropped_records,i.sn,s.key,r.save_id);
  return 'accepted';
 });}
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
  const acquiredIds=r.item_changes.filter(x=>x.operation==='acquired').map(x=>x.item_instance_id);
  const missingItem=acquiredIds.length?`x.item_instance_id NOT IN (${acquiredIds.map(()=>'?').join(',')})`:'1';
  // Do not materialize a full activation body for each of its up to 32 items.
  // This EXISTS-style query holds at most one small result, including at capacity.
  const conflict=this.db.prepare(`SELECT 1 FROM ark_record_item x JOIN ark_record p ON p.sn=x.sn AND p.record_id=x.record_id
   WHERE x.sn=? AND x.acquired_record_id=? AND
   (p.save_id<>? OR p.origin_parent_account_id<>? OR p.origin_device_account_id<>? OR p.origin_epoch<>? OR p.origin_grant_id<>? OR p.sequence<=? OR ${missingItem}) LIMIT 1`)
   .get(i.sn,r.record_id,r.save_id,i.parent_account_id,i.account_id,i.epoch,i.grant_id,r.sequence,...acquiredIds);
  if(conflict)return false;
  return true;
 }
 accept(c:Credential,expected:Identity,r:BusinessRecord):string{return this.transaction(()=>{
  const i=this.device(c);if(!this.sameIdentity(i,expected))throw new RecordsError(403,'origin_context_mismatch');this.origin(i,r);
  const body=canonical(r),old=this.record(i.sn,r.record_id);
  if(old)return old.body===body?'duplicate':'record_id_conflict';
  if(this.db.prepare('SELECT 1 FROM ark_record_legacy WHERE sn=? AND record_id=?').get(i.sn,r.record_id))return 'record_id_conflict';
  if(this.db.prepare('SELECT 1 FROM ark_record_legacy WHERE sn=? AND save_id=? AND sequence=?').get(i.sn,r.save_id,r.sequence))return 'sequence_conflict';
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
 private scope(i:Identity){return canonical([i.public_id,i.parent_account_id,i.account_id,i.binding_version,i.epoch,i.grant_id,this.legacyScope(i)?.key??null]);}
 private authorizedRead<T>(publicId:string,owner:string,fn:(i:Identity)=>T):T{
  let scope:string;const result=this.transaction(()=>{const i=this.parent(publicId,owner);scope=this.scope(i);return fn(i);});
  // ATTACH/WAL can hold independent snapshots. Release them before the final authority check.
  if(this.scope(this.parent(publicId,owner))!==scope!)throw new RecordsError(404,'not_found');return result;
 }
 private cursorKey(){const secret=this.o.secret();if(!secret)throw new RecordsError(503,'records_dependency_unavailable');return createHash('sha256').update('p003.ark.records.r1.cursor\0'+secret).digest();}
 private encodeCursor(c:Cursor){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.cursorKey(),iv),body=Buffer.concat([cipher.update(JSON.stringify(c),'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64url');}
 private decodeCursor(s:string):Cursor{try{if(!/^[A-Za-z0-9_-]+$/.test(s))throw Error();const b=Buffer.from(s,'base64url'),d=createDecipheriv('aes-256-gcm',this.cursorKey(),b.subarray(0,12));d.setAuthTag(b.subarray(12,28));const c=JSON.parse(Buffer.concat([d.update(b.subarray(28)),d.final()]).toString());if(c.v!==1||!Number.isSafeInteger(c.water)||c.water<0||(c.legacy_water!==undefined&&(!Number.isSafeInteger(c.legacy_water)||c.legacy_water<0))||!Number.isSafeInteger(c.expires)||!Array.isArray(c.last)||c.last.length!==4)throw Error();return c;}catch{throw new RecordsError(400,'invalid_cursor');}}
 private where(i:Identity,q:Omit<RecordQuery,'cursor'|'limit'>,water:number){
  let sql='r.sn=? AND r.origin_parent_account_id=? AND r.origin_device_account_id=? AND r.origin_epoch=? AND r.origin_grant_id=? AND r.ingest_id<=?';const args:(string|number)[]=[i.sn,i.parent_account_id,i.account_id,i.epoch,i.grant_id,water];
  if(q.save_id){sql+=' AND r.save_id=?';args.push(q.save_id);}if(q.resource_id){sql+=' AND EXISTS(SELECT 1 FROM ark_record_resource x WHERE x.sn=r.sn AND x.record_id=r.record_id AND x.resource_id=?)';args.push(q.resource_id);}
  if(q.from_day){sql+=' AND r.occurred_day>=?';args.push(q.from_day);}if(q.to_day){sql+=' AND r.occurred_day<=?';args.push(q.to_day);}return {sql,args};
 }
 private coverage(where:ReturnType<RecordsStore['where']>){const r=this.db.prepare(`SELECT MIN(NULLIF(r.sort_ms,0)) min_occurred_at_ms,MAX(NULLIF(r.sort_ms,0)) max_occurred_at_ms,MIN(r.received_at_ms) first_received_at_ms,MAX(r.received_at_ms) last_received_at_ms FROM ark_record r WHERE ${where.sql}`).get(...where.args);return {...emptyCoverage(),...r} as ReturnType<typeof emptyCoverage>;}
 private water(){return Number(this.db.prepare('SELECT COALESCE(MAX(ingest_id),0) n FROM ark_record').get()!.n);}
 private legacyWater(){return Number(this.db.prepare('SELECT COALESCE(MAX(ingest_id),0) n FROM ark_record_legacy').get()!.n);}
 private legacyWhere(i:Identity,q:Omit<RecordQuery,'cursor'|'limit'>,water:number){
  const s=this.legacyScope(i);if(!s)return {sql:'0',args:[] as (string|number)[]};
  let sql='r.sn=? AND r.scope_key=? AND r.ingest_id<=?';const args:(string|number)[]=[i.sn,s.key,water];
  if(s.scope.save_ids!=='*'){sql+=` AND r.save_id IN (${s.scope.save_ids.map(()=>'?').join(',')})`;args.push(...s.scope.save_ids);}
  if(q.save_id){sql+=' AND r.save_id=?';args.push(q.save_id);}
  if(q.from_day){sql+=' AND r.occurred_day>=?';args.push(q.from_day);}
  if(q.to_day){sql+=' AND r.occurred_day<=?';args.push(q.to_day);}
  if(q.resource_id){sql+=" AND (EXISTS(SELECT 1 FROM json_each(r.body,'$.data.wallet_changes') c WHERE json_extract(c.value,'$.resource_id')=?)";args.push(q.resource_id==='family_coin'?'C-FAMILY-001':q.resource_id==='stardust'?'C-STARDUST-001':q.resource_id);
   if(q.resource_id==='M-CARD-001')sql+=" OR EXISTS(SELECT 1 FROM json_each(r.body,'$.data.inventory_changes') c WHERE json_extract(c.value,'$.item_id')='M-CARD-001')";sql+=')';}
  return {sql,args};
 }
 private mergedCoverage(where:ReturnType<RecordsStore['where']>,legacy:ReturnType<RecordsStore['legacyWhere']>){
  const a=this.coverage(where),b=this.db.prepare(`SELECT MIN(NULLIF(sort_ms,0)) min_occurred_at_ms,MAX(NULLIF(sort_ms,0)) max_occurred_at_ms,MIN(received_at_ms) first_received_at_ms,MAX(received_at_ms) last_received_at_ms FROM ark_record_legacy r WHERE ${legacy.sql}`).get(...legacy.args) as any;
  const result={...a};for(const key of ['min_occurred_at_ms','first_received_at_ms'] as const){const values=[a[key],b[key]].filter((v):v is number=>v!==null);result[key]=values.length?Math.min(...values):null;}
  for(const key of ['max_occurred_at_ms','last_received_at_ms'] as const){const values=[a[key],b[key]].filter((v):v is number=>v!==null);result[key]=values.length?Math.max(...values):null;}
  const c=this.db.prepare(`SELECT MIN(started) coverage_from_ms,SUM(dropped) dropped_records FROM (SELECT save_id,MIN(coverage_from_ms) started,MAX(dropped_records) dropped FROM ark_record_legacy r WHERE ${legacy.sql} GROUP BY save_id)`).get(...legacy.args) as any;
  return b.last_received_at_ms===null?result:{...result,coverage_from_ms:c.coverage_from_ms,dropped_records:c.dropped_records??0};
 }
 page(publicId:string,owner:string,q:RecordQuery){return this.authorizedRead(publicId,owner,i=>this.pageForIdentity(i,q));}
 /** Shared projection keeps the dashboard's recent page within the same authorization snapshot. */
 private pageForIdentity(i:Identity,q:RecordQuery){
  const {cursor,limit,...filters}=q,filter=canonical({limit,...filters}),scope=this.scope(i),now=Date.now();
  const c=cursor?this.decodeCursor(cursor):null;
  if(c&&(c.scope!==scope||c.filter!==filter))throw new RecordsError(400,'invalid_cursor');if(c&&c.expires<=now)throw new RecordsError(410,'cursor_expired');
  const water=c?.water??this.water(),legacy_water=c?.legacy_water??(c?0:this.legacyWater()),where=this.where(i,filters,water),legacy=this.legacyWhere(i,filters,legacy_water),coverage=this.mergedCoverage(where,legacy),afterArgs:(number|string)[]=[];let after='';
  if(c){const [sort,save,sequence,id]=c.last;after=' AND (r.sort_ms<? OR (r.sort_ms=? AND (r.save_id>? OR (r.save_id=? AND (r.sequence<? OR (r.sequence=? AND r.record_id>?))))))';afterArgs.push(sort,sort,save,save,sequence,sequence,id);}
  const original=this.db.prepare(`SELECT r.* FROM ark_record r WHERE ${where.sql}${after} ORDER BY r.sort_ms DESC,r.save_id ASC,r.sequence DESC,r.record_id ASC LIMIT ?`).all(...where.args,...afterArgs,limit+1) as Row[];
  const old=this.db.prepare(`SELECT r.* FROM ark_record_legacy r WHERE ${legacy.sql}${after} ORDER BY r.sort_ms DESC,r.save_id ASC,r.sequence DESC,r.record_id ASC LIMIT ?`).all(...legacy.args,...afterArgs,limit+1) as LegacyRow[];
  const rows=[...original,...old].sort(sortRows),has_more=rows.length>limit,visible=rows.slice(0,limit);
  const items=visible.map(row=>{
   if('scope_key' in row)return {...projectLegacyRecord(JSON.parse(row.body)),received_at_ms:row.received_at_ms,time_status:row.time_status,item_references:[]};
   const {origin_grant_id,origin_epoch,...r}=JSON.parse(row.body) as BusinessRecord;return {...r,received_at_ms:row.received_at_ms,time_status:row.time_status,item_references:r.item_changes.filter(x=>x.operation==='activated').map(x=>{if(x.operation!=='activated')throw Error('unreachable');const a=this.record(i.sn,x.acquired_record_id);return {item_instance_id:x.item_instance_id,acquired_record_id:x.acquired_record_id,status:a&&a.ingest_id<=water&&this.referenceMatches(i,JSON.parse(row.body),a,x.item_instance_id)?'resolved':'pending'};})};});
  const last=visible.at(-1),next_cursor=has_more&&last?this.encodeCursor({v:1,scope,filter,water,legacy_water,expires:c?.expires??now+limits().cursor_ttl_ms,last:[last.sort_ms,last.save_id,last.sequence,last.record_id]}):null;
  return {schema_version:1,items,next_cursor,has_more,coverage,updated_at_ms:coverage.last_received_at_ms};
 }
 private summaries(where:ReturnType<RecordsStore['where']>,legacy:ReturnType<RecordsStore['legacyWhere']>,coverage:ReturnType<typeof emptyCoverage>,now:number){
  const result=dashboardRecords(coverage,'no_records',now);
  const from=Date.parse(`${result.yesterday_income.date}T00:00:00+08:00`),to=from+86400000;
  // Existing v1 aggregation stays in SQLite. Absence is NULL, not measured zero.
  const income=this.db.prepare(`SELECT
   SUM(CASE WHEN json_extract(c.value,'$.resource_id')='family_coin' THEN json_extract(c.value,'$.delta') END) family_coin,
   SUM(CASE WHEN json_extract(c.value,'$.resource_id')='stardust' THEN json_extract(c.value,'$.delta') END) stardust,
   MIN(r.sort_ms) occurred_from_ms,MAX(r.sort_ms) occurred_to_ms,MAX(r.received_at_ms) received_at_ms
   FROM ark_record r JOIN json_each(r.body,'$.resource_changes') c
   WHERE ${where.sql} AND r.time_status='reported' AND r.sort_ms>=? AND r.sort_ms<?
    AND r.reason IN ('reward_claim','tank_unlock') AND json_extract(r.body,'$.source_mode')='normal'
    AND json_extract(c.value,'$.resource_id') IN ('family_coin','stardust') AND json_extract(c.value,'$.delta')>0`)
   .get(...where.args,from,to) as {family_coin:number|null;stardust:number|null;occurred_from_ms:number|null;occurred_to_ms:number|null;received_at_ms:number|null};
  type Candidate=Pick<Row,'sn'|'record_id'|'save_id'|'sequence'|'sort_ms'|'received_at_ms'|'time_status'>&{legacy:boolean};
  const candidates=new Map<string,Candidate>();
  let unknownAcquisitionClock=false;
  const choose=(row:Candidate)=>{const old=candidates.get(row.save_id);if(!old||row.sequence>old.sequence)candidates.set(row.save_id,row);if(row.time_status!=='reported')unknownAcquisitionClock=true;};
  const hasAcquired="EXISTS(SELECT 1 FROM ark_record_item x WHERE x.sn=r.sn AND x.record_id=r.record_id AND x.operation='acquired')";
  if(this.db.prepare(`SELECT 1 FROM ark_record r WHERE ${where.sql} AND r.time_status<>'reported' AND ${hasAcquired} LIMIT 1`).get(...where.args))unknownAcquisitionClock=true;
  // Keep one descriptor per save, not every body or just the single v1 winner.
  // A legacy record can supersede that v1 winner by sequence with an earlier clock.
  for(const raw of this.db.prepare(`SELECT r.sn,r.record_id,r.save_id,r.sequence,r.sort_ms,r.received_at_ms,r.time_status FROM ark_record r JOIN (
    SELECT r.sn,r.save_id,MAX(r.sequence) sequence FROM ark_record r WHERE ${where.sql} AND ${hasAcquired}
    GROUP BY r.sn,r.save_id
   ) newest ON r.sn=newest.sn AND r.save_id=newest.save_id AND r.sequence=newest.sequence`).iterate(...where.args))choose({...raw,legacy:false} as Candidate);
  type IncomeGrant=ReturnType<typeof legacyIncomeGrants>[number];
  const grants=new Map<string,{fingerprint:string;source_mode:string;conflict:boolean;sequence:number;inDay:boolean;eligible?:IncomeGrant;received_at_ms:number}>();
  // Bounded by the shared raw-payload capacity; iterate so all raw bodies are never
  // materialized together. All grants participate in conflict checks, including GM,
  // unknown, unmatched-wallet and outside-window records.
  for(const raw of this.db.prepare(`SELECT r.* FROM ark_record_legacy r WHERE ${legacy.sql}`).iterate(...legacy.args)){
   const row=raw as LegacyRow,record=JSON.parse(row.body) as LegacyRecord;
   if(legacyHasAcquisition(record))choose({sn:row.sn,record_id:row.record_id,save_id:row.save_id,sequence:row.sequence,sort_ms:row.sort_ms,received_at_ms:row.received_at_ms,time_status:row.time_status,legacy:true});
   if(record.record_kind!=='business_commit')continue;
   const eligible=new Map((row.time_status==='reported'?legacyIncomeGrants(record):[]).map(g=>[g.reward_instance_id,g]));
   for(const grant of record.data.grants){
    const key=canonical([record.save_id,grant.reward_instance_id]),fingerprint=createHash('sha256').update(canonical(grant)).digest('hex');
    const inDay=row.time_status==='reported'&&row.sort_ms>=from&&row.sort_ms<to,old=grants.get(key),value=eligible.get(grant.reward_instance_id);
    if(old){old.conflict ||= old.fingerprint!==fingerprint||old.source_mode!==record.source_mode;
     // The smallest business sequence supplies both occurrence day and evidence.
     // Neither arrival order nor a later duplicate can improve an unproven first
     // occurrence, move it across midnight, or replace a missing original clock.
     if(record.sequence<old.sequence){old.sequence=record.sequence;old.inDay=inDay;old.eligible=value&&inDay?value:undefined;old.received_at_ms=row.received_at_ms;}
    }else grants.set(key,{fingerprint,source_mode:record.source_mode,conflict:false,sequence:record.sequence,inDay,eligible:value&&inDay?value:undefined,received_at_ms:row.received_at_ms});
   }
  }
  let conflictingIncome=false;
  for(const entry of grants.values()){
   if(entry.conflict){conflictingIncome ||= entry.inDay;continue;}
   if(!entry.eligible)continue;
   const grant=entry.eligible;
   for(const currency of ['family_coin','stardust'] as const)if(grant[currency]!==null)income[currency]=(income[currency]??0)+grant[currency]!;
   income.occurred_from_ms=income.occurred_from_ms===null?grant.occurred_at_ms:Math.min(income.occurred_from_ms,grant.occurred_at_ms);
   income.occurred_to_ms=income.occurred_to_ms===null?grant.occurred_at_ms:Math.max(income.occurred_to_ms,grant.occurred_at_ms);
   income.received_at_ms=Math.max(income.received_at_ms??0,entry.received_at_ms);
  }
  for(const value of [income.family_coin,income.stardust])if(value!==null&&!Number.isSafeInteger(value))throw new RecordsError(503,'records_dependency_unavailable');
  if(income.family_coin!==null||income.stardust!==null)Object.assign(result.yesterday_income,income,{available:true,reason:'partial_history',source_mode:'normal'});
  else if(conflictingIncome)result.yesterday_income.reason='conflicting_reward';
  if(unknownAcquisitionClock){result.latest_items.reason='clock_unknown';return result;}
  const latest=[...candidates.values()].sort(sortRows)[0];if(!latest)return result;
  const selected=this.db.prepare(`SELECT body FROM ${latest.legacy?'ark_record_legacy':'ark_record'} WHERE sn=? AND record_id=?`).get(latest.sn,latest.record_id) as {body:string};
  const original=JSON.parse(selected.body) as LegacyRecord|BusinessRecord;
  const record=latest.legacy?projectLegacyRecord(original as LegacyRecord):original as BusinessRecord;
  if(record.source_mode!=='normal'){result.latest_items.reason='non_normal';return result;}
  const acquired=(record.item_changes as BusinessRecord['item_changes']).filter((item):item is Extract<BusinessRecord['item_changes'][number],{operation:'acquired'}>=>item.operation==='acquired');
  if(!acquired.length){result.latest_items.reason='unverified_acquisition';return result;}
  const activations=new Map<string,string>();
  if(!latest.legacy){
   // v1 activation references remain exact and scoped to the original instance.
   const rows=this.db.prepare(`SELECT newest.item_instance_id,a.record_id FROM (
    SELECT x.item_instance_id,MAX(r.sequence) sequence FROM ark_record_item x JOIN ark_record r ON r.sn=x.sn AND r.record_id=x.record_id
    WHERE ${where.sql} AND x.acquired_record_id=? AND x.operation='activated'
     AND x.item_instance_id IN (${acquired.map(()=>'?').join(',')}) AND r.save_id=? AND r.sequence>?
     AND r.time_status='reported' AND r.reason='item_activation' AND json_extract(r.body,'$.source_mode')='normal'
    GROUP BY x.item_instance_id
   ) newest JOIN ark_record a ON a.sn=? AND a.save_id=? AND a.sequence=newest.sequence`)
    .all(...where.args,record.record_id,...acquired.map(x=>x.item_instance_id),record.save_id,record.sequence,latest.sn,record.save_id) as {item_instance_id:string;record_id:string}[];
   for(const row of rows)activations.set(row.item_instance_id,row.record_id);
  }
  // Legacy inventory is keyed by item_id. Its aggregate state can only update a
  // legacy acquisition, never stand in for a v1 instance's exact activation reference.
  if(latest.legacy)for(const raw of this.db.prepare(`SELECT r.body,r.record_id FROM ark_record_legacy r WHERE ${legacy.sql}
   AND r.save_id=? AND r.sequence>? AND r.time_status='reported'
   AND json_extract(r.body,'$.source_mode')='normal' ORDER BY r.sequence ASC`).iterate(...legacy.args,record.save_id,record.sequence)){
   const row=raw as {body:string;record_id:string},active=legacyActivations(JSON.parse(row.body) as LegacyRecord);
   for(const item of acquired)if(active.some(a=>a.item_id===item.item_id))activations.set(item.item_instance_id,row.record_id);
  }
  const items=acquired.map(item=>({item_instance_id:item.item_instance_id,item_id:item.item_id,item_kind:item.item_kind,quantity:item.quantity,
   state:activations.has(item.item_instance_id)?'active' as const:item.state,activation_record_id:activations.get(item.item_instance_id)??null}));
  Object.assign(result.latest_items,{available:true,reason:'partial_history',source_mode:'normal',record_id:record.record_id,
   save_id:record.save_id,occurred_at_ms:record.occurred_at_ms,received_at_ms:latest.received_at_ms,items});
  return result;
 }
 dashboard(publicId:string,owner:string){
  try{return this.authorizedRead(publicId,owner,i=>{
   const where=this.where(i,{},this.water()),legacy=this.legacyWhere(i,{},this.legacyWater());
   const result=this.summaries(where,legacy,this.mergedCoverage(where,legacy),Date.now());
   const recent=this.pageForIdentity(i,{limit:20});
   return {...result,recent_activity:{...recent,source:'ark_records' as const,available:recent.items.length>0,
    reason:recent.items.length?'partial_history':'no_records',limit:20}};
  });}catch(e){if(e instanceof RecordsError&&e.status===404)return dashboardRecords(emptyCoverage(),'not_enabled');throw e;}
 }
}
