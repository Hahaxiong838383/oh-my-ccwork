import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {AnalyticsStore,cstDay,DAY_MS} from '../src/analytics/store.js';import {rollupDirtyDaysWithStatus} from '../src/analytics/rollup.js';
const dir=mkdtempSync(join(tmpdir(),'t4-run-budget-')),s=new AnalyticsStore(join(dir,'db')),now=Date.now();
try{
 for(let i=0;i<2;i++){const day=cstDay(now-i*DAY_MS);s.db.prepare('INSERT INTO analytics_rollup_fact VALUES (?,?,?,?,?,?,?,?,?)').run('received',day,'device',String(i),'app.bridge_ready','s',0,'{}',now);s.db.prepare('INSERT INTO analytics_dirty_day VALUES (?,?)').run('received',day);}
 const prepare=s.db.prepare.bind(s.db);s.db.prepare=((sql:string)=>{const st=prepare(sql);if(sql.startsWith('SELECT * FROM analytics_rollup_fact')){const it=st.iterate.bind(st);st.iterate=function*(...args:any[]){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);yield* it(...args);} as any;}return st;}) as any;
 const result=rollupDirtyDaysWithStatus(s,now,16,{maxFactsPerDay:100,maxDayMs:1000,maxRunMs:1} as any);s.db.prepare=prepare;
 assert.equal(result.attempted_days,1,'whole-run budget must stop before the next day');assert.equal(result.rebuilt_days,1);assert.equal(result.remaining_dirty_days,1);assert.equal(result.partial,true);
 assert.equal(rollupDirtyDaysWithStatus(s,now).partial,false);
 console.log('PASS whole-run budget stops between atomic days, preserves remaining dirty and resumes');
}finally{s.close();rmSync(dir,{recursive:true,force:true});}
