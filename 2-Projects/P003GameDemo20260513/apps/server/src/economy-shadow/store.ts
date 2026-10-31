import {DatabaseSync} from 'node:sqlite';
import {chmodSync,existsSync,lstatSync,readFileSync,writeFileSync} from 'node:fs';
import {canonical,sha256} from './contracts.js';
import type {ShadowReport} from './evaluate.js';
import {openReadOnly} from './source.js';
const MARKER='p003-economy-shadow-v1';
export class ShadowStore{
 readonly db:DatabaseSync;
 constructor(path:string){
  let st;try{st=lstatSync(path);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  if(st){
   if(st.isSymbolicLink()||!st.isFile()||st.nlink!==1)throw new Error('unsafe_shadow_path');
   const r=openReadOnly(path);try{
    if(r.prepare("SELECT value FROM shadow_meta WHERE key='format'").get()?.value!==MARKER||r.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().some(t=>!['shadow_meta','shadow_rule','shadow_run'].includes(String(t.name))))throw new Error('foreign_database');
   }finally{r.close();}
  }
  this.db=new DatabaseSync(path);chmodSync(path,0o600);
  this.db.exec(`PRAGMA busy_timeout=100; CREATE TABLE IF NOT EXISTS shadow_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
   INSERT OR IGNORE INTO shadow_meta VALUES('format','${MARKER}');
   CREATE TABLE IF NOT EXISTS shadow_rule(revision TEXT PRIMARY KEY,sha256 TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS shadow_run(run_id TEXT PRIMARY KEY,report_sha256 TEXT NOT NULL,report_json TEXT NOT NULL);`);
 }
 save(r:ShadowReport):'inserted'|'duplicate'{
  if(r.mode!=='shadow_only'||r.ready_for_settlement!==false||r.certified_eligible_ms!==null||!/^[a-f0-9]{64}$/.test(r.run_id))throw new Error('not_shadow_report');
  const body=canonical(r),hash=sha256(body);if(Buffer.byteLength(body)>1048576)throw new Error('report_too_large');
  this.db.exec('BEGIN IMMEDIATE');try{
   const old=this.db.prepare('SELECT report_sha256 FROM shadow_run WHERE run_id=?').get(r.run_id);
   if(old){if(old.report_sha256!==hash)throw new Error('run_content_conflict');this.db.exec('COMMIT');return 'duplicate';}
   if(Number(this.db.prepare('SELECT count(*) n FROM shadow_run').get()!.n)>=1000)throw new Error('shadow_archive_required');
   if(r.rule_candidate){const prev=this.db.prepare('SELECT sha256 FROM shadow_rule WHERE revision=?').get(r.rule_candidate.revision);
    if(prev&&prev.sha256!==r.rule_candidate.sha256)throw new Error('rule_revision_conflict');
    this.db.prepare('INSERT OR IGNORE INTO shadow_rule VALUES(?,?)').run(r.rule_candidate.revision,r.rule_candidate.sha256);
   }
   this.db.prepare('INSERT INTO shadow_run VALUES(?,?,?)').run(r.run_id,hash,body);this.db.exec('COMMIT');return 'inserted';
  }catch(e){if(this.db.isTransaction)this.db.exec('ROLLBACK');throw e;}
 }
 close(){this.db.close();}
}
/** Exclusive creation; existing audit artifacts are never overwritten, including symlinks. */
export function writeReport(path:string,text:string){
 if(existsSync(path)){const st=lstatSync(path);if(st.isSymbolicLink()||!st.isFile()||st.nlink!==1||readFileSync(path,'utf8')!==text)throw new Error('report_path_conflict');return;}
 writeFileSync(path,text,{flag:'wx',mode:0o600});
}
