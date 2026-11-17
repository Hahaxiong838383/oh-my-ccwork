import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {AnalyticsStore} from '/opt/p003/archive-t5-20261117/candidate-ab88de96/2-Projects/P003GameDemo20260513/apps/server/src/analytics/store.ts';
import {rollupDirtyDaysWithStatus} from '/opt/p003/archive-t5-20261117/candidate-ab88de96/2-Projects/P003GameDemo20260513/apps/server/src/analytics/rollup.ts';
const file='/opt/p003/archive-t5-20261117/covering-profile-01/analytics-copy.db';const store=new AnalyticsStore(file);
try{
 const before={seen:Number(store.db.prepare('SELECT count(*) n FROM analytics_event_seen').get()!.n),raw:Number(store.db.prepare('SELECT count(*) n FROM analytics_event').get()!.n),facts:Number(store.db.prepare('SELECT count(*) n FROM analytics_rollup_fact').get()!.n)};
 for(const dim of ['occurred','received'])store.db.prepare('INSERT OR IGNORE INTO analytics_dirty_day VALUES (?,?)').run(dim,'2026-11-17');
 store.db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA shrink_memory');
 execFileSync('python3',['-c',"import os;f=os.open("+JSON.stringify(file)+",os.O_RDONLY);os.posix_fadvise(f,0,0,os.POSIX_FADV_DONTNEED);os.close(f)"]);
 const start=performance.now(),status=rollupDirtyDaysWithStatus(store);const ms=performance.now()-start;
 const summaries=store.db.prepare('SELECT dimension,summary_json FROM analytics_day ORDER BY dimension,day').all().map(r=>({dimension:r.dimension,summary:JSON.parse(String(r.summary_json))}));
 const perDevice=store.db.prepare('SELECT dimension,device_key,event_count FROM analytics_device_day ORDER BY dimension,device_key').all();
 const after={seen:Number(store.db.prepare('SELECT count(*) n FROM analytics_event_seen').get()!.n),raw:Number(store.db.prepare('SELECT count(*) n FROM analytics_event').get()!.n),facts:Number(store.db.prepare('SELECT count(*) n FROM analytics_rollup_fact').get()!.n)};
 const result={status,ms,before,after,day_counts:summaries.map(r=>({dimension:r.dimension,event_count:r.summary.event_count,active_devices:r.summary.active_devices})),device_days:perDevice.length,all_device_counts_6000:perDevice.every(r=>r.event_count===6000),rss:process.memoryUsage().rss};
 writeFileSync('/opt/p003/archive-t5-20261117/covering-profile-01/actual-rollup-result.json',JSON.stringify(result,null,2)+'\n');
 assert.deepEqual(after,before);assert.equal(status.failed_days.length,0);assert.equal(status.remaining_dirty_days,0);assert.equal(status.rebuilt_days,2);assert.equal(perDevice.length,100);assert(perDevice.every(r=>r.event_count===6000));assert(summaries.every(r=>r.summary.event_count===300000&&r.summary.active_devices===50));console.log(JSON.stringify(result));
}finally{store.close();}
