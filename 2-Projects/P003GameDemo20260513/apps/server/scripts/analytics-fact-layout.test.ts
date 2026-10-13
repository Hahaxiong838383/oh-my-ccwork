import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {AnalyticsStore,DAY_MS,cstDay} from '../src/analytics/store.js';
import {settleAnalyticsBatch} from '../src/analytics/ingest.js';
import {validateAnalyticsBatch} from '../src/analytics/contracts.js';
import {rollupDirtyDays,pruneAnalytics} from '../src/analytics/rollup.js';

const dir=mkdtempSync(join(tmpdir(),'analytics-fact-layout-'));
const ordered='SELECT * FROM analytics_rollup_fact WHERE dimension=? AND day=? ORDER BY device_key,received_at_ms,id_digest';
const fresh=new AnalyticsStore(join(dir,'fresh.db'));
assert.ok(!JSON.stringify(fresh.db.prepare('EXPLAIN QUERY PLAN '+ordered).all('received','2026-10-13')).includes('TEMP B-TREE'),'按设备/接收时间流式汇总不能额外排序历史事实');
fresh.close();

const {migrateFactLayout,factLayout}=await import('../src/analytics/fact-layout.js');
const oldDDL=`CREATE TABLE analytics_rollup_fact (
 dimension TEXT NOT NULL,day TEXT NOT NULL,device_key TEXT NOT NULL,id_digest TEXT NOT NULL,
 event_name TEXT NOT NULL,session_digest TEXT NOT NULL,clock_suspicious INTEGER NOT NULL,semantic_json TEXT NOT NULL,
 received_at_ms INTEGER NOT NULL,PRIMARY KEY(dimension,day,device_key,id_digest))`;
const path=join(dir,'old.db'),store=new AnalyticsStore(path),now=Date.now(),old=now-20*DAY_MS;
store.db.exec('DROP TABLE analytics_rollup_fact');store.db.exec(oldDDL);
const ev=(id:string,time=old,extra={})=>({schema_version:1,client_event_id:id,event_name:'app.session_started',occurred_at_ms:time,session_id:'s1',sequence:1,priority:'normal',context:{},properties:{platform:'Android',entry_mode:'launcher'},...extra});
const send=(events:any[],received:number,device='a')=>settleAnalyticsBatch(store,{deviceKey:device,active:true,uploadEnabled:true,uploadHourCst:0},validateAnalyticsBatch({schema_version:1,batch_id:'layout-test',sent_at_ms:received,client:{},events}),'layout-test',received);
const A=ev('A'),B=ev('B');send([A,B],old);send([ev('C')],old+1,'b');send([ev('late',old)],now);
send([ev('clock',0)],now,'c');
rollupDirtyDays(store,now);
const otherTables=['analytics_event','analytics_event_seen','analytics_batch','analytics_settlement','analytics_day','analytics_device_day','analytics_dirty_day'];
const otherSnapshot=()=>otherTables.map(t=>store.db.prepare(`SELECT rowid,* FROM ${t} ORDER BY rowid`).all());
const rows=()=>store.db.prepare('SELECT rowid,* FROM analytics_rollup_fact ORDER BY rowid').all();
const before=rows(),others=otherSnapshot();
assert.equal(factLayout(store.db),'digest-first-v1');
assert.ok(JSON.stringify(store.db.prepare('EXPLAIN QUERY PLAN '+ordered).all('received',cstDay(old))).includes('TEMP B-TREE'));

// A failure after DROP must roll back DDL and all rows, leaving a retry possible.
const originalExec=store.db.exec.bind(store.db);
store.db.exec=((sql:string)=>{if(sql.startsWith('ALTER TABLE analytics_rollup_fact_next'))throw new Error('injected migration interruption');return originalExec(sql);}) as typeof store.db.exec;
assert.throws(()=>migrateFactLayout(store.db),/injected migration interruption/);
store.db.exec=originalExec;
assert.equal(factLayout(store.db),'digest-first-v1');assert.deepEqual(rows(),before);assert.deepEqual(otherSnapshot(),others);
assert.equal(store.db.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='analytics_rollup_fact_next'").get()!.n,0);

// Equal row counts alone are insufficient: every copied column and rowid must match.
store.db.exec=((sql:string)=>{const result=originalExec(sql);if(sql.startsWith('INSERT INTO analytics_rollup_fact_next'))originalExec("UPDATE analytics_rollup_fact_next SET semantic_json='{\"corrupt\":true}' WHERE rowid=(SELECT min(rowid) FROM analytics_rollup_fact_next)");return result;}) as typeof store.db.exec;
assert.throws(()=>migrateFactLayout(store.db),/ANALYTICS_FACT_COPY_MISMATCH/);store.db.exec=originalExec;
assert.deepEqual(rows(),before);assert.equal(factLayout(store.db),'digest-first-v1');
const result=migrateFactLayout(store.db);
assert.equal(result.changed,true);assert.equal(result.rows,before.length);assert.equal(factLayout(store.db),'received-first-v2');
assert.deepEqual(rows(),before);assert.deepEqual(otherSnapshot(),others);
assert.equal(migrateFactLayout(store.db).changed,false,'再次运行迁移不重写数据');
assert.ok(!JSON.stringify(store.db.prepare('EXPLAIN QUERY PLAN '+ordered).all('received',cstDay(old))).includes('TEMP B-TREE'));

assert.deepEqual(send([A],now+1).duplicated_event_ids,['A']);
assert.deepEqual(send([{...A,sequence:2}],now+2).rejected,[{client_event_id:'A',reason:'client_event_id_conflict'}]);
assert.deepEqual(rows(),before);
store.db.exec("CREATE TRIGGER fail_fact BEFORE INSERT ON analytics_rollup_fact WHEN NEW.device_key='fail' BEGIN SELECT RAISE(ABORT,'test'); END");
assert.throws(()=>send([ev('must-rollback')],now,'fail'),/ANALYTICS_STORAGE_UNAVAILABLE/);
store.db.exec('DROP TRIGGER fail_fact');assert.deepEqual(rows(),before);
assert.equal(store.db.prepare("SELECT count(*) n FROM analytics_event_seen WHERE device_key='fail'").get()!.n,0);

// Raw 14-day expiry must not reopen dedupe or erase retained rollup contributions.
assert.equal(pruneAnalytics(store,now,1000).events,3);
assert.deepEqual(send([A],now+3).duplicated_event_ids,['A']);assert.deepEqual(rows(),before);
send([ev('late-after-prune',old)],now+4);rollupDirtyDays(store,now+5);
const day=JSON.parse(String(store.db.prepare("SELECT summary_json FROM analytics_day WHERE dimension='occurred' AND day=?").get(cstDay(old))!.summary_json));
assert.equal(day.event_count,5);assert.equal(day.sessions,2);assert.equal(day.active_devices,2);
// Old nine-column INSERT and old ORDER BY remain usable for code rollback.
store.db.prepare('INSERT INTO analytics_rollup_fact VALUES (?,?,?,?,?,?,?,?,?)').run('received',cstDay(now),'legacy','legacy','app.bridge_ready','s',0,'{}',now);
assert.ok(store.db.prepare('SELECT * FROM analytics_rollup_fact WHERE dimension=? AND day=? ORDER BY device_key,id_digest').all('received',cstDay(now)).length>0);
store.close();
const reopened=new AnalyticsStore(path);assert.equal(factLayout(reopened.db),'received-first-v2');assert.equal(migrateFactLayout(reopened.db).changed,false);
pruneAnalytics(reopened,now+91*DAY_MS,1000);
assert.equal(reopened.db.prepare('SELECT count(*) n FROM analytics_rollup_fact').get()!.n,0,'90天fact清理继续使用保留的rowid');
assert.equal(reopened.db.prepare('SELECT count(*) n FROM analytics_event_seen').get()!.n,6,'seen不随14/90天TTL删除');
reopened.close();

// Deterministic failure ranking must not depend on physical fact insertion order.
const tie=new AnalyticsStore(join(dir,'ties.db'));
for(let i=101;i>=0;i--)tie.db.prepare('INSERT INTO analytics_rollup_fact VALUES (?,?,?,?,?,?,?,?,?)').run('received',cstDay(now),'d',String(101-i).padStart(3,'0'),'g1.command_failed','s',0,JSON.stringify({command:'cmd'+String(i).padStart(3,'0'),error_code:'E'}),now+101-i);
tie.db.prepare('INSERT INTO analytics_dirty_day VALUES (?,?)').run('received',cstDay(now));rollupDirtyDays(tie,now);
const ranked=JSON.parse(String(tie.db.prepare('SELECT summary_json FROM analytics_day').get()!.summary_json)).groups.command_failures;
assert.equal(ranked.length,100);assert.equal(ranked[0].command,'cmd000');assert.equal(ranked[99].command,'cmd099');tie.close();

const unknown=new DatabaseSync(join(dir,'unknown.db'));unknown.exec('CREATE TABLE analytics_rollup_fact (unexpected TEXT)');assert.throws(()=>migrateFactLayout(unknown),/ANALYTICS_FACT_LAYOUT_UNSUPPORTED/);unknown.close();
const wrongPath=join(dir,'other-business.db'),wrong=new DatabaseSync(wrongPath);wrong.exec('CREATE TABLE business (value TEXT); INSERT INTO business VALUES (\'keep\')');
const oldJournal=wrong.prepare('PRAGMA journal_mode').get()!.journal_mode;wrong.close();
const wrongApply=spawnSync(process.execPath,['--experimental-sqlite','--import','tsx','scripts/analytics-fact-layout.ts','--apply'],{cwd:process.cwd(),env:{...process.env,ANALYTICS_DB_PATH:wrongPath},encoding:'utf8',timeout:10000});
assert.notEqual(wrongApply.status,0);const afterWrong=new DatabaseSync(wrongPath);
assert.equal(afterWrong.prepare('PRAGMA journal_mode').get()!.journal_mode,oldJournal,'错误目标不能在布局校验前被切换日志模式');
assert.equal(afterWrong.prepare('SELECT value FROM business').get()!.value,'keep');afterWrong.close();
const without=new DatabaseSync(join(dir,'without.db'));
without.exec(oldDDL.replace('PRIMARY KEY(dimension,day,device_key,id_digest)','PRIMARY KEY(dimension,day,device_key,received_at_ms,id_digest)')+' WITHOUT ROWID');
assert.throws(()=>factLayout(without),/ANALYTICS_FACT_LAYOUT_UNSUPPORTED/,'TTL依赖rowid，不能接受无rowid表');without.close();
rmSync(dir,{recursive:true,force:true});
console.log('analytics fact layout: PASS (atomic migration, exact data/rowid preservation, replay/conflict/TTL, rollback compatibility, ordered scan, stable ranking)');
