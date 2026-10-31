import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonicalJson} from '../analytics/contracts.js';
import {snapshotSchema,type ArkSnapshot,type ArkCurrent} from './contracts.js';
import type {ArkIdentity} from './identity.js';
export type ArkGrant=ArkIdentity&{grant_id:string;not_before_ms:number};
export class ArkStore{
 readonly db:DatabaseSync;
 constructor(path:string){mkdirSync(dirname(path),{recursive:true,mode:0o700});this.db=new DatabaseSync(path);chmodSync(path,0o600);this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=15;
 CREATE TABLE IF NOT EXISTS ark_settings(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL);
 INSERT OR IGNORE INTO ark_settings VALUES(1,0);
 CREATE TABLE IF NOT EXISTS ark_grant(sn TEXT PRIMARY KEY,account_id TEXT NOT NULL,epoch INTEGER NOT NULL,grant_id TEXT NOT NULL,not_before_ms INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS ark_current(sn TEXT PRIMARY KEY,grant_id TEXT NOT NULL,body TEXT NOT NULL,received_at_ms INTEGER NOT NULL);`);}
 close(){this.db.close();}
 settings(){return {enabled:!!(this.db.prepare('SELECT enabled FROM ark_settings WHERE id=1').get() as {enabled:number}).enabled,subjects:(this.db.prepare('SELECT sn FROM ark_grant ORDER BY sn').all() as {sn:string}[]).map(x=>x.sn)};}
 configure(enabled:boolean,identities:ArkIdentity[],now:number){
  if(identities.length>32||new Set(identities.map(i=>i.sn)).size!==identities.length)throw new Error('invalid_scope');
  this.db.exec('BEGIN IMMEDIATE');try{
   this.db.exec('DELETE FROM ark_current; DELETE FROM ark_grant');
   if(enabled)for(const i of identities)this.db.prepare('INSERT INTO ark_grant VALUES(?,?,?,?,?)').run(i.sn,i.account_id,i.epoch,randomUUID(),now);
   this.db.prepare('UPDATE ark_settings SET enabled=? WHERE id=1').run(enabled?1:0);this.db.exec('COMMIT');
  }catch(e){this.db.exec('ROLLBACK');throw e;}
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
 accept(i:ArkIdentity,snapshot:ArkSnapshot,now:number):{status:'accepted'|'duplicate';received_at_ms:number}{
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
   this.db.prepare('INSERT INTO ark_current VALUES(?,?,?,?) ON CONFLICT(sn) DO UPDATE SET grant_id=excluded.grant_id,body=excluded.body,received_at_ms=excluded.received_at_ms').run(i.sn,g.grant_id,body,now);
   this.db.exec('COMMIT');return {status:'accepted',received_at_ms:now};
  }catch(e){if(this.db.isTransaction)this.db.exec('ROLLBACK');throw e;}
 }
}
