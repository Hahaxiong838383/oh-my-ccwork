import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AnalyticsStore,AnalyticsStorageUnavailable,cstDay,DAY_MS} from '../src/analytics/store.js';
import {pruneAnalytics} from '../src/analytics/rollup.js';

const dir=mkdtempSync(join(tmpdir(),'analytics-prune-')),stores:AnalyticsStore[]=[];
const fixture=(name:string)=>{const store=new AnalyticsStore(join(dir,name+'.db'));stores.push(store);return store;};
const now=Date.now(),cutoff=cstDay(now-90*DAY_MS),today=cstDay(now);
const dailyTables=['analytics_rollup_fact','analytics_day','analytics_device_day','analytics_dirty_day','analytics_rollup_retry'];
const allTables=['analytics_event','analytics_event_seen','analytics_batch','analytics_settlement',...dailyTables];
const count=(store:AnalyticsStore,table:string)=>Number(store.db.prepare('SELECT count(*) n FROM '+table).get()!.n);
function addDaily(store:AnalyticsStore,dimension:string,day:string,id:string){
 store.db.prepare('INSERT INTO analytics_rollup_fact VALUES (?,?,?,?,?,?,?,?,?)').run(dimension,day,'device',id,'app.bridge_ready','session',0,'{}',now);
 store.db.prepare('INSERT INTO analytics_day VALUES (?,?,?,?)').run(dimension,day,'{}',now);
 store.db.prepare('INSERT INTO analytics_device_day VALUES (?,?,?,?,?,?,?)').run(dimension,day,'device',1,1,now,'{}');
 store.db.prepare('INSERT OR IGNORE INTO analytics_dirty_day VALUES (?,?)').run(dimension,day);
 store.db.prepare('INSERT INTO analytics_rollup_retry VALUES (?,?,?)').run(dimension,day,now);
}
function addRaw(store:AnalyticsStore,id:string){
 const old=now-15*DAY_MS,day=cstDay(old);
 store.db.prepare('INSERT INTO analytics_event VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('device',id,'app.bridge_ready',old,old,'session',1,'normal','{}','{}',id,day,day,0);
 store.db.prepare('INSERT INTO analytics_event_seen VALUES (?,?,?,?)').run('device',id,'hash',old);
 store.db.prepare('INSERT INTO analytics_batch VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id,id,id,'device',old,old,'{}',1,0,0,200,1);
 store.db.prepare('INSERT INTO analytics_settlement VALUES (?,?,?,?)').run(id,id,'accepted',null);
}

try{
 // Inspect the actual DELETE plans. LIMIT must bound useful rows without scanning retained history.
 const planStore=fixture('plans');
 assert.deepEqual(pruneAnalytics(planStore,now),{events:0,batches:0},'空表应直接结束');
 planStore.transaction(()=>{addDaily(planStore,'occurred',today,'current-a');addDaily(planStore,'received',today,'current-b');});
 const prepare=planStore.db.prepare.bind(planStore.db),plans:{table:string;details:string[]}[]=[];
 planStore.db.prepare=((sql:string)=>{
  const statement=prepare(sql),table=/\bDELETE\s+FROM\s+([a-z_]+)/i.exec(sql)?.[1];
  if(table&&dailyTables.includes(table)){
   const run=statement.run.bind(statement);
   statement.run=((...params:Parameters<typeof run>)=>{
    plans.push({table,details:prepare('EXPLAIN QUERY PLAN '+sql).all(...params).map(row=>String(row.detail))});
    return run(...params);
   }) as typeof statement.run;
  }
  return statement;
 }) as typeof planStore.db.prepare;
 try{assert.deepEqual(pruneAnalytics(planStore,now),{events:0,batches:0});}finally{planStore.db.prepare=prepare;}
 assert.deepEqual([...new Set(plans.map(plan=>plan.table))].sort(),[...dailyTables].sort());
 for(const plan of plans)assert.ok(plan.details.every(detail=>! /\bSCAN\b/.test(detail)),`${plan.table} TTL must seek expired ranges: ${plan.details.join('; ')}`);
 for(const table of dailyTables)assert.equal(count(planStore,table),2);

 // The limit belongs to each table, across ALL dimensions, including empty and unknown values.
 const store=fixture('bounded'),dimensions=['','FutureDimension','occurred','received','未知维度'];
 store.transaction(()=>{
  for(const dimension of dimensions)for(let i=0;i<300;i++)addDaily(store,dimension,cstDay(now-(91+i)*DAY_MS),'expired-'+i);
  for(const dimension of [...dimensions,'only-current']){
   addDaily(store,dimension,cutoff,'boundary');addDaily(store,dimension,today,'current');
  }
  for(let i=0;i<1001;i++)addRaw(store,'raw-'+i);
 });
 const retained=()=>dailyTables.map(table=>store.db.prepare(`SELECT rowid,* FROM ${table} WHERE day>=? ORDER BY rowid`).all(cutoff));
 const beforeRetained=retained();
 const expired=()=>dailyTables.map(table=>Number(store.db.prepare(`SELECT count(*) n FROM ${table} WHERE day<?`).get(cutoff)!.n));
 assert.deepEqual(expired(),[1500,1500,1500,1500,1500]);
 assert.deepEqual(pruneAnalytics(store,now),{events:1000,batches:1000});
 assert.deepEqual(expired(),[500,500,500,500,500],'不是每个维度各删1000，而是每张表总共最多1000');
 assert.deepEqual(retained(),beforeRetained,'严格小于cutoff；当前和边界日期必须保留');
 assert.equal(count(store,'analytics_settlement'),1);assert.equal(count(store,'analytics_event_seen'),1001);
 assert.deepEqual(pruneAnalytics(store,now),{events:1,batches:1});
 assert.deepEqual(expired(),[0,0,0,0,0],'空字符串及未知维度的过期行不能遗漏');
 assert.deepEqual(retained(),beforeRetained);
 assert.deepEqual(pruneAnalytics(store,now),{events:0,batches:0},'所有过期行清理完后应正常结束');
 assert.equal(count(store,'analytics_settlement'),0);assert.equal(count(store,'analytics_event_seen'),1001);

 // A failure after several tables were pruned must roll the complete TTL transaction back.
 const atomic=fixture('atomic');
 atomic.transaction(()=>{
  for(const dimension of ['','unknown'])for(let i=0;i<2;i++)addDaily(atomic,dimension,cstDay(now-(91+i)*DAY_MS),'expired-'+i);
  addRaw(atomic,'atomic-a');addRaw(atomic,'atomic-b');
 });
 const snapshot=()=>allTables.map(table=>atomic.db.prepare('SELECT rowid,* FROM '+table+' ORDER BY rowid').all());
 const before=snapshot();
 atomic.db.exec("CREATE TRIGGER abort_prune BEFORE DELETE ON analytics_device_day BEGIN SELECT RAISE(ABORT,'test-only TTL interruption'); END");
 assert.throws(()=>pruneAnalytics(atomic,now),error=>error instanceof AnalyticsStorageUnavailable);
 assert.deepEqual(snapshot(),before,'raw/batch/settlement/fact/day等先前删除必须一同回滚');
 atomic.db.exec('DROP TRIGGER abort_prune');
 assert.deepEqual(pruneAnalytics(atomic,now),{events:2,batches:2});
 for(const table of dailyTables)assert.equal(count(atomic,table),0,'当前维度被删空后，枚举仍须正确跳到下一维度并终止');
 assert.equal(count(atomic,'analytics_event_seen'),2);
 assert.deepEqual(pruneAnalytics(atomic,now),{events:0,batches:0});
 console.log('analytics prune: PASS (indexed expiry seeks, per-table bounds, unknown/empty dimensions, cutoff retention, atomic rollback, seen preservation)');
}finally{
 for(const store of stores)store.close();
 rmSync(dir,{recursive:true,force:true});
}
