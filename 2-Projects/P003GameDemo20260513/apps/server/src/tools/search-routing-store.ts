import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';import {mkdirSync,chmodSync} from 'node:fs';import {dirname} from 'node:path';
import {routingConfigSchema,defaultRoutingConfig,type RoutingConfig} from './search-routing-config.js';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
export type RoutingSnapshot={version:string;config:RoutingConfig};
export class RoutingStore {
 private db:DatabaseSync;
 constructor(path:string,private now:()=>number=Date.now,private options:{allowGlobal?:boolean}={}){
  mkdirSync(dirname(path),{recursive:true,mode:0o700});this.db=new DatabaseSync(path);chmodSync(path,0o600);
  this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=100;
   CREATE TABLE IF NOT EXISTS routing_state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, draft TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS routing_version (version TEXT PRIMARY KEY, body TEXT NOT NULL, created_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS routing_release (revision INTEGER PRIMARY KEY, version TEXT NOT NULL, targets TEXT NOT NULL, who TEXT NOT NULL, at INTEGER NOT NULL, action TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS routing_target (sn TEXT PRIMARY KEY, version TEXT NOT NULL, at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS routing_load (sn TEXT PRIMARY KEY, version TEXT NOT NULL, session_digest TEXT NOT NULL, at INTEGER NOT NULL);`);
  this.db.prepare('INSERT OR IGNORE INTO routing_state VALUES(1,0,?)').run(JSON.stringify(defaultRoutingConfig()));
 }
 close(){this.db.close();}
 private stateRow(){return this.db.prepare('SELECT revision,draft FROM routing_state WHERE id=1').get() as {revision:number;draft:string};}
 private tx<T>(expected:number,fn:()=>T):T {
  this.db.exec('BEGIN IMMEDIATE');try{if(this.stateRow().revision!==expected)throw new Error('revision_conflict');const value=fn();this.db.prepare('UPDATE routing_state SET revision=revision+1 WHERE id=1').run();this.db.exec('COMMIT');return value;}catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 state(){const r=this.stateRow();return {revision:r.revision,draft:JSON.parse(r.draft),versions:this.db.prepare('SELECT version,created_at FROM routing_version ORDER BY created_at DESC LIMIT 30').all(),targets:this.db.prepare('SELECT * FROM routing_target').all(),loads:this.db.prepare('SELECT * FROM routing_load').all(),history:this.db.prepare('SELECT * FROM routing_release ORDER BY revision DESC LIMIT 50').all().map((x:any)=>({...x,targets:JSON.parse(x.targets)}))};}
 saveDraft(c:RoutingConfig,expected:number,_who:string){const body=JSON.stringify(routingConfigSchema.parse(c));this.tx(expected,()=>{this.db.prepare('UPDATE routing_state SET draft=? WHERE id=1').run(body);});}
 private release(version:string,expected:number,sns:string[],who:string,action:string){
  if(sns.length<1||sns.length>2||new Set(sns).size!==sns.length||sns.some(s=>!/^BJP003\d{14}$/.test(s)))throw new Error('invalid_scope');
  const at=this.now();this.db.prepare('INSERT INTO routing_release VALUES(?,?,?,?,?,?)').run(expected+1,version,JSON.stringify(sns),who,at,action);
  for(const sn of sns)this.db.prepare('INSERT INTO routing_target VALUES(?,?,?) ON CONFLICT(sn) DO UPDATE SET version=excluded.version,at=excluded.at').run(sn,version,at);
 }
 publish(expected:number,sns:string[],who:string):string{return this.tx(expected,()=>{const body=this.stateRow().draft,version='r7-'+sha(body).slice(0,24);this.db.prepare('INSERT OR IGNORE INTO routing_version VALUES(?,?,?)').run(version,body,this.now());this.release(version,expected,sns,who,'publish');return version;});}
 rollback(version:string,expected:number,sns:string[],who:string){this.tx(expected,()=>{this.version(version);this.release(version,expected,sns,who,'rollback');});}
 private globalRelease(version:string,expected:number,who:string,action:string){
  if(!this.options.allowGlobal)throw new Error('invalid_scope');
  const at=this.now();this.db.prepare('INSERT INTO routing_release VALUES(?,?,?,?,?,?)').run(expected+1,version,'["*"]',who,at,action);
  this.db.prepare('INSERT INTO routing_target VALUES(?,?,?) ON CONFLICT(sn) DO UPDATE SET version=excluded.version,at=excluded.at').run('*',version,at);
 }
 publishGlobal(expected:number,who:string):string{return this.tx(expected,()=>{if(!this.options.allowGlobal)throw new Error('invalid_scope');const body=this.stateRow().draft,version='r7-'+sha(body).slice(0,24);this.db.prepare('INSERT OR IGNORE INTO routing_version VALUES(?,?,?)').run(version,body,this.now());this.globalRelease(version,expected,who,'publish_all');return version;});}
 rollbackGlobal(version:string,expected:number,who:string){this.tx(expected,()=>{this.version(version);this.globalRelease(version,expected,who,'rollback_all');});}
 private version(v:string):RoutingSnapshot{const r=this.db.prepare('SELECT body FROM routing_version WHERE version=?').get(v) as {body:string}|undefined;if(!r)throw new Error('routing_version_unknown');return {version:v,config:routingConfigSchema.parse(JSON.parse(r.body))};}
 private target(sn:string):{version:string;at:number}|undefined{
  if(!/^BJP003\d{14}$/.test(sn))return undefined;
  return this.db.prepare('SELECT version,at FROM routing_target WHERE sn=?').get(sn) as {version:string;at:number}|undefined
   ??(this.options.allowGlobal?this.db.prepare("SELECT version,at FROM routing_target WHERE sn='*'").get() as {version:string;at:number}|undefined:undefined);
 }
 snapshot(sn:string):RoutingSnapshot|null{const r=this.target(sn);return r?this.version(r.version):null;}
 resolve(sn:string,version:string):RoutingSnapshot {
  const current=this.target(sn);
  if(!current)throw new Error('routing_version_unknown');
  if(current.version!==version){if(this.now()-current.at>15000)throw new Error('routing_version_stale');const prior=this.db.prepare('SELECT targets FROM routing_release WHERE version=?').all(version) as {targets:string}[];if(!prior.some(r=>{const targets=JSON.parse(r.targets);return targets.includes(sn)||this.options.allowGlobal&&targets.includes('*');}))throw new Error('routing_version_scope');}
  return this.version(version);
 }
 ack(sn:string,version:string,session:string){if(this.snapshot(sn)?.version!==version)throw new Error('routing_version_stale');this.db.prepare('INSERT INTO routing_load VALUES(?,?,?,?) ON CONFLICT(sn) DO UPDATE SET version=excluded.version,session_digest=excluded.session_digest,at=excluded.at').run(sn,version,sha(session).slice(0,16),this.now());}
}
