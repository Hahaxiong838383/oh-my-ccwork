import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonicalJson} from '../analytics/contracts.js';
import {snapshotSchema,type ArkSnapshot,type ArkCurrent} from './contracts.js';
import type {ArkIdentity} from './identity.js';
import {installArkArchive,appendArkCheckpoint,type ArkArchivePolicy} from './archive.js';
export type ArkGrant=ArkIdentity&{grant_id:string;not_before_ms:number};
export class ArkStore{
 readonly db:DatabaseSync;
 constructor(path:string,private admission?:{run:<T>(fn:()=>T)=>T;limit:()=>number},private archivePolicy?:()=>ArkArchivePolicy){mkdirSync(dirname(path),{recursive:true,mode:0o700});this.db=new DatabaseSync(path);chmodSync(path,0o600);this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=15;
 CREATE TABLE IF NOT EXISTS ark_settings(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL);
 INSERT OR IGNORE INTO ark_settings(id,enabled) VALUES(1,0);
 CREATE TABLE IF NOT EXISTS ark_grant(sn TEXT PRIMARY KEY,account_id TEXT NOT NULL,epoch INTEGER NOT NULL,grant_id TEXT NOT NULL,not_before_ms INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS ark_current(sn TEXT PRIMARY KEY,grant_id TEXT NOT NULL,body TEXT NOT NULL,received_at_ms INTEGER NOT NULL);`);
 if(!(this.db.prepare('PRAGMA table_info(ark_settings)').all() as {name:string}[]).some(x=>x.name==='revision'))this.db.exec('ALTER TABLE ark_settings ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');installArkArchive(this.db);}
 close(){this.db.close();}
 settings(){const row=this.db.prepare('SELECT enabled,revision FROM ark_settings WHERE id=1').get() as {enabled:number;revision:number};return {enabled:!!row.enabled,revision:row.revision,subjects:(this.db.prepare('SELECT sn FROM ark_grant ORDER BY sn').all() as {sn:string}[]).map(x=>x.sn)};}
 configure(enabled:boolean,identities:ArkIdentity[],now:number,expectedRevision?:number){
  if(identities.length>1000||new Set(identities.map(i=>i.sn)).size!==identities.length)throw new Error('invalid_scope');
  return this.mutate(()=>{this.db.exec('BEGIN IMMEDIATE');try{
   if(expectedRevision!==undefined&&this.settings().revision!==expectedRevision)throw new Error('settings_conflict');
   const previous=this.settings();
   if(enabled&&(!previous.enabled||identities.some(i=>!previous.subjects.includes(i.sn)))&&identities.length>(this.admission?.limit()??1000))throw new Error('STORAGE_CAPACITY_LIMIT');
   const keep=new Map((enabled?identities:[]).map(i=>[i.sn,i]));
   for(const old of this.db.prepare('SELECT * FROM ark_grant').all() as ArkGrant[]){
    const next=keep.get(old.sn);
    if(!next||next.account_id!==old.account_id||next.epoch!==old.epoch){this.db.prepare('DELETE FROM ark_current WHERE sn=?').run(old.sn);this.db.prepare('DELETE FROM ark_grant WHERE sn=?').run(old.sn);}
   }
   if(enabled)for(const i of identities)this.db.prepare('INSERT OR IGNORE INTO ark_grant VALUES(?,?,?,?,?)').run(i.sn,i.account_id,i.epoch,randomUUID(),now);
   this.db.prepare('UPDATE ark_settings SET enabled=?,revision=revision+1 WHERE id=1').run(enabled?1:0);this.db.exec('COMMIT');
  }catch(e){this.db.exec('ROLLBACK');throw e;}});
 }
 private mutate<T>(fn:()=>T):T{return this.admission?this.admission.run(fn):fn();}
 /** Atomic one-device grant: never reauthorizes another stale identity from an admin's old list. */
 authorize(i:ArkIdentity,now:number,expectedRevision?:number){
  return this.mutate(()=>{this.db.exec('BEGIN IMMEDIATE');try{
   if(expectedRevision!==undefined&&this.settings().revision!==expectedRevision)throw new Error('settings_conflict');
   const old=this.db.prepare('SELECT * FROM ark_grant WHERE sn=?').get(i.sn) as ArkGrant|undefined;
   if(!old&&this.settings().subjects.length>=(this.admission?.limit()??1000))throw new Error('STORAGE_CAPACITY_LIMIT');
   if(!old||old.account_id!==i.account_id||old.epoch!==i.epoch){
    this.db.prepare('DELETE FROM ark_current WHERE sn=?').run(i.sn);
    this.db.prepare('INSERT INTO ark_grant VALUES(?,?,?,?,?) ON CONFLICT(sn) DO UPDATE SET account_id=excluded.account_id,epoch=excluded.epoch,grant_id=excluded.grant_id,not_before_ms=excluded.not_before_ms').run(i.sn,i.account_id,i.epoch,randomUUID(),now);
   }
   this.db.exec('UPDATE ark_settings SET enabled=1,revision=revision+1 WHERE id=1;COMMIT');
  }catch(e){this.db.exec('ROLLBACK');throw e;}});
 }
 grant(i:ArkIdentity):ArkGrant|null{
  if(!this.settings().enabled)return null;
  const r=this.db.prepare('SELECT * FROM ark_grant WHERE sn=? AND account_id=? AND epoch=?').get(i.sn,i.account_id,i.epoch) as ArkGrant|undefined;return r??null;
 }
 current(i:ArkIdentity):ArkCurrent|null{
  const g=this.grant(i);if(!g)return null;
  const r=this.db.prepare('SELECT body,received_at_ms FROM ark_current WHERE sn=? AND grant_id=?').get(i.sn,g.grant_id) as {body:string;received_at_ms:number}|undefined;
  return r?{snapshot:snapshotSchema.parse(JSON.parse(r.body)),received_at_ms:r.received_at_ms}:null;
 }
 /** HTTP owns asynchronous retry. Never sleep in SQLite's busy callback on that path. */
 tryAccept(i:ArkIdentity,snapshot:ArkSnapshot,now:number){
  const previous=Number(this.db.prepare('PRAGMA busy_timeout').get()!.timeout);
  this.db.exec('PRAGMA busy_timeout=0');
  try{return this.accept(i,snapshot,now);}
  finally{this.db.exec(`PRAGMA busy_timeout=${previous}`);}
 }
 accept(i:ArkIdentity,snapshot:ArkSnapshot,now:number):{status:'accepted'|'duplicate';received_at_ms:number}{
  // Config is read before taking the Ark write lock (config -> Ark lock order).
  const archive=this.archivePolicy?.();
  this.db.exec('BEGIN IMMEDIATE');try{
   const g=this.grant(i);if(!g)throw new Error('not_authorized');
   if(snapshot.captured_at_ms>now+2000||snapshot.captured_at_ms<now-86400000)throw new Error('clock_invalid');
   if(snapshot.captured_at_ms<g.not_before_ms)throw new Error('before_grant');
   const old=this.current(i),body=canonicalJson(snapshot);
   if(old){const p=old.snapshot;
    if(snapshot.boot_started_at_ms<p.boot_started_at_ms||snapshot.captured_at_ms<p.captured_at_ms)throw new Error('stale');
    if(snapshot.boot_id===p.boot_id){
     if(snapshot.boot_started_at_ms!==p.boot_started_at_ms||snapshot.sequence<p.sequence)throw new Error('stale');
     if(snapshot.snapshot_id===p.snapshot_id||snapshot.sequence===p.sequence){
      if(snapshot.snapshot_id===p.snapshot_id&&snapshot.sequence===p.sequence&&canonicalJson(p)===body){this.db.exec('COMMIT');return {status:'duplicate',received_at_ms:old.received_at_ms};}
      throw new Error('conflict');
     }
    }else if(snapshot.boot_started_at_ms<=p.boot_started_at_ms)throw new Error('stale');
   }
   if(archive)appendArkCheckpoint(this.db,g,snapshot,now,archive);
   this.db.prepare('INSERT INTO ark_current VALUES(?,?,?,?) ON CONFLICT(sn) DO UPDATE SET grant_id=excluded.grant_id,body=excluded.body,received_at_ms=excluded.received_at_ms').run(i.sn,g.grant_id,body,now);
   this.db.exec('COMMIT');return {status:'accepted',received_at_ms:now};
  }catch(e){if(this.db.isTransaction)this.db.exec('ROLLBACK');throw e;}
 }
}
