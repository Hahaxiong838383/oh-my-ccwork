import type {DatabaseSync} from 'node:sqlite';
import {ROLLUP_FACT_TRIGGERS} from './rollup-progress.js';

const columns=['dimension','day','device_key','id_digest','event_name','session_digest','clock_suspicious','semantic_json','received_at_ms'] as const;
const oldKey=['dimension','day','device_key','id_digest'];
const newKey=['dimension','day','device_key','received_at_ms','id_digest'];
export const FACT_TABLE_COLUMNS=`
 dimension TEXT NOT NULL,day TEXT NOT NULL,device_key TEXT NOT NULL,id_digest TEXT NOT NULL,
 event_name TEXT NOT NULL,session_digest TEXT NOT NULL,clock_suspicious INTEGER NOT NULL,semantic_json TEXT NOT NULL,
 received_at_ms INTEGER NOT NULL,PRIMARY KEY(dimension,day,device_key,received_at_ms,id_digest)`;
export type FactLayout='digest-first-v1'|'received-first-v2';
export function factLayout(db:DatabaseSync):FactLayout{
 const table=db.prepare("SELECT wr FROM pragma_table_list WHERE schema='main' AND name='analytics_rollup_fact' AND type='table'").get();
 const info=db.prepare('PRAGMA table_xinfo(analytics_rollup_fact)').all() as {name:string;type:string;notnull:number;pk:number;hidden:number}[];
 if(table?.wr!==0||info.length!==columns.length||info.some((c,i)=>c.hidden!==0||c.name!==columns[i]||c.notnull!==1||c.type!==(i===6||i===8?'INTEGER':'TEXT')))throw new Error('ANALYTICS_FACT_LAYOUT_UNSUPPORTED');
 const key=info.filter(c=>c.pk>0).sort((a,b)=>a.pk-b.pk).map(c=>c.name).join(',');
 if(key===oldKey.join(','))return 'digest-first-v1';
 if(key===newKey.join(','))return 'received-first-v2';
 throw new Error('ANALYTICS_FACT_LAYOUT_UNSUPPORTED');
}

/** Explicit offline migration; never rebuild a populated fact table during service startup.
 * The new key improves write locality. Ingest dedupe still relies on seen/raw uniqueness
 * in the SAME transaction; this key alone does not prevent a different received_at replay.
 * Keep all nine columns and rowids so old code and bounded TTL remain compatible.
 */
export function migrateFactLayout(db:DatabaseSync):{changed:boolean;rows:number;layout:FactLayout}{
 if(db.isTransaction)throw new Error('ANALYTICS_FACT_MIGRATION_REQUIRES_OWN_TRANSACTION');
 db.exec('BEGIN IMMEDIATE');
 try{
  const layout=factLayout(db);
  const rows=Number(db.prepare('SELECT count(*) n FROM analytics_rollup_fact').get()!.n);
  if(layout==='received-first-v2'){db.exec('COMMIT');return {changed:false,rows,layout};}
  // Rebuilding must not silently discard an independently added index or trigger.
  const triggers=db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name='analytics_rollup_fact'").all() as {name:string;sql:string}[];
  const canonical=(sql:string)=>sql.replace(/\s+/g,' ').trim();
  if(db.prepare('PRAGMA index_list(analytics_rollup_fact)').all().some(i=>i.origin!=='pk')||triggers.some(t=>!(t.name in ROLLUP_FACT_TRIGGERS)||canonical(t.sql)!==canonical(ROLLUP_FACT_TRIGGERS[t.name as keyof typeof ROLLUP_FACT_TRIGGERS])))throw new Error('ANALYTICS_FACT_LAYOUT_UNSUPPORTED');
  db.exec(`CREATE TABLE analytics_rollup_fact_next (${FACT_TABLE_COLUMNS})`);
  db.exec(`INSERT INTO analytics_rollup_fact_next(rowid,${columns.join(',')}) SELECT rowid,${columns.join(',')} FROM analytics_rollup_fact`);
  const copied=Number(db.prepare('SELECT count(*) n FROM analytics_rollup_fact_next').get()!.n);
  // Count equality + a unique rowid join + exact comparison of every column proves
  // both directions without a temporary sort of the entire historical fact table.
  const mismatch=db.prepare(`SELECT 1 FROM analytics_rollup_fact a LEFT JOIN analytics_rollup_fact_next b ON a.rowid=b.rowid WHERE b.rowid IS NULL OR ${columns.map(c=>`a.${c} IS NOT b.${c}`).join(' OR ')} LIMIT 1`).get();
  if(copied!==rows||mismatch)throw new Error('ANALYTICS_FACT_COPY_MISMATCH');
  db.exec('DROP TABLE analytics_rollup_fact');
  db.exec('ALTER TABLE analytics_rollup_fact_next RENAME TO analytics_rollup_fact');
  for(const trigger of triggers)db.exec(trigger.sql);
  db.exec('COMMIT');return {changed:true,rows,layout:'received-first-v2'};
 }catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}
}
