import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
export class AnalyticsStorageUnavailable extends Error {
  constructor(readonly busy=false){super('ANALYTICS_STORAGE_UNAVAILABLE');}
}
export class AnalyticsStore {
  readonly db: DatabaseSync;
  constructor(readonly path: string) {
    if(!isAbsolute(path)) throw new Error('analytics database path must be absolute');
    mkdirSync(dirname(path),{recursive:true});
    this.db=new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=250;
      CREATE TABLE IF NOT EXISTS analytics_event (
        device_key TEXT NOT NULL, client_event_id TEXT NOT NULL, event_name TEXT NOT NULL,
        occurred_at_ms INTEGER NOT NULL, received_at_ms INTEGER NOT NULL, session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL, priority TEXT NOT NULL, context_json TEXT NOT NULL, properties_json TEXT NOT NULL,
        batch_attempt_id TEXT NOT NULL, occurred_day TEXT, received_day TEXT NOT NULL, clock_suspicious INTEGER NOT NULL,
        PRIMARY KEY(device_key,client_event_id));
      CREATE INDEX IF NOT EXISTS analytics_event_received ON analytics_event(received_at_ms);
      CREATE INDEX IF NOT EXISTS analytics_event_days ON analytics_event(occurred_day,received_day);
      CREATE TABLE IF NOT EXISTS analytics_event_seen (
        device_key TEXT NOT NULL, id_digest TEXT NOT NULL, event_hash TEXT NOT NULL, first_received_at_ms INTEGER NOT NULL,
        PRIMARY KEY(device_key,id_digest));
      CREATE TABLE IF NOT EXISTS analytics_batch (
        attempt_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, batch_id TEXT NOT NULL, device_key TEXT NOT NULL,
        received_at_ms INTEGER NOT NULL, sent_at_ms INTEGER NOT NULL, client_json TEXT NOT NULL,
        accepted INTEGER NOT NULL, duplicated INTEGER NOT NULL, rejected INTEGER NOT NULL,
        http_status INTEGER NOT NULL, processing_ms INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS analytics_batch_request ON analytics_batch(request_id,received_at_ms);
      CREATE INDEX IF NOT EXISTS analytics_batch_received ON analytics_batch(received_at_ms);
      CREATE TABLE IF NOT EXISTS analytics_settlement (
        attempt_id TEXT NOT NULL, id_digest TEXT NOT NULL, outcome TEXT NOT NULL, reason TEXT,
        PRIMARY KEY(attempt_id,id_digest));
      CREATE INDEX IF NOT EXISTS analytics_settlement_id ON analytics_settlement(id_digest);
      CREATE TABLE IF NOT EXISTS analytics_rollup_fact (
        dimension TEXT NOT NULL, day TEXT NOT NULL, device_key TEXT NOT NULL, id_digest TEXT NOT NULL,
        event_name TEXT NOT NULL, session_digest TEXT NOT NULL, clock_suspicious INTEGER NOT NULL, semantic_json TEXT NOT NULL,
        received_at_ms INTEGER NOT NULL, PRIMARY KEY(dimension,day,device_key,id_digest));
      CREATE TABLE IF NOT EXISTS analytics_dirty_day (dimension TEXT NOT NULL, day TEXT NOT NULL, PRIMARY KEY(dimension,day));
      CREATE TABLE IF NOT EXISTS analytics_day (dimension TEXT NOT NULL,day TEXT NOT NULL,summary_json TEXT NOT NULL,updated_at_ms INTEGER NOT NULL, PRIMARY KEY(dimension,day));
      CREATE TABLE IF NOT EXISTS analytics_device_day (dimension TEXT NOT NULL,day TEXT NOT NULL,device_key TEXT NOT NULL,event_count INTEGER NOT NULL,session_count INTEGER NOT NULL,last_received_at_ms INTEGER NOT NULL,summary_json TEXT NOT NULL, PRIMARY KEY(dimension,day,device_key));
      CREATE TABLE IF NOT EXISTS analytics_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
    `);
    if(!(this.db.prepare('PRAGMA table_info(analytics_device_day)').all() as {name:string}[]).some(r=>r.name==='summary_json'))this.db.exec("ALTER TABLE analytics_device_day ADD COLUMN summary_json TEXT NOT NULL DEFAULT '{}'");
  }
  transaction<T>(fn:()=>T):T {
    try {this.db.exec('BEGIN IMMEDIATE');const result=fn();this.db.exec('COMMIT');return result;}
    catch(error) {try{this.db.exec('ROLLBACK');}catch{} throw new AnalyticsStorageUnavailable([5,6].includes((error as {errcode?:number}).errcode??0));}
  }
  close(){this.db.close();}
}
export const DAY_MS=86_400_000;
export function cstDay(ms:number):string{return new Date(ms+8*3_600_000).toISOString().slice(0,10);}
export function analysisDay(occurred:number,received:number):string|null{
  if(occurred < received-31*DAY_MS || occurred > received+2*DAY_MS) return null;
  return cstDay(occurred);
}
