import { DatabaseSync } from 'node:sqlite';
import { mkdirSync,statSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import {configureAnalyticsWriter} from './sqlite-policy.mjs';
import {FACT_TABLE_COLUMNS} from './fact-layout.js';
const INGEST_SQL={
 seen:'SELECT event_hash FROM analytics_event_seen WHERE device_key=? AND id_digest=?',
 event:'INSERT INTO analytics_event VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
 remember:'INSERT INTO analytics_event_seen VALUES (?,?,?,?)',
 fact:'INSERT INTO analytics_rollup_fact VALUES (?,?,?,?,?,?,?,?,?)',
 dirty:'INSERT OR IGNORE INTO analytics_dirty_day VALUES (?,?)',
 batch:'INSERT INTO analytics_batch VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
 settlement:'INSERT INTO analytics_settlement VALUES (?,?,?,?)'
} as const;
type IngestStatements={readonly [K in keyof typeof INGEST_SQL]:ReturnType<DatabaseSync['prepare']>};
export class AnalyticsStorageUnavailable extends Error {
  constructor(readonly busy=false){super('ANALYTICS_STORAGE_UNAVAILABLE');}
}
export class AnalyticsRollupBudgetExceeded extends Error {
  constructor(){super('ANALYTICS_ROLLUP_BUDGET_EXCEEDED');}
}
export class AnalyticsStore {
  readonly db: DatabaseSync;
  readonly sqliteVersion:string;
  private ingestStatements?:IngestStatements;
  constructor(readonly path: string) {
    if(!isAbsolute(path)) throw new Error('analytics database path must be absolute');
    mkdirSync(dirname(path),{recursive:true});
    this.db=new DatabaseSync(path);
    try{this.sqliteVersion=configureAnalyticsWriter(this.db);}catch(error){this.db.close();throw error;}
    // Negative cache_size is KiB: 64MiB pager budget, not an RSS limit. Keep spill unchanged.
    this.db.exec('PRAGMA cache_size=-65536');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS analytics_event (
        device_key TEXT NOT NULL, client_event_id TEXT NOT NULL, event_name TEXT NOT NULL,
        occurred_at_ms INTEGER NOT NULL, received_at_ms INTEGER NOT NULL, session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL, priority TEXT NOT NULL, context_json TEXT NOT NULL, properties_json TEXT NOT NULL,
        batch_attempt_id TEXT NOT NULL, occurred_day TEXT, received_day TEXT NOT NULL, clock_suspicious INTEGER NOT NULL,
        PRIMARY KEY(device_key,client_event_id));
      CREATE INDEX IF NOT EXISTS analytics_ark_device_received ON analytics_event(device_key,received_at_ms DESC,occurred_at_ms DESC);
      CREATE INDEX IF NOT EXISTS analytics_event_received ON analytics_event(received_at_ms);
      CREATE INDEX IF NOT EXISTS analytics_event_client_received ON analytics_event(client_event_id,received_at_ms);
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
      CREATE TABLE IF NOT EXISTS analytics_rollup_fact (${FACT_TABLE_COLUMNS});
      CREATE TABLE IF NOT EXISTS analytics_dirty_day (dimension TEXT NOT NULL, day TEXT NOT NULL, PRIMARY KEY(dimension,day));
      CREATE TABLE IF NOT EXISTS analytics_rollup_retry (dimension TEXT NOT NULL,day TEXT NOT NULL,last_attempt_ms INTEGER NOT NULL,PRIMARY KEY(dimension,day));
      CREATE TABLE IF NOT EXISTS analytics_day (dimension TEXT NOT NULL,day TEXT NOT NULL,summary_json TEXT NOT NULL,updated_at_ms INTEGER NOT NULL, PRIMARY KEY(dimension,day));
      CREATE TABLE IF NOT EXISTS analytics_device_day (dimension TEXT NOT NULL,day TEXT NOT NULL,device_key TEXT NOT NULL,event_count INTEGER NOT NULL,session_count INTEGER NOT NULL,last_received_at_ms INTEGER NOT NULL,summary_json TEXT NOT NULL, PRIMARY KEY(dimension,day,device_key));
      CREATE TABLE IF NOT EXISTS analytics_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
    `);
    if(!(this.db.prepare('PRAGMA table_info(analytics_device_day)').all() as {name:string}[]).some(r=>r.name==='summary_json'))this.db.exec("ALTER TABLE analytics_device_day ADD COLUMN summary_json TEXT NOT NULL DEFAULT '{}'");
  }
  transaction<T>(fn:()=>T):T {
    try {this.db.exec('BEGIN IMMEDIATE');const result=fn();this.db.exec('COMMIT');return result;}
    catch(error) {try{this.db.exec('ROLLBACK');}catch{} if(error instanceof AnalyticsRollupBudgetExceeded)throw error;throw new AnalyticsStorageUnavailable([5,6].includes((error as {errcode?:number}).errcode??0));}
  }
  readSnapshot<T>(fn:()=>T):T{
    // Reuse a caller's existing snapshot without committing it; never take a writer lock.
    if(this.db.isTransaction)return fn();
    this.db.exec('BEGIN');
    try{const result=fn();this.db.exec('COMMIT');return result;}
    catch(error){try{this.db.exec('ROLLBACK');}catch{}throw error;}
  }
  get ingest():IngestStatements{
    // Exactly seven fixed statements per connection; no cache of arbitrary/dynamic queries.
    return this.ingestStatements??=Object.freeze(Object.fromEntries(Object.entries(INGEST_SQL).map(([key,sql])=>[key,this.db.prepare(sql)])) as IngestStatements);
  }
  close(){this.db.close();}
  walBytes(){try{return statSync(this.path+'-wal').size;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return 0;throw new AnalyticsStorageUnavailable();}}
}
export const DAY_MS=86_400_000;
export function cstDay(ms:number):string{return new Date(ms+8*3_600_000).toISOString().slice(0,10);}
export function analysisDay(occurred:number,received:number):string|null{
  if(occurred < received-31*DAY_MS || occurred > received+2*DAY_MS) return null;
  return cstDay(occurred);
}
