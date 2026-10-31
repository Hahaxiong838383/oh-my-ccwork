import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync,symlinkSync,statSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {createHmac} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {readReplay,openReadOnly} from '../src/economy-shadow/source.js';
import {ShadowStore,writeReport} from '../src/economy-shadow/store.js';
import {renderReport} from '../src/economy-shadow/report.js';
import {evaluateReplay} from '../src/economy-shadow/evaluate.js';
const SN='BJP00399999999999901',START=Date.parse('2026-10-31T00:00:00+08:00'),CUT=START+86400000+1000;
function fixture(){const root=mkdtempSync(join(tmpdir(),'economy-shadow-'));const a=join(root,'analytics.db'),t=join(root,'telemetry.db');
 const db=new DatabaseSync(a);db.exec(`CREATE TABLE analytics_event(device_key TEXT,client_event_id TEXT,event_name TEXT,occurred_at_ms INTEGER,received_at_ms INTEGER,session_id TEXT,clock_suspicious INTEGER,properties_json TEXT,batch_attempt_id TEXT);CREATE TABLE analytics_batch(attempt_id TEXT,client_json TEXT);`);
 db.prepare('INSERT INTO analytics_batch VALUES(?,?)').run('b',JSON.stringify({content_version:'test-content'}));
 const key=createHmac('sha256','test-secret').update('p003-analytics-v1\0'+SN).digest('hex');
 function event(id:string,n:number=600,keyOverride=key){db.prepare('INSERT INTO analytics_event VALUES(?,?,?,?,?,?,?,?,?)').run(keyOverride,id,'g1.progress_checkpoint',START+10000,CUT-1,'s',0,JSON.stringify({logical_day:'2026-10-31',elapsed_seconds:n,secret:'must-not-export'}),'b');}
 const tel=new DatabaseSync(t);tel.exec('CREATE TABLE device_telemetry_event(sn TEXT,event_id TEXT,type TEXT,occurred_at_ms INTEGER,server_received_ms INTEGER,clock_skew_ms INTEGER,data_json TEXT);');
 const opts={analyticsPath:a,telemetryPath:t,deviceKeySecret:'test-secret',subject:SN,day:'2026-10-31',cutoff_ms:CUT};
 return {root,a,t,db,tel,event,opts,done(){db.close();tel.close();rmSync(root,{recursive:true,force:true});}};
}
test('readers are SQLite read-only and cannot create missing sources',()=>{const f=fixture();try{const c=openReadOnly(f.a);assert.throws(()=>c.exec('CREATE TABLE forbidden(x)'));c.close();assert.throws(()=>openReadOnly(join(f.root,'missing.db')));}finally{f.done();}});
test('bounded scoped extraction strips unrelated fields, no other device',()=>{const f=fixture();try{f.event('a');f.event('b',800,'other');const r=readReplay(f.opts);assert.equal(r.analytics.length,1);assert.equal(r.analytics[0].data.secret,undefined);assert.equal(r.analytics[0].version,'test-content');assert.equal(r.truncated.analytics,false);}finally{f.done();}});
test('limit plus one exposes truncation rather than completeness',()=>{const f=fixture();try{f.event('a');f.event('b');const r=readReplay({...f.opts,rowLimit:1});assert.equal(r.analytics.length,1);assert.equal(r.truncated.analytics,true);assert.ok(evaluateReplay(r).issues.includes('source_truncated'));}finally{f.done();}});
test('GM logical day evidence survives a wrong occurrence date in the SQL adapter',()=>{const f=fixture();try{
 f.event('a');const key=createHmac('sha256','test-secret').update('p003-analytics-v1\0'+SN).digest('hex');
 f.db.prepare('INSERT INTO analytics_event VALUES(?,?,?,?,?,?,?,?,?)').run(key,'gm','g1.logical_day_changed',CUT+86400000,CUT-1,'s',1,JSON.stringify({logical_day:'2026-10-31',gm_override:true}),'b');
 const r=evaluateReplay(readReplay(f.opts));assert.ok(r.issues.includes('gm_evidence'));assert.equal(r.scenario,null);
}finally{f.done();}});
test('cross-midnight telemetry segment ending next day is still selected',()=>{const f=fixture();try{f.tel.prepare('INSERT INTO device_telemetry_event VALUES(?,?,?,?,?,?,?)').run(SN,'s','focus_segment',START+86400000+5000,CUT+5000,0,JSON.stringify({start_ms:START+86400000-10000,end_ms:START+86400000+5000,focus_id:'f'}));const r=readReplay({...f.opts,cutoff_ms:CUT+10000});assert.equal(evaluateReplay(r).observed.telemetry_union_ms,10000);}finally{f.done();}});
test('same replay stored once and reopening retains identity',()=>{const f=fixture();try{const r=evaluateReplay(readReplay(f.opts));let s=new ShadowStore(join(f.root,'shadow.db'));assert.equal(s.save(r),'inserted');assert.equal(s.save(r),'duplicate');s.close();s=new ShadowStore(join(f.root,'shadow.db'));assert.equal(s.save(r),'duplicate');assert.throws(()=>s.save({...r,observed:{...r.observed,reward_instances:99}}));s.close();}finally{f.done();}});
test('foreign SQLite database rejected without mutations',()=>{const f=fixture();try{const before=readFileSync(f.a);assert.throws(()=>new ShadowStore(f.a));assert.deepEqual(readFileSync(f.a),before);}finally{f.done();}});
test('dangling symlink shadow path cannot create an unintended database',()=>{const f=fixture();try{const link=join(f.root,'link.db');symlinkSync(join(f.root,'absent.db'),link);assert.throws(()=>new ShadowStore(link));}finally{f.done();}});
test('same rule revision cannot silently change contents',()=>{const f=fixture();try{f.event('a');const base={schema_version:1,purpose:'scenario_only',revision:'r',source_sha256:'b'.repeat(64),stages:[{id:'s',target_seconds:300,rewards:[{item_id:'C',quantity:1}]}]};const s=new ShadowStore(join(f.root,'shadow.db'));s.save(evaluateReplay(readReplay(f.opts),base,'checkpoint_max'));assert.throws(()=>s.save(evaluateReplay(readReplay(f.opts),{...base,source_sha256:'c'.repeat(64)},'checkpoint_max')));s.close();}finally{f.done();}});
test('immutable report file cannot overwrite data and mode stays private',()=>{const f=fixture();try{const path=join(f.root,'report.md');writeReport(path,'first');writeReport(path,'first');assert.throws(()=>writeReport(path,'second'));assert.equal(readFileSync(path,'utf8'),'first');assert.equal(statSync(path).mode&0o777,0o600);const link=join(f.root,'link.md');symlinkSync(f.a,link);assert.throws(()=>writeReport(link,'bad'));}finally{f.done();}});
test('shareable markdown explicitly distinguishes unknown and hypothetical',()=>{const f=fixture();try{const md=renderReport(evaluateReplay(readReplay(f.opts)));assert.match(md,/未进行正式发奖/);assert.match(md,/未知/);assert.doesNotMatch(md,new RegExp(SN));}finally{f.done();}});
test('CLI executes actual isolated reader and repeats without production mutations',()=>{const f=fixture();try{
 f.event('a');const beforeA=readFileSync(f.a),beforeT=readFileSync(f.t),output=join(f.root,'reports');
 const args=['--experimental-sqlite','--import','tsx','scripts/economy-shadow.ts','--subject',SN,'--day','2026-10-31','--cutoff-ms',String(CUT),'--output-dir',output];
 for(const expected of ['inserted','duplicate']){const p=spawnSync(process.execPath,args,{encoding:'utf8',timeout:10000,env:{...process.env,ANALYTICS_DB_PATH:f.a,TELEMETRY_DB_PATH:f.t,ANALYTICS_DEVICE_KEY_SECRET:'test-secret'}});assert.equal(p.status,0,p.stderr);assert.equal(JSON.parse(p.stdout).status,expected);}
 assert.deepEqual(readFileSync(f.a),beforeA);assert.deepEqual(readFileSync(f.t),beforeT);
}finally{f.done();}});
test('CLI rejects output enclosing sources and rejects unsupported rule switches',()=>{const f=fixture();try{
 const data=join(f.root,'input.json');writeFileSync(data,JSON.stringify(readReplay(f.opts)));
 const p=spawnSync(process.execPath,['--experimental-sqlite','--import','tsx','scripts/economy-shadow.ts','--input',data,'--output-dir',f.root],{encoding:'utf8',timeout:10000});assert.equal(p.status,1);assert.match(p.stderr,/output_contains_source/);
 const q=spawnSync(process.execPath,['--experimental-sqlite','--import','tsx','scripts/economy-shadow.ts','--live','true'],{encoding:'utf8',timeout:10000});assert.equal(q.status,1);assert.match(q.stderr,/invalid_arguments/);
}finally{f.done();}});
test('CLI kills a slow read at five seconds without report or source mutation',()=>{const f=fixture();try{
 f.db.exec(`DROP TABLE analytics_event; CREATE VIEW analytics_event AS WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000000)
 SELECT CAST(x AS TEXT) device_key,CAST(x AS TEXT) client_event_id,'g1.progress_checkpoint' event_name,${START+1000} occurred_at_ms,${CUT-1} received_at_ms,'s' session_id,0 clock_suspicious,'{}' properties_json,'b' batch_attempt_id FROM n;`);
 const before=readFileSync(f.a),out=join(f.root,'timeout-report'),started=Date.now();
 const p=spawnSync(process.execPath,['--experimental-sqlite','--import','tsx','scripts/economy-shadow.ts','--subject',SN,'--day','2026-10-31','--cutoff-ms',String(CUT),'--output-dir',out],{encoding:'utf8',timeout:12000,env:{...process.env,ANALYTICS_DB_PATH:f.a,TELEMETRY_DB_PATH:f.t,ANALYTICS_DEVICE_KEY_SECRET:'secret-must-not-leak'}});
 assert.equal(p.status,1,p.stderr);assert.ok(Date.now()-started>=4500&&Date.now()-started<10000);assert.match(p.stderr,/shadow_run_failed/);assert.doesNotMatch(p.stderr,/secret-must-not-leak/);assert.equal(existsSync(out),false);assert.deepEqual(readFileSync(f.a),before);
}finally{f.done();}});
