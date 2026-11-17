import type {DatabaseSync} from 'node:sqlite';

// Additive schema: the nine-column fact and two-column dirty tables remain
// compatible with the previous receiver/maintenance binaries on rollback.
const changed=(row:'NEW'|'OLD',mutation:boolean)=>`
 INSERT INTO analytics_rollup_source VALUES (${row}.dimension,${row}.day,${row}.device_key,1,${mutation?1:0})
 ON CONFLICT(dimension,day,device_key) DO UPDATE SET revision=revision+1,mutation=mutation+${mutation?1:0};
 INSERT OR IGNORE INTO analytics_dirty_day VALUES (${row}.dimension,${row}.day);`;
export const ROLLUP_FACT_TRIGGERS=Object.freeze({
 analytics_rollup_fact_insert:`CREATE TRIGGER analytics_rollup_fact_insert AFTER INSERT ON analytics_rollup_fact BEGIN ${changed('NEW',false)} END`,
 analytics_rollup_fact_delete:`CREATE TRIGGER analytics_rollup_fact_delete AFTER DELETE ON analytics_rollup_fact BEGIN ${changed('OLD',true)} END`,
 analytics_rollup_fact_update:`CREATE TRIGGER analytics_rollup_fact_update AFTER UPDATE ON analytics_rollup_fact BEGIN ${changed('OLD',true)}${changed('NEW',true)} END`,
});
export function initRollupProgress(db:DatabaseSync){
 db.exec(`
  CREATE TABLE IF NOT EXISTS analytics_rollup_source (
   dimension TEXT NOT NULL,day TEXT NOT NULL,device_key TEXT NOT NULL,revision INTEGER NOT NULL,mutation INTEGER NOT NULL,
   PRIMARY KEY(dimension,day,device_key));
  CREATE TABLE IF NOT EXISTS analytics_rollup_device_stage (
   dimension TEXT NOT NULL,day TEXT NOT NULL,device_key TEXT NOT NULL,revision INTEGER NOT NULL,mutation INTEGER NOT NULL,folded_rowid INTEGER NOT NULL,summary_json TEXT NOT NULL,
   PRIMARY KEY(dimension,day,device_key));
  CREATE TABLE IF NOT EXISTS analytics_rollup_distinct (
   dimension TEXT NOT NULL,day TEXT NOT NULL,device_key TEXT NOT NULL,kind TEXT NOT NULL,digest TEXT NOT NULL,
   PRIMARY KEY(dimension,day,device_key,kind,digest));
 `);
 // Track old receivers, TTL and direct maintenance in the same fact transaction.
 for(const sql of Object.values(ROLLUP_FACT_TRIGGERS))db.exec(sql.replace('CREATE TRIGGER ','CREATE TRIGGER IF NOT EXISTS '));
}
