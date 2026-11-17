import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {AnalyticsStore,cstDay} from '../src/analytics/store.js';
import {rollupDirtyDaysWithStatus,pruneAnalytics} from '../src/analytics/rollup.js';

if(process.argv[2]==='crash-after-first-device'){
 const child=new AnalyticsStore(process.argv[3]),prepare=child.db.prepare.bind(child.db);
 child.db.prepare=((sql:string)=>{const stmt=prepare(sql);if(sql.startsWith('SELECT ')&&sql.includes('semantic_json')&&sql.includes('FROM analytics_rollup_fact')){
  const iterate=stmt.iterate.bind(stmt);stmt.iterate=function*(...args:any[]){for(const row of iterate(...args) as Iterable<any>){if(row.device_key==='b')process.exit(42);yield row;}} as any;
 }return stmt;}) as any;
 rollupDirtyDaysWithStatus(child,Number(process.argv[4]));process.exit(43);
}

const dir=mkdtempSync(join(tmpdir(),'rollup-resume-')),path=join(dir,'test.db');
const now=Date.now(),day=cstDay(now);
let store=new AnalyticsStore(path);
const insert=(s:AnalyticsStore,device:string,id:string,name='app.session_started',semantic='{}')=>{
 s.db.prepare('INSERT INTO analytics_rollup_fact VALUES (?,?,?,?,?,?,?,?,?)').run('received',day,device,id,name,'same-session',0,semantic,now);
 s.db.prepare('INSERT OR IGNORE INTO analytics_dirty_day VALUES (?,?)').run('received',day);
};
try{
 for(const device of ['a','b','c'])insert(store,device,'first');
 // Real SQLite, and a slow fact source: each device costs 25ms, a whole day
 // cannot fit the unchanged per-call 40ms budget. Reopen between attempts.
 let completed=0;
 for(let attempt=0;attempt<4&&!completed;attempt++){
  const prepare=store.db.prepare.bind(store.db);
  store.db.prepare=((sql:string)=>{const stmt=prepare(sql);
   if(sql.startsWith('SELECT ')&&sql.includes('semantic_json')&&sql.includes('FROM analytics_rollup_fact')){
    const iterate=stmt.iterate.bind(stmt);stmt.iterate=function*(...args:any[]){let device='';for(const row of iterate(...args) as Iterable<any>){if(device!==row.device_key){device=row.device_key;const until=performance.now()+25;while(performance.now()<until){}}yield row;}} as any;
   }return stmt;}) as any;
  const result=rollupDirtyDaysWithStatus(store,now+attempt,16,{maxFactsPerDay:1000,maxDayMs:40});
  store.db.prepare=prepare;completed=result.rebuilt_days;
  if(!completed){assert.equal(store.db.prepare('SELECT count(*) n FROM analytics_day').get()!.n,0,'never expose partial day');assert.equal(result.remaining_dirty_days,1);}
  store.close();store=new AnalyticsStore(path);
 }
 assert.equal(completed,1,'bounded attempts must retain completed devices across real connection restarts');
 const result=JSON.parse(String(store.db.prepare('SELECT summary_json FROM analytics_day').get()!.summary_json));
 assert.equal(result.event_count,3);assert.equal(result.sessions,3);assert.equal(result.active_devices,3);
 assert.equal(store.db.prepare('SELECT count(*) n FROM analytics_dirty_day').get()!.n,0);
 console.log('PASS bounded restart continuation, exact device-scoped sessions, no partial public summary');

 // Start from a previously published day. Unrelated writes are allowed, but
 // changing an already folded device or adding a new device prevents publishing.
 insert(store,'a','reward','g1.reward_granted','{"reward_instance_digest":"r1","gm_override":true}');
 insert(store,'b','reward','g1.reward_granted','{"reward_instance_digest":"r1"}');
 const other=new AnalyticsStore(path);
 const race=(during:string,write:()=>void)=>{
  const prepare=store.db.prepare.bind(store.db);let injected=false;
  store.db.prepare=((sql:string)=>{const stmt=prepare(sql);if(sql.startsWith('SELECT ')&&sql.includes('semantic_json')&&sql.includes('FROM analytics_rollup_fact')){
   const iterate=stmt.iterate.bind(stmt);stmt.iterate=function*(...args:any[]){for(const row of iterate(...args) as Iterable<any>){if(!injected&&row.device_key===during){injected=true;other.transaction(write);}yield row;}} as any;
  }return stmt;}) as any;
  try{const result=rollupDirtyDaysWithStatus(store,now);assert.equal(injected,true);return result;}finally{store.db.prepare=prepare;}
 };
 try{
  const changed=race('b',()=>insert(other,'a','late'));
  assert.equal(changed.rebuilt_days,0);assert.equal(changed.failed_days[0].reason,'concurrent_write');
  assert.equal(JSON.parse(String(store.db.prepare('SELECT summary_json FROM analytics_day').get()!.summary_json)).event_count,3);
  assert.equal(rollupDirtyDaysWithStatus(store,now).rebuilt_days,1);
  let summary=JSON.parse(String(store.db.prepare('SELECT summary_json FROM analytics_day').get()!.summary_json));
  assert.equal(summary.event_count,6);assert.equal(summary.unique_reward_instances,2);assert.equal(summary.explicit_gm_events,1);
  insert(store,'b','another');
  assert.equal(race('b',()=>insert(other,'d','new-device')).rebuilt_days,0);
  assert.equal(rollupDirtyDaysWithStatus(store,now).rebuilt_days,1);
  // Mutations and TTL-style deletes invalidate the affected device too.
  other.db.prepare("UPDATE analytics_rollup_fact SET semantic_json='{}' WHERE device_key='a' AND id_digest='reward'").run();
  other.db.prepare("DELETE FROM analytics_rollup_fact WHERE device_key='c'").run();
  assert.equal(rollupDirtyDaysWithStatus(store,now).rebuilt_days,1);
  summary=JSON.parse(String(store.db.prepare('SELECT summary_json FROM analytics_day').get()!.summary_json));
  assert.equal(summary.event_count,7);assert.equal(summary.active_devices,3);assert.equal(summary.unique_reward_instances,1);assert.equal(summary.explicit_gm_events,0);
  assert.equal(store.db.prepare("SELECT count(*) n FROM analytics_device_day WHERE device_key='c'").get()!.n,0);
  console.log('PASS late writes, newly arriving device, update/delete invalidation, exact rewards/GM');
 }finally{other.close();}

 // A real process exit must preserve only committed private stages, never an
 // incomplete public result; the replacement process resumes without rereading a.
 for(const device of ['a','b'])insert(store,device,'crash-run');
 const before=String(store.db.prepare('SELECT summary_json FROM analytics_day').get()!.summary_json);
 store.close();
 const child=spawnSync(process.execPath,['--import','tsx',fileURLToPath(import.meta.url),'crash-after-first-device',path,String(now)],{encoding:'utf8',timeout:10000});
 store=new AnalyticsStore(path);assert.equal(child.status,42,child.stderr);
 assert.equal(String(store.db.prepare('SELECT summary_json FROM analytics_day').get()!.summary_json),before);
 const prepare=store.db.prepare.bind(store.db);let rereadA=false;
 store.db.prepare=((sql:string)=>{const stmt=prepare(sql);if(sql.startsWith('SELECT ')&&sql.includes('semantic_json')&&sql.includes('FROM analytics_rollup_fact')){
  const iterate=stmt.iterate.bind(stmt);stmt.iterate=function*(...args:any[]){for(const row of iterate(...args) as Iterable<any>){if(row.device_key==='a')rereadA=true;yield row;}} as any;
 }return stmt;}) as any;
 assert.equal(rollupDirtyDaysWithStatus(store,now).rebuilt_days,1);store.db.prepare=prepare;assert.equal(rereadA,false);
 assert.equal(JSON.parse(String(store.db.prepare('SELECT summary_json FROM analytics_day').get()!.summary_json)).event_count,9);
 console.log('PASS real child exit, durable private progress, unchanged public summary, replacement resumes');

 // A failure key outside every device's top100 can still be the global winner.
 store.transaction(()=>{for(const device of ['a','b','d']){
  for(let i=0;i<100;i++)for(let j=0;j<2;j++)insert(store,device,`failure-${i}-${j}`,'g1.command_failed',JSON.stringify({command:`${device}-${i}`,error_code:'E'}));
  insert(store,device,'failure-shared','g1.command_failed','{"command":"shared","error_code":"E"}');
 }});
 assert.equal(rollupDirtyDaysWithStatus(store,now).rebuilt_days,1);
 const final=JSON.parse(String(store.db.prepare('SELECT summary_json FROM analytics_day').get()!.summary_json));
 assert.equal(final.event_count,612);assert.deepEqual(final.groups.command_failures[0],{command:'shared',error_code:'E',count:3});assert.equal(final.groups.command_failures.length,100);
 console.log('PASS exact global failure ranking without premature device truncation');

 const incremental=new AnalyticsStore(join(dir,'incremental.db'));
 try{
  insert(incremental,'a','prefix-session','app.session_started','{"marker":"already-folded"}');
  insert(incremental,'a','prefix-reward','g1.reward_granted','{"reward_instance_digest":"r1","marker":"already-folded"}');
  assert.equal(rollupDirtyDaysWithStatus(incremental,now).rebuilt_days,1);
  insert(incremental,'a','repeated-session');insert(incremental,'a','repeated-reward','g1.reward_granted','{"reward_instance_digest":"r1"}');
  incremental.db.prepare('INSERT INTO analytics_rollup_fact VALUES (?,?,?,?,?,?,?,?,?)').run('received',day,'a','late-clock','app.session_started','s2',1,'{}',now-100);
  const parse=JSON.parse;let oldParsed=0;
  JSON.parse=((value:string,...args:any[])=>{if(value.includes('already-folded'))oldParsed++;return parse(value,...args);}) as typeof JSON.parse;
  try{assert.equal(rollupDirtyDaysWithStatus(incremental,now).rebuilt_days,1);}finally{JSON.parse=parse;}
  assert.equal(oldParsed,0,'new arrivals do not parse the folded JSON prefix again');
  let s=JSON.parse(String(incremental.db.prepare('SELECT summary_json FROM analytics_day').get()!.summary_json));
  assert.equal(s.event_count,5);assert.equal(s.sessions,2);assert.equal(s.unique_reward_instances,1);assert.equal(s.clock_suspicious_events,1);
  // Delete highest rowid and insert its replacement: a naive MAX(rowid) cursor
  // would miss this. The mutation generation forces rebuilding this device.
  const high=Number(incremental.db.prepare('SELECT max(rowid) n FROM analytics_rollup_fact').get()!.n);
  incremental.db.prepare('DELETE FROM analytics_rollup_fact WHERE rowid=?').run(high);
  insert(incremental,'a','replacement','g1.reward_granted','{"reward_instance_digest":"r2"}');
  assert.equal(Number(incremental.db.prepare('SELECT max(rowid) n FROM analytics_rollup_fact').get()!.n),high);
  assert.equal(rollupDirtyDaysWithStatus(incremental,now).rebuilt_days,1);
  s=JSON.parse(String(incremental.db.prepare('SELECT summary_json FROM analytics_day').get()!.summary_json));
  assert.equal(s.event_count,5);assert.equal(s.sessions,1);assert.equal(s.unique_reward_instances,2);assert.equal(s.clock_suspicious_events,0);
  // A failed stage commit rolls back both the distinct row and prefix movement.
  insert(incremental,'a','r3','g1.reward_granted','{"reward_instance_digest":"r3"}');
  incremental.db.exec("CREATE TRIGGER fail_stage BEFORE INSERT ON analytics_rollup_device_stage BEGIN SELECT RAISE(ABORT,'test-stage-commit'); END");
  assert.equal(rollupDirtyDaysWithStatus(incremental,now).rebuilt_days,0);
  assert.equal(incremental.db.prepare("SELECT count(*) n FROM analytics_rollup_distinct WHERE digest='r3'").get()!.n,0);
  incremental.db.exec('DROP TRIGGER fail_stage');assert.equal(rollupDirtyDaysWithStatus(incremental,now).rebuilt_days,1);
  assert.equal(JSON.parse(String(incremental.db.prepare('SELECT summary_json FROM analytics_day').get()!.summary_json)).unique_reward_instances,3);
  pruneAnalytics(incremental,now+91*86400000);
  for(const table of ['analytics_rollup_fact','analytics_rollup_source','analytics_rollup_device_stage','analytics_rollup_distinct','analytics_dirty_day'])assert.equal(incremental.db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n,0,table);
  console.log('PASS incremental-only parsing, cross-run exact distinct, backdated time, rowid reuse, failed commit rollback, 90d private TTL');
 }finally{incremental.close();}
}finally{store.close();rmSync(dir,{recursive:true,force:true});}
