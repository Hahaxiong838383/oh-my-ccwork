import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {spawnSync} from 'node:child_process';
const {AnalyticsStore,DAY_MS,cstDay}=await import('../src/analytics/store.js');const {rollupDirtyDays}=await import('../src/analytics/rollup.js');
const dir=mkdtempSync(join(tmpdir(),'analytics-maintenance-')),path=join(dir,'analytics.db'),store=new AnalyticsStore(path),now=Date.now(),key='a'.repeat(64);
// A fixed semantic fixture verifies full-day and per-device output without retaining fact rows in the worker.
const semanticStore=new AnalyticsStore(join(dir,'semantic.db')),semanticDay=cstDay(now-5*DAY_MS);
const fixture:[string,string,string,Record<string,unknown>,number][]=[
 ['a','app.session_started','s1',{},0],['a','app.session_started','s1',{},0],['a','app.session_started','s2',{},0],
 ['a','g1.reward_granted','s2',{reward_instance_digest:'r1',gm_override:true},0],['a','g1.reward_granted','s2',{reward_instance_digest:'r1'},0],['a','g1.command_failed','s2',{command:'start',error_code:'E'},0],
 ['b','app.session_started','s1',{},0],['b','g1.reward_granted','s1',{reward_instance_digest:'r1',gm_override:true},0],['b','settings.closed','s1',{},0],
 ['c','voice.session_started','s1',{},0],['c','g1.command_failed','s1',{command:'start',error_code:'E'},1],['c','g1.phase_changed','s1',{},0],['c','g1.logical_day_changed','s1',{logical_day:2},0]
];
semanticStore.transaction(()=>{[6,0,9,1,7,10,2,8,11,3,12,4,5].forEach(i=>{const [device,name,session,semantic,clock]=fixture[i];return semanticStore.db.prepare('INSERT INTO analytics_rollup_fact VALUES (?,?,?,?,?,?,?,?,?)').run('received',semanticDay,device,String(i).padStart(2,'0'),name,session,clock,JSON.stringify({tank_id:'fixture',...semantic}),now+i);});semanticStore.db.prepare('INSERT INTO analytics_dirty_day VALUES (?,?)').run('received',semanticDay);});
const semanticPrepare=semanticStore.db.prepare.bind(semanticStore.db),parse=JSON.parse;let traversals=0,parses=0;
semanticStore.db.prepare=((sql:string)=>{if(sql.startsWith('SELECT ')&&sql.includes('FROM analytics_rollup_fact'))traversals++;return semanticPrepare(sql);}) as typeof semanticStore.db.prepare;
JSON.parse=((value:string,...args:any[])=>{if(value.includes('"tank_id":"fixture"'))parses++;return parse(value,...args);}) as typeof JSON.parse;
try{assert.equal(rollupDirtyDays(semanticStore,now,16,{maxFactsPerDay:1_000_000,maxDayMs:8000}),1);}finally{JSON.parse=parse;semanticStore.db.prepare=semanticPrepare;}
const globalSummary=JSON.parse(String(semanticStore.db.prepare('SELECT summary_json FROM analytics_day').get()!.summary_json));
assert.equal(globalSummary.event_count,13);assert.equal(globalSummary.active_devices,3);assert.equal(globalSummary.sessions,3);assert.equal(globalSummary.unique_reward_instances,2);assert.equal(globalSummary.reward_grant_events,3);assert.equal(globalSummary.explicit_gm_events,2);assert.equal(globalSummary.unclassified_traffic_events,11);assert.equal(globalSummary.clock_suspicious_events,1);assert.equal(globalSummary.data_cutoff_ms,now+12);
assert.deepEqual(globalSummary.event_counts,{'app.session_started':4,'g1.reward_granted':3,'g1.command_failed':2,'settings.closed':1,'voice.session_started':1,'g1.phase_changed':1,'g1.logical_day_changed':1});
assert.deepEqual(globalSummary.groups,{activity:{'app.session_started':4},g1_flow:{'g1.phase_changed':1},logical_day_ecotank:{'g1.logical_day_changed':1},rewards_makeup:{'g1.reward_granted':3},settings:{'settings.closed':1},voice_state:{'voice.session_started':1},command_failures:[{command:'start',error_code:'E',count:2}]});
const individual=()=>semanticStore.db.prepare('SELECT * FROM analytics_device_day ORDER BY device_key').all() as any[];
const devices=individual();
for(const [i,counts] of [[0,[6,2,1,1,0,now+5]],[1,[3,1,1,1,0,now+8]],[2,[4,0,0,0,1,now+12]]] as const){const row=devices[i],s=JSON.parse(row.summary_json);assert.deepEqual([s.event_count,s.sessions,s.unique_reward_instances,s.explicit_gm_events,s.clock_suspicious_events,s.data_cutoff_ms],counts);assert.equal(s.active_devices,1);assert.equal(row.event_count,s.event_count);assert.equal(row.session_count,s.sessions);assert.equal(row.last_received_at_ms,s.data_cutoff_ms);assert.equal(s.updated_at_ms,now);}
assert.equal(parses,fixture.length,'semantic_json每条只解析一次');assert.equal(traversals,1,'每个日期仅一条fact iterator，无设备回扫；交错设备仍准确分组');
const beforeSemantic=JSON.stringify(individual());
semanticStore.db.prepare('INSERT INTO analytics_rollup_fact VALUES (?,?,?,?,?,?,?,?,?)').run('received',semanticDay,'a','late','g1.makeup_card_used','s2',0,'{"used_makeup_card":true}',now+100);semanticStore.db.prepare('INSERT INTO analytics_dirty_day VALUES (?,?)').run('received',semanticDay);
assert.equal(rollupDirtyDays(semanticStore,now+200,16,{maxFactsPerDay:8,maxDayMs:8000}),0);assert.equal(JSON.stringify(individual()),beforeSemantic,'预算失败不能部分替换旧设备摘要');assert.deepEqual(JSON.parse(String(semanticStore.db.prepare('SELECT summary_json FROM analytics_day').get()!.summary_json)),globalSummary);assert.equal(semanticStore.db.prepare('SELECT count(*) n FROM analytics_dirty_day').get()!.n,1);
assert.equal(rollupDirtyDays(semanticStore,now+300,16,{maxFactsPerDay:1_000_000,maxDayMs:8000}),1);const lateSummary=JSON.parse(String(semanticStore.db.prepare('SELECT summary_json FROM analytics_day').get()!.summary_json));assert.equal(lateSummary.event_count,14);assert.equal(lateSummary.sessions,3);assert.equal(lateSummary.unique_reward_instances,2);assert.equal(lateSummary.data_cutoff_ms,now+100);assert.equal(lateSummary.groups.rewards_makeup['g1.makeup_card_used'],1);assert.equal(JSON.parse(individual()[0].summary_json).event_count,7);assert.equal(semanticStore.db.prepare('SELECT count(*) n FROM analytics_dirty_day').get()!.n,0);semanticStore.close();
const fact=(day:string,id:string,dirty=true)=>{store.db.prepare('INSERT INTO analytics_rollup_fact VALUES (?,?,?,?,?,?,?,?,?)').run('received',day,key,id,'app.bridge_ready','session-digest',0,'{}',now);if(dirty)store.db.prepare('INSERT OR IGNORE INTO analytics_dirty_day VALUES (?,?)').run('received',day);};
const badDay=cstDay(now-DAY_MS),goodDay=cstDay(now);
fact(badDay,'over-budget-1');fact(badDay,'over-budget-2');fact(goodDay,'within-budget');
store.db.prepare('INSERT INTO analytics_meta VALUES (?,?)').run('last_rollup_success_ms','123');
const rebuilt=rollupDirtyDays(store,now,16,{maxFactsPerDay:1,maxDayMs:30000});
assert.equal(rebuilt,1,'超预算日必须保持dirty，后续健康日仍独立完成');
assert.equal(store.db.prepare('SELECT count(*) n FROM analytics_dirty_day WHERE day=?').get(badDay)!.n,1);
assert.equal(store.db.prepare('SELECT count(*) n FROM analytics_day WHERE day=?').get(goodDay)!.n,1);
assert.equal(store.db.prepare('SELECT value FROM analytics_meta WHERE key=?').get('last_rollup_success_ms')!.value,'123','partial不能推进全量成功水位');
assert.equal(store.db.prepare('SELECT value FROM analytics_meta WHERE key=?').get('last_rollup_status')!.value,'partial');
const expired=(id:string)=>{
 const old=now-15*DAY_MS;store.db.prepare('INSERT INTO analytics_event VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(key,id,'app.bridge_ready',old,old,'session',1,'normal','{}','{}',id,cstDay(old),cstDay(old),0);
 store.db.prepare('INSERT INTO analytics_batch VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id,id,id,key,old,old,'{}',1,0,0,200,1);store.db.prepare('INSERT INTO analytics_settlement VALUES (?,?,?,?)').run(id,id,'accepted',null);
};
expired('expired');store.db.prepare('INSERT INTO analytics_event_seen VALUES (?,?,?,?)').run(key,'seen-retained','hash',now-15*DAY_MS);
const ancient=cstDay(now-91*DAY_MS);fact(ancient,'ancient',false);store.db.prepare('INSERT INTO analytics_day VALUES (?,?,?,?)').run('received',ancient,'{}',now);
fact(cstDay(now+DAY_MS),'next-healthy');
store.db.exec(`CREATE TABLE maintenance_order (position INTEGER PRIMARY KEY,phase TEXT);
 CREATE TRIGGER observe_prune AFTER DELETE ON analytics_event BEGIN INSERT INTO maintenance_order(phase) VALUES ('ttl'); END;
 CREATE TRIGGER observe_rollup BEFORE INSERT ON analytics_day BEGIN INSERT INTO maintenance_order(phase) VALUES ('rollup'); END;`);
const cli=()=>spawnSync(process.execPath,['--experimental-sqlite','--import','tsx','scripts/analytics-rollup.ts'],{cwd:process.cwd(),encoding:'utf8',env:{...process.env,ANALYTICS_DB_PATH:path,ANALYTICS_ROLLUP_MAX_FACTS_PER_DAY:'1',ANALYTICS_ROLLUP_MAX_DAY_MS:'30000'},timeout:10000});
let run=cli();assert.equal(run.status,0,run.stderr);let result=JSON.parse(run.stdout.trim());assert.equal(result.ok,false);assert.equal(result.partial,true);assert.equal(result.rebuilt_days,1);assert.equal(result.rollup.failed_days.length,1);assert.equal(result.rollup.failed_days[0].reason,'budget_exceeded');assert.equal(result.pruned.events,1);assert.equal(result.pruned.batches,1);
assert.equal(store.db.prepare('SELECT phase FROM maintenance_order ORDER BY position LIMIT 1').get()!.phase,'ttl','TTL必须先提交，不能依赖耗时rollup结束后finally');
const wrapped=spawnSync(process.execPath,['scripts/analytics-maintenance.mjs','rollup'],{cwd:process.cwd(),encoding:'utf8',env:{...process.env,ANALYTICS_DB_PATH:path,ANALYTICS_ROLLUP_MAX_FACTS_PER_DAY:'1'},timeout:10000});
assert.equal(wrapped.status,0,wrapped.stderr);const wrappedResult=JSON.parse(wrapped.stdout.trim());assert.equal(wrappedResult.ok,false,'wrapper不能把部分失败包装为ok:true');assert.equal(wrappedResult.partial,true);assert.equal(wrappedResult.result.ok,false);
const backed=spawnSync(process.execPath,['scripts/analytics-maintenance.mjs','backup'],{cwd:process.cwd(),encoding:'utf8',env:{...process.env,ANALYTICS_DB_PATH:path,ANALYTICS_BACKUP_DIR:join(dir,'backups')},timeout:10000});
assert.equal(backed.status,0,backed.stderr);const backupResult=JSON.parse(backed.stdout.trim());assert.equal(backupResult.ok,true,'Python备份成功不能因其结果无ok键被误报失败');assert.equal(backupResult.partial,false);assert.equal(backupResult.result.integrity_check,'ok');
assert.ok(Number(store.db.prepare('SELECT value FROM analytics_meta WHERE key=?').get('last_backup_success_ms')!.value)>0);
assert.equal(store.db.prepare('SELECT count(*) n FROM analytics_rollup_fact WHERE day=?').get(ancient)!.n,0);assert.equal(store.db.prepare('SELECT count(*) n FROM analytics_day WHERE day=?').get(ancient)!.n,0);assert.equal(store.db.prepare('SELECT count(*) n FROM analytics_event_seen').get()!.n,1);
// Fatal rollup metadata failure must also leave TTL independent.
expired('expired-after-fatal');store.db.exec(`CREATE TRIGGER block_rollup_watermark BEFORE UPDATE ON analytics_meta WHEN NEW.key='last_rollup_attempt_ms' BEGIN SELECT RAISE(ABORT,'test-only-failure'); END;`);
run=cli();assert.equal(run.status,1);result=JSON.parse(run.stdout.trim());assert.equal(result.rollup_error,'ANALYTICS_ROLLUP_FAILED');assert.equal(result.pruned.events,1);assert.equal(result.pruned.batches,1);
store.db.exec('DROP TRIGGER block_rollup_watermark');
store.db.prepare('DELETE FROM analytics_rollup_fact WHERE day=? AND id_digest=?').run(badDay,'over-budget-2');
rollupDirtyDays(store,now+1000,16,{maxFactsPerDay:1,maxDayMs:30000});assert.equal(store.db.prepare('SELECT value FROM analytics_meta WHERE key=?').get('last_rollup_status')!.value,'complete');assert.equal(store.db.prepare('SELECT value FROM analytics_meta WHERE key=?').get('last_rollup_success_ms')!.value,String(now+1000));
const retryDay=cstDay(now+2*DAY_MS),futureHealthy=cstDay(now+3*DAY_MS);
fact(retryDay,'retry-bad-1');fact(retryDay,'retry-bad-2');fact(futureHealthy,'fair-healthy');
assert.equal(rollupDirtyDays(store,now+2000,1,{maxFactsPerDay:1,maxDayMs:30000}),0);
assert.equal(rollupDirtyDays(store,now+3000,1,{maxFactsPerDay:1,maxDayMs:30000}),1,'失败日不能独占每轮候选slot使后来日期饥饿');
store.transaction(()=>{for(let i=0;i<1001;i++)expired('bounded-'+i);});
run=cli();assert.equal(run.status,0,run.stderr);result=JSON.parse(run.stdout.trim());assert.equal(result.pruned.events,1001);assert.equal(result.pruned.batches,300);assert.equal(result.pruned.chunks,300);
assert.equal(store.db.prepare('SELECT count(*) n FROM analytics_event').get()!.n,0,'短事务周期可清理多批raw，批结算另限每事务1批');
assert.equal(store.db.prepare('SELECT count(*) n FROM analytics_batch').get()!.n,701);
assert.equal(store.db.prepare('SELECT count(*) n FROM analytics_event_seen').get()!.n,1,'TTL不减少seen');
expired('failure-probe');
store.db.exec(`CREATE TRIGGER block_prune BEFORE DELETE ON analytics_event BEGIN SELECT RAISE(ABORT,'test-only-prune-failure'); END;`);
run=cli();assert.equal(run.status,1);result=JSON.parse(run.stdout.trim());assert.equal(result.ok,false);assert.equal(result.prune_error,'ANALYTICS_PRUNE_FAILED');
assert.equal(store.db.prepare('SELECT count(*) n FROM analytics_event').get()!.n,1,'失败TTL事务必须回滚');
store.close();rmSync(dir,{recursive:true,force:true});console.log('analytics maintenance: PASS (isolated budget failures, healthy-day continuation, independent TTL despite partial/fatal rollup, honest watermarks)');
