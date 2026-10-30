import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname,resolve } from 'node:path';
import type { SessionWire } from './listening-http-contract.js';
import { LISTENING_HTTP_LIMITS,listeningDigest } from './listening-http-contract.js';
import type { ListeningConfig,ListeningScene,ListeningTuning } from './listening-settings.js';
export class ListeningError extends Error {
 constructor(public code:string,public status:number=403,public retryable=false){super(code);}
}
export interface ListeningSnapshot {revision:number;scenes:ListeningScene[];tuning:ListeningTuning;limits:typeof LISTENING_HTTP_LIMITS;sha256:string}
export function listeningSnapshot(config:ListeningConfig):ListeningSnapshot {
 const value={revision:config.revision,scenes:[...config.scenes],tuning:{...config.tuning},limits:{...LISTENING_HTTP_LIMITS}};
 return {...value,sha256:listeningDigest(value)};
}
export interface AuthoritySession extends SessionWire {
 device_epoch:number;worker_account:string;agent:string;build_sha:string;source:'normal'|'search_canary';
 source_cutoff_ms:number;source_generation:number;credential_iat:number;credential_expires_ms:number;expires_at_ms:number;grant_hash:string;supports:string[];
}
export interface Entry {session_id:string;listening_id:string;seq:number;scene:ListeningScene;mode_epoch:number;started_ms:number;deadline_ms:number;lease_until_ms:number;closed:number;snapshot:ListeningSnapshot;last_feedback_at:number|null}
export interface RequestRecord {request_id:string;hash:string;kind:string;status:string;created_ms:number;reply_json:string|null}
/** Lives beside registry: epoch triggers and registration share the same database/transaction.
 * Tables contain authorization metadata only; transcripts, model text and plaintext grants never persist.
 */
export class ListeningAuthorityStore {
 private db:DatabaseSync;
 constructor(path:string){mkdirSync(dirname(resolve(path)),{recursive:true});this.db=new DatabaseSync(path);
  this.db.exec(`PRAGMA busy_timeout=1000;PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;
   CREATE TABLE IF NOT EXISTS listening_device_epochs(sn TEXT PRIMARY KEY,epoch INTEGER NOT NULL);
   CREATE TRIGGER IF NOT EXISTS listening_registry_change AFTER UPDATE OF account_id,status ON device_registry
    WHEN OLD.account_id IS NOT NEW.account_id OR OLD.status IS NOT NEW.status BEGIN
    INSERT INTO listening_device_epochs VALUES(NEW.sn,1) ON CONFLICT(sn) DO UPDATE SET epoch=epoch+1;END;
   CREATE TRIGGER IF NOT EXISTS listening_registry_delete AFTER DELETE ON device_registry BEGIN
    INSERT INTO listening_device_epochs VALUES(OLD.sn,1) ON CONFLICT(sn) DO UPDATE SET epoch=epoch+1;END;
   CREATE TABLE IF NOT EXISTS listening_sessions(session_id TEXT PRIMARY KEY,sn TEXT NOT NULL,expires_ms INTEGER NOT NULL,payload_json TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS listening_entries(session_id TEXT NOT NULL REFERENCES listening_sessions(session_id) ON DELETE CASCADE,
    listening_id TEXT NOT NULL,seq INTEGER NOT NULL,scene TEXT NOT NULL,mode_epoch INTEGER NOT NULL,started_ms INTEGER NOT NULL,
    deadline_ms INTEGER NOT NULL,lease_until_ms INTEGER NOT NULL DEFAULT 0,closed INTEGER NOT NULL DEFAULT 0,snapshot_json TEXT NOT NULL,
    last_feedback_at INTEGER,PRIMARY KEY(session_id,listening_id));
   CREATE TABLE IF NOT EXISTS listening_requests(session_id TEXT NOT NULL REFERENCES listening_sessions(session_id) ON DELETE CASCADE,
    listening_id TEXT NOT NULL,request_id TEXT NOT NULL,hash TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,epoch INTEGER NOT NULL,
    created_ms INTEGER NOT NULL,reply_json TEXT,PRIMARY KEY(session_id,request_id));
   CREATE TABLE IF NOT EXISTS listening_feedback_epochs(session_id TEXT NOT NULL REFERENCES listening_sessions(session_id) ON DELETE CASCADE,
    listening_id TEXT NOT NULL,epoch INTEGER NOT NULL,PRIMARY KEY(session_id,listening_id,epoch));
   CREATE TABLE IF NOT EXISTS listening_closed_entries(session_id TEXT NOT NULL REFERENCES listening_sessions(session_id) ON DELETE CASCADE,
    listening_id TEXT NOT NULL,seq INTEGER NOT NULL,mode_epoch INTEGER NOT NULL,PRIMARY KEY(session_id,listening_id));
   CREATE TABLE IF NOT EXISTS listening_revocations(session_id TEXT PRIMARY KEY REFERENCES listening_sessions(session_id) ON DELETE CASCADE,reason TEXT NOT NULL,at_ms INTEGER NOT NULL);`);
 }
 close(){this.db.close();}
 private transaction<T>(fn:()=>T):T {this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 device(sn:string){const row=this.db.prepare(`SELECT d.sn,d.status,d.account_id,COALESCE(e.epoch,0) AS epoch,
  r.not_before_sec FROM device_registry d LEFT JOIN listening_device_epochs e ON e.sn=d.sn
  LEFT JOIN device_credential_revocation r ON r.sn=d.sn WHERE d.sn=?`).get(sn) as any;
  return row?{sn:row.sn,status:row.status,accountId:row.account_id,epoch:row.epoch,credentialNotBefore:row.not_before_sec??null}:null;}
 register(value:AuthoritySession,now=Date.now()){this.transaction(()=>{
  const device=this.device(value.sn);
  if(!device||device.status!=='active'||device.accountId!==value.account_id||device.epoch!==value.device_epoch
   ||value.credential_iat<=(device.credentialNotBefore??-1))throw new ListeningError('device_changed');
  this.db.prepare('DELETE FROM listening_sessions WHERE expires_ms<=?').run(now);
  if(Number((this.db.prepare('SELECT COUNT(*) AS n FROM listening_sessions').get() as any).n)>=1000)throw new ListeningError('capacity_exceeded',429,true);
  this.db.prepare('INSERT INTO listening_sessions VALUES(?,?,?,?)').run(value.session_id,value.sn,value.expires_at_ms,JSON.stringify(value));
 });}
 session(id:string):AuthoritySession|null{const row=this.db.prepare('SELECT payload_json FROM listening_sessions WHERE session_id=?').get(id) as any;return row?JSON.parse(row.payload_json):null;}
 revoked(session:string){return !!this.db.prepare('SELECT 1 FROM listening_revocations WHERE session_id=?').get(session);}
 revoke(session:string,reason:string,now:number){this.transaction(()=>{
  this.db.prepare('INSERT OR IGNORE INTO listening_revocations VALUES(?,?,?)').run(session,reason,now);
  this.db.prepare('UPDATE listening_entries SET closed=1,lease_until_ms=0 WHERE session_id=?').run(session);
 });}
 entry(session:string,id:string):Entry|null {const row=this.db.prepare('SELECT * FROM listening_entries WHERE session_id=? AND listening_id=?').get(session,id) as any;
  if(!row)return null;const {snapshot_json,...value}=row;return {...value,snapshot:JSON.parse(snapshot_json)};}
 acquireEntry(session:string,id:string,scene:ListeningScene,epoch:number,snapshot:ListeningSnapshot,now:number):Entry {
  return this.transaction(()=>{let entry=this.entry(session,id);
   if(this.db.prepare('SELECT 1 FROM listening_closed_entries WHERE session_id=? AND listening_id=?').get(session,id))throw new ListeningError('entry_closed');
   const previous=this.db.prepare(`SELECT MAX(seq) AS seq,MAX(mode_epoch) AS epoch FROM (
    SELECT seq,mode_epoch FROM listening_entries WHERE session_id=? UNION ALL SELECT seq,mode_epoch FROM listening_closed_entries WHERE session_id=?)`).get(session,session) as any;
   if(epoch<(previous.epoch??0))throw new ListeningError('stale_epoch',409);
   if(entry){if(entry.closed)throw new ListeningError('entry_closed');if(entry.scene!==scene)throw new ListeningError('entry_conflict',409);
    if(epoch<entry.mode_epoch)throw new ListeningError('stale_epoch',409);
    if(now>=entry.deadline_ms)throw new ListeningError('entry_closed');
    if(epoch>entry.mode_epoch)this.db.prepare('UPDATE listening_entries SET mode_epoch=? WHERE session_id=? AND listening_id=?').run(epoch,session,id);
   }else{
    this.entryCapacity(session);
    const open=this.db.prepare('SELECT 1 FROM listening_entries WHERE session_id=? AND closed=0').get(session);
    const last=previous.seq??0;
    const seq=Number(id.slice(id.lastIndexOf(':')+1));if(open||seq<=last)throw new ListeningError('entry_conflict',409);
    this.db.prepare('INSERT INTO listening_entries(session_id,listening_id,seq,scene,mode_epoch,started_ms,deadline_ms,snapshot_json) VALUES(?,?,?,?,?,?,?,?)')
     .run(session,id,seq,scene,epoch,now,now+snapshot.tuning.max_session_sec*1000,JSON.stringify(snapshot));
   }
   return this.entry(session,id)!;
  });
 }
 setLease(session:string,id:string,until:number){this.db.prepare('UPDATE listening_entries SET lease_until_ms=? WHERE session_id=? AND listening_id=? AND closed=0').run(until,session,id);}
 closeEntry(session:string,id:string,epoch:number){this.transaction(()=>{const entry=this.entry(session,id);
  if(!entry){const prior=this.db.prepare('SELECT mode_epoch FROM listening_closed_entries WHERE session_id=? AND listening_id=?').get(session,id) as any;
   if(!prior)this.entryCapacity(session);
   if(prior&&epoch<prior.mode_epoch)throw new ListeningError('stale_epoch',409);
   this.db.prepare('INSERT INTO listening_closed_entries VALUES(?,?,?,?) ON CONFLICT(session_id,listening_id) DO UPDATE SET mode_epoch=MAX(mode_epoch,excluded.mode_epoch)')
    .run(session,id,Number(id.slice(id.lastIndexOf(':')+1)),epoch);return;}
  if(epoch<entry.mode_epoch)throw new ListeningError('stale_epoch',409);
  this.db.prepare('UPDATE listening_entries SET closed=1,lease_until_ms=0,mode_epoch=? WHERE session_id=? AND listening_id=?').run(epoch,session,id);
 });}
 private entryCapacity(session:string){const row=this.db.prepare(`SELECT (SELECT COUNT(*) FROM listening_entries WHERE session_id=?)+(SELECT COUNT(*) FROM listening_closed_entries WHERE session_id=?) AS n`).get(session,session) as any;
  if(Number(row.n)>=128)throw new ListeningError('capacity_exceeded',429,true);}
 request(session:string,id:string):RequestRecord|null{return this.db.prepare('SELECT * FROM listening_requests WHERE session_id=? AND request_id=?').get(session,id) as unknown as RequestRecord??null;}
 recordReply(session:string,entry:string,id:string,hash:string,kind:string,epoch:number,now:number,reply:any){return this.transaction(()=>{
  const old=this.request(session,id);if(old){if(old.hash!==hash||old.kind!==kind)throw new ListeningError('request_conflict',409);return old.reply_json?JSON.parse(old.reply_json):null;}
  if(kind==='lease'){const current=this.entry(session,entry);if(!current||current.closed||current.deadline_ms<=now)throw new ListeningError('entry_closed');
   if(current.mode_epoch!==epoch)throw new ListeningError('stale_epoch',409);
   if(current.lease_until_ms>0&&current.lease_until_ms<=now)throw new ListeningError('entry_closed');
   if(reply.authorized)this.setLease(session,entry,reply.lease_expires_at_ms);}
  this.capacity(session);this.db.prepare("INSERT INTO listening_requests VALUES(?,?,?,?,?,'done',?,?,?)").run(session,entry,id,hash,kind,epoch,now,JSON.stringify(reply));return reply;
 });}
 private capacity(session:string){if(Number((this.db.prepare('SELECT COUNT(*) AS n FROM listening_requests WHERE session_id=?').get(session) as any).n)>=2048)throw new ListeningError('capacity_exceeded',429,true);}
 claimContent(session:string,entry:string,id:string,hash:string,kind:string,epoch:number,now:number,cooldown:number):RequestRecord|null {
  return this.transaction(()=>{const old=this.request(session,id);if(old){if(old.hash!==hash||old.kind!==kind)throw new ListeningError('request_conflict',409);return old;}
   const current=this.entry(session,entry);if(!current||current.closed||current.deadline_ms<=now)throw new ListeningError('entry_closed');
   if(current.mode_epoch!==epoch)throw new ListeningError('stale_epoch',409);
   this.db.prepare("UPDATE listening_requests SET status='failed' WHERE status='running' AND created_ms<=?").run(now-8000);
   if(this.db.prepare("SELECT 1 FROM listening_requests WHERE session_id=? AND listening_id=? AND status='running'").get(session,entry))throw new ListeningError('content_busy',409,true);
   if(Number((this.db.prepare("SELECT COUNT(*) AS n FROM listening_requests WHERE status='running'").get() as any).n)>=4)throw new ListeningError('capacity_exceeded',429,true);
   if(kind==='feedback'){
    if(this.db.prepare('SELECT 1 FROM listening_feedback_epochs WHERE session_id=? AND listening_id=? AND epoch=?').get(session,entry,epoch))throw new ListeningError('request_spent',409);
    const last=this.entry(session,entry)?.last_feedback_at;if(last!=null&&now-last<cooldown)throw new ListeningError('feedback_cooldown',429,true);
    this.db.prepare('INSERT INTO listening_feedback_epochs VALUES(?,?,?)').run(session,entry,epoch);
    this.db.prepare('UPDATE listening_entries SET last_feedback_at=? WHERE session_id=? AND listening_id=?').run(now,session,entry);
   }
   this.capacity(session);this.db.prepare("INSERT INTO listening_requests VALUES(?,?,?,?,?,'running',?,?,NULL)").run(session,entry,id,hash,kind,epoch,now);return null;
  });
 }
 finishContent(session:string,id:string,status:'done'|'failed'){return this.db.prepare("UPDATE listening_requests SET status=? WHERE session_id=? AND request_id=? AND status='running'").run(status,session,id).changes===1;}
 activeCount(now:number){return Number((this.db.prepare('SELECT COUNT(*) AS n FROM listening_entries WHERE closed=0 AND lease_until_ms>? AND deadline_ms>?').get(now,now) as any).n);}
}
