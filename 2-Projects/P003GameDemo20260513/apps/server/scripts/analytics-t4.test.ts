import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AnalyticsStore,cstDay,DAY_MS} from '../src/analytics/store.js';
import * as rollup from '../src/analytics/rollup.js';
import {readStoragePolicy,readVerifiedProfile} from '../src/storage/policy.js';
import {capacityForecast} from '../src/analytics/capacity.js';
const dir=mkdtempSync(join(tmpdir(),'p003-t4-')),path=join(dir,'test.db');
const store=new AnalyticsStore(path),other=new AnalyticsStore(path),now=Date.now(),day=cstDay(now);
const fact=(s:AnalyticsStore,id:string,d=day)=>{s.db.prepare('INSERT INTO analytics_rollup_fact VALUES (?,?,?,?,?,?,?,?,?)').run('received',d,'device',id,'app.bridge_ready','s',0,'{}',now);s.db.prepare('INSERT OR IGNORE INTO analytics_dirty_day VALUES (?,?)').run('received',d);};
try {
 fact(store,'first');assert.equal(rollup.rollupDirtyDays(store,now),1);fact(store,'second');
 // A real second SQLite writer commits while aggregation reads. Old BEGIN IMMEDIATE blocks it.
 const original=store.db.prepare.bind(store.db);let concurrent=false;
 store.db.prepare=((sql:string)=>{const st=original(sql);if(sql.startsWith('SELECT * FROM analytics_rollup_fact')){const iterate=st.iterate.bind(st);st.iterate=function*(...args:any[]){for(const row of iterate(...args)){if(!concurrent){other.transaction(()=>fact(other,'late'));concurrent=true;}yield row;}} as any;}return st;}) as any;
 const raced=rollup.rollupDirtyDaysWithStatus(store,now);store.db.prepare=original;
 assert.equal(concurrent,true,'aggregation must not hold a writer lock');
 assert.equal(raced.rebuilt_days,0,'snapshot upgrade must reject a stale summary');
 assert.equal(store.db.prepare('SELECT count(*) n FROM analytics_dirty_day').get()!.n,1);
 assert.equal(JSON.parse(String(store.db.prepare('SELECT summary_json FROM analytics_day').get()!.summary_json)).event_count,1,'failed snapshot preserves prior complete summary');
 assert.equal(rollup.rollupDirtyDays(store,now),1);assert.equal(JSON.parse(String(store.db.prepare('SELECT summary_json FROM analytics_day').get()!.summary_json)).event_count,3);
 console.log('PASS concurrent ingestion, no lost dirty day, atomic stale-summary rejection and retry');
 // 7k expired facts prove multiple bounded transactions and a finite cycle, seen is never pruned.
 store.transaction(()=>{for(let i=0;i<7000;i++)fact(store,'old-'+i,cstDay(now-91*DAY_MS));store.db.prepare('INSERT INTO analytics_event_seen VALUES (?,?,?,?)').run('device','permanent','hash',0);});
 assert.equal(typeof rollup.pruneAnalyticsCycle,'function');
 const result=await rollup.pruneAnalyticsCycle(store,now);
 assert.equal(result.facts,3000);assert.equal(result.chunks,300);assert.equal(result.budget_exhausted,true);
 assert.equal(store.db.prepare('SELECT count(*) n FROM analytics_rollup_fact WHERE day<?').get(day)!.n,4000);
 const middle=await rollup.pruneAnalyticsCycle(store,now);assert.equal(middle.facts,3000);assert.equal(middle.budget_exhausted,true);
 const rest=await rollup.pruneAnalyticsCycle(store,now);assert.equal(rest.facts,1000);assert.equal(rest.budget_exhausted,false);
 assert.equal(store.db.prepare('SELECT count(*) n FROM analytics_event_seen').get()!.n,1);
 assert.equal(store.db.prepare('SELECT count(*) n FROM analytics_rollup_fact').get()!.n,3);
 console.log('PASS multi-chunk TTL, finite budget, exact retained rows, permanent dedup');
 const sample={free_bytes:1024**4,total_bytes:2*1024**4,db_bytes:0,wal_bytes:0,daily_peak:6000,sample_devices:50,maintenance_ok:true,checked_at_ms:now};
 const cap=capacityForecast(sample);assert.equal(cap.horizon_days,180);assert.equal(cap.backup_peak_copies,5);assert.equal(cap.ark_spool_reserve_bytes,8*1024**3);
 assert.deepEqual(cap.projections.map(x=>x.horizon_days),[30,90,180]);
 const [a,b,c]=cap.projections;assert.ok(a.bytes_per_device<b.bytes_per_device&&b.bytes_per_device<c.bytes_per_device);assert.equal(b.fact_growth_days,c.fact_growth_days);
 assert.equal(c.seen_growth_days,180);assert.equal(cap.validated_device_limit,14);assert.ok(cap.maintenance_limit>=50);assert.equal(cap.max_enabled_devices,14);
 const migration=capacityForecast(sample,{policy:{...readStoragePolicy(null),archive_enabled:true},profile:readVerifiedProfile(null)});assert.equal(migration.backup_peak_copies,5);assert.equal(migration.bytes_per_device,cap.bytes_per_device);
 const disk=capacityForecast({...sample,free_bytes:12*1024**3});assert.equal(disk.budget_bytes,0);assert.equal(disk.max_enabled_devices,0);
 assert.throws(()=>capacityForecast({...sample,free_bytes:NaN}));
 console.log('PASS 30/90/180 model, 5 transition copies, 8GiB spool, reserve, verified scale unchanged');
} finally {other.close();store.close();rmSync(dir,{recursive:true,force:true});}
