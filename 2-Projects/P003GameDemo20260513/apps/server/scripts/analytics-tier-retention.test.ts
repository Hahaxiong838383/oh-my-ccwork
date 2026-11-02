import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AnalyticsStore,DAY_MS,cstDay} from '../src/analytics/store.js';
import {pruneAnalytics} from '../src/analytics/rollup.js';
const dir=mkdtempSync(join(tmpdir(),'analytics-tier-ttl-')),store=new AnalyticsStore(join(dir,'analytics.db')),now=Date.now();
try{
 assert.ok(store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='analytics_tier_event'").get(),'additive tier storage required');
 const insert=store.db.prepare('INSERT INTO analytics_tier_event VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
 function add(id:string,tier:string,age:number){
  const received=now-age*DAY_MS,name=tier==='aggregate'?'analytics.periodic_aggregate':'analytics.on_demand_sample';
  insert.run('synthetic',id,name,received,received,'synthetic-session',1,'normal','{}','{}',id,cstDay(received),cstDay(received),0,tier,'settings.page_opened',10,tier==='diagnostic'?'synthetic-request':null);
  store.db.prepare('INSERT INTO analytics_event_seen VALUES (?,?,?,?)').run('synthetic',id,'hash',received);
 }
 add('aggregate-old','aggregate',91);add('aggregate-boundary','aggregate',90);add('aggregate-keep','aggregate',15);
 add('diagnostic-old','diagnostic',4);add('diagnostic-boundary','diagnostic',3);add('diagnostic-keep','diagnostic',1);
 assert.equal(pruneAnalytics(store,now,1).events,1,'one shared expired-payload budget');
 assert.equal(pruneAnalytics(store,now,1).events,1);
 assert.equal(pruneAnalytics(store,now,1).events,0);
 assert.deepEqual(store.db.prepare('SELECT client_event_id FROM analytics_tier_event ORDER BY client_event_id').all().map(r=>r.client_event_id),['aggregate-boundary','aggregate-keep','diagnostic-boundary','diagnostic-keep']);
 assert.equal(store.db.prepare('SELECT count(*) n FROM analytics_event_seen').get()!.n,6,'payload expiry never erases dedupe protection');
 const plan=store.db.prepare('EXPLAIN QUERY PLAN SELECT rowid FROM analytics_tier_event WHERE tier=? AND received_at_ms<? LIMIT ?').all('diagnostic',now-3*DAY_MS,1000);
 assert.ok(plan.every(r=>!String(r.detail).includes('SCAN')),'TTL must use an indexed expired range');
 console.log('analytics tier retention: PASS (90d aggregate, 3d sample, receive-time boundary, bounded deletes, permanent seen)');
}finally{store.close();rmSync(dir,{recursive:true,force:true});}
