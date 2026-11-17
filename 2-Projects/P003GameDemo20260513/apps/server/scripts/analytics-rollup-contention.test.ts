import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {AnalyticsStore,cstDay} from '../src/analytics/store.js';
import {rollupDirtyDaysWithStatus} from '../src/analytics/rollup.js';
import {installRollupPrefixIndex} from '../src/analytics/rollup-index.js';
const pause=new Int32Array(new SharedArrayBuffer(4));
if(process.argv[2]==='hold-writer'){
 const s=new AnalyticsStore(process.argv[3]),flag=process.argv[4];writeFileSync(flag+'.ready','');
 const timer=setInterval(()=>{if(!existsSync(flag+'.request'))return;clearInterval(timer);s.db.exec('BEGIN IMMEDIATE');writeFileSync(flag+'.locked','');setTimeout(()=>{s.db.exec('COMMIT');s.close();writeFileSync(flag+'.released','');},600);},5);
}else{
 const root=mkdtempSync(join(tmpdir(),'rollup-contention-')),path=join(root,'test.db'),flag=join(root,'lock'),s=new AnalyticsStore(path),now=Date.now(),day=cstDay(now);
 let child:ReturnType<typeof spawn>|undefined;
 const waitFile=(p:string)=>{const until=performance.now()+5000;while(!existsSync(p)){assert.ok(performance.now()<until,'child handshake timeout');Atomics.wait(pause,0,0,5);}};
 try{
  installRollupPrefixIndex(s.db);s.transaction(()=>{const put=s.db.prepare('INSERT INTO analytics_rollup_fact VALUES (?,?,?,?,?,?,?,?,?)');for(let i=0;i<1200;i++)put.run('received',day,'a','id'+i,i%2?'app.session_started':'g1.reward_granted','same',0,'{"reward_instance_digest":"r1"}',now);});
  child=spawn(process.execPath,['--import','tsx',fileURLToPath(import.meta.url),'hold-writer',path,flag],{stdio:'ignore'});waitFile(flag+'.ready');
  const prepare=s.db.prepare.bind(s.db);let injected=false;
  s.db.prepare=((sql:string)=>{const stmt=prepare(sql);if(sql.startsWith('SELECT ')&&sql.includes('semantic_json')&&sql.includes('FROM analytics_rollup_fact')){const iterate=stmt.iterate.bind(stmt);stmt.iterate=function*(...args:any[]){for(const row of iterate(...args) as Iterable<any>){if(!injected&&row.fact_rowid===513){injected=true;writeFileSync(flag+'.request','');waitFile(flag+'.locked');}yield row;}} as any;}return stmt;}) as any;
  const result=rollupDirtyDaysWithStatus(s,now,16,{maxFactsPerDay:2000,maxDayMs:3000});s.db.prepare=prepare;
  assert.equal(injected,true);assert.equal(result.rebuilt_days,1,'a transient real writer lock must not abandon the rest of the day');waitFile(flag+'.released');
  let summary=JSON.parse(String(s.db.prepare('SELECT summary_json FROM analytics_day').get()!.summary_json));assert.equal(summary.event_count,1200);assert.equal(summary.sessions,1);assert.equal(summary.unique_reward_instances,1);
  console.log('PASS real competing writer over busy_timeout, paged progress resumes inside original day budget');
  s.db.prepare('INSERT INTO analytics_rollup_fact VALUES (?,?,?,?,?,?,?,?,?)').run('received',day,'a','r2','g1.reward_granted','same',0,'{"reward_instance_digest":"r2"}',now);
  const exec=s.db.exec.bind(s.db);let failedCommit=false;
  s.db.exec=((sql:string)=>{if(sql==='COMMIT'&&!failedCommit&&s.db.prepare("SELECT count(*) n FROM analytics_rollup_distinct WHERE digest='r2'").get()!.n===1){failedCommit=true;throw Object.assign(new Error('busy commit injection'),{errcode:5});}return exec(sql);}) as any;
  const retried=rollupDirtyDaysWithStatus(s,now);s.db.exec=exec;assert.equal(failedCommit,true);assert.equal(retried.rebuilt_days,1);
  summary=JSON.parse(String(s.db.prepare('SELECT summary_json FROM analytics_day').get()!.summary_json));assert.equal(summary.event_count,1201);assert.equal(summary.unique_reward_instances,2,'rollback must discard mutated in-memory counters before retry');
  console.log('PASS retry rebuilds rolled-back page state, no double distinct increment');
  s.db.prepare('INSERT INTO analytics_rollup_fact VALUES (?,?,?,?,?,?,?,?,?)').run('received',day,'a','pending','app.session_started','extra',0,'{}',now);
  let attempts=0;s.db.prepare=((sql:string)=>{if(sql.startsWith('SELECT ')&&sql.includes('semantic_json')&&sql.includes('FROM analytics_rollup_fact')){attempts++;throw Object.assign(new Error('persistent busy'),{errcode:5});}return prepare(sql);}) as any;
  const began=performance.now(),exhausted=rollupDirtyDaysWithStatus(s,now,16,{maxFactsPerDay:2000,maxDayMs:1000});s.db.prepare=prepare;
  assert.ok(performance.now()-began<2000);assert.equal(exhausted.rebuilt_days,0);assert.equal(exhausted.remaining_dirty_days,1);assert.equal(exhausted.failed_days[0].reason,'budget_exceeded');assert.ok(attempts>1&&attempts<300);
  assert.equal(JSON.parse(String(s.db.prepare('SELECT summary_json FROM analytics_day').get()!.summary_json)).event_count,1201);
  console.log('PASS persistent contention bounded by existing day deadline, public summary unchanged');
 }finally{child?.kill('SIGTERM');s.close();rmSync(root,{recursive:true,force:true});}
}
