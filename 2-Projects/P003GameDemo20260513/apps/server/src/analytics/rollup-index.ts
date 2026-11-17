import type {DatabaseSync} from 'node:sqlite';

export const ROLLUP_PREFIX_INDEX='analytics_rollup_device_rowid';
export function hasRollupPrefixIndex(db:DatabaseSync):boolean{
 const rows=db.prepare(`PRAGMA index_xinfo(${ROLLUP_PREFIX_INDEX})`).all();
 const keys=rows.filter(r=>r.key===1);
 // SQLite appends the implicit rowid after these three equality columns.
 return keys.length===3&&keys.every((r,i)=>r.name===['dimension','day','device_key'][i]&&r.desc===0&&r.coll==='BINARY')&&rows.some(r=>r.cid===-1&&r.key===0)&&db.prepare('PRAGMA index_list(analytics_rollup_fact)').all().some(r=>r.name===ROLLUP_PREFIX_INDEX&&r.partial===0);
}
/** Explicit offline operation. Never called by AnalyticsStore/server startup. */
export function installRollupPrefixIndex(db:DatabaseSync){
 if(hasRollupPrefixIndex(db))return {changed:false,index:ROLLUP_PREFIX_INDEX};
 if(db.isTransaction)throw new Error('ROLLUP_INDEX_REQUIRES_OWN_TRANSACTION');
 if(db.prepare('SELECT 1 FROM sqlite_schema WHERE name=?').get(ROLLUP_PREFIX_INDEX))throw new Error('ROLLUP_INDEX_LAYOUT_MISMATCH');
 db.exec('BEGIN IMMEDIATE');
 try{
  db.exec(`CREATE INDEX ${ROLLUP_PREFIX_INDEX} ON analytics_rollup_fact(dimension,day,device_key)`);
  if(!hasRollupPrefixIndex(db))throw new Error('ROLLUP_INDEX_LAYOUT_MISMATCH');
  db.exec('COMMIT');return {changed:true,index:ROLLUP_PREFIX_INDEX};
 }catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}
}
