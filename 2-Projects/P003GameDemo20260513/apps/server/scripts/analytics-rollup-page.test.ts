import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AnalyticsStore,cstDay} from '../src/analytics/store.js';
import {rollupDirtyDaysWithStatus,pruneAnalytics} from '../src/analytics/rollup.js';
import {hasRollupPrefixIndex,installRollupPrefixIndex,ROLLUP_PREFIX_INDEX} from '../src/analytics/rollup-index.js';
const dir=mkdtempSync(join(tmpdir(),'rollup-page-')),path=join(dir,'test.db'),now=Date.now(),day=cstDay(now);
let store=new AnalyticsStore(path);
try{
 assert.equal(hasRollupPrefixIndex(store.db),false,'startup must not build an index');
 store.transaction(()=>{const put=store.db.prepare('INSERT INTO analytics_rollup_fact VALUES (?,?,?,?,?,?,?,?,?)');for(let i=0;i<1200;i++)put.run('received',day,'one-device',String(i),i%3?'app.session_started':'g1.reward_granted','same-session',0,JSON.stringify(i%3?{}:{reward_instance_digest:'r'+i%2,gm_override:i===0}),now-i);});
 store.close();store=new AnalyticsStore(path);assert.equal(hasRollupPrefixIndex(store.db),false,'populated reopening must not migrate');
 assert.equal(installRollupPrefixIndex(store.db).changed,true);assert.equal(installRollupPrefixIndex(store.db).changed,false);
 const plan=JSON.stringify(store.db.prepare(`EXPLAIN QUERY PLAN SELECT rowid,event_name,semantic_json FROM analytics_rollup_fact INDEXED BY ${ROLLUP_PREFIX_INDEX} WHERE dimension=? AND day=? AND device_key=? AND rowid>? ORDER BY rowid LIMIT 513`).all('received',day,'one-device',512));
 assert.ok(plan.includes('rowid>?'),plan);assert.ok(!plan.includes('TEMP B-TREE'),plan);
 let completed=0;
 for(let attempt=0;attempt<5&&!completed;attempt++){
  const prepare=store.db.prepare.bind(store.db);
  store.db.prepare=((sql:string)=>{const stmt=prepare(sql);if(sql.startsWith('SELECT ')&&sql.includes('semantic_json')&&sql.includes('FROM analytics_rollup_fact')){
   const iterate=stmt.iterate.bind(stmt);stmt.iterate=function*(...args:any[]){let rows=0;for(const row of iterate(...args)){yield row;if(++rows%512===0){const until=performance.now()+25;while(performance.now()<until){}}}} as any;
  }return stmt;}) as any;
  const status=rollupDirtyDaysWithStatus(store,now,16,{maxFactsPerDay:2000,maxDayMs:40});store.db.prepare=prepare;completed=status.rebuilt_days;
  if(!completed){assert.equal(status.remaining_dirty_days,1);assert.equal(store.db.prepare('SELECT count(*) n FROM analytics_day').get()!.n,0);}
  store.close();store=new AnalyticsStore(path);
 }
 assert.equal(completed,1,'a single slow device must retain completed pages across restarts');
 const s=JSON.parse(String(store.db.prepare('SELECT summary_json FROM analytics_day').get()!.summary_json));
 assert.equal(s.event_count,1200);assert.equal(s.sessions,1);assert.equal(s.unique_reward_instances,2);assert.equal(s.reward_grant_events,400);assert.equal(s.explicit_gm_events,1);assert.equal(s.data_cutoff_ms,now);
 assert.equal(store.db.prepare('SELECT count(*) n FROM analytics_rollup_distinct').get()!.n,3);
 console.log('PASS offline-only index, rowid range seek, single-device paged restart, backward timestamps and exact distinct');
  const future=now+91*86400000;pruneAnalytics(store,future,10);
  assert.equal(store.db.prepare('SELECT count(*) n FROM analytics_rollup_fact').get()!.n,1190);
  store.db.prepare('INSERT OR IGNORE INTO analytics_dirty_day VALUES (?,?)').run('received',day);
  const expired=rollupDirtyDaysWithStatus(store,future);
  assert.equal(expired.rebuilt_days,0);assert.equal(store.db.prepare('SELECT count(*) n FROM analytics_day').get()!.n,0,'partially pruned expired facts cannot be republished');
  console.log('PASS expired dirty backlog is not rebuilt from partially deleted facts');
}finally{store.close();rmSync(dir,{recursive:true,force:true});}
