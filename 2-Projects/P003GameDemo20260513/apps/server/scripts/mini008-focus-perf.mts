/** Isolated SQLite only. Deterministic 216000-row baseline + dirty legacy migration. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const dir = mkdtempSync(join(tmpdir(), 'mini008-focus-perf-'));
process.env.TELEMETRY_DB_PATH = join(dir, 'telemetry.db');
const db = new DatabaseSync(process.env.TELEMETRY_DB_PATH);
// Reproduce the existing schema, before importing the new constructor/index.
db.exec(`CREATE TABLE device_telemetry_event (
 sn TEXT NOT NULL, event_id TEXT NOT NULL, type TEXT NOT NULL, occurred_at_ms INTEGER NOT NULL,
 data_json TEXT NOT NULL, payload_hash TEXT NOT NULL, schema_version INTEGER NOT NULL,
 server_received_ms INTEGER NOT NULL, clock_skew_ms INTEGER NOT NULL,
 ingest_trace_id TEXT NOT NULL DEFAULT '', PRIMARY KEY(sn,event_id));
 CREATE INDEX idx_tel_evt_sn_time ON device_telemetry_event(sn,occurred_at_ms DESC);`);
const now = Date.parse('2026-11-11T12:00:00+08:00'), day = 86400000;
const sn = 'synthetic-perf-device';
const insert = db.prepare('INSERT INTO device_telemetry_event VALUES(?,?,?,?,?,?,?,?,?,?)');
db.exec('BEGIN');
for (let i = 0; i < 43200; i++) {
 const end = now - i * 60000;
 insert.run(sn, 'f'+i, 'focus_segment', end, JSON.stringify({start_ms:end-60000,end_ms:end}), 'h'+i, 1, end+100, 100, '');
}
for (let i = 0; i < 172800; i++) insert.run(sn, 'p'+i, 'posture_round', now-i*15000, '{"result":"correct"}', 'p'+i, 1, now-i*15000, 0, '');
const dirty = ['{bad','null','[]','true','123','"text"','{}',
 JSON.stringify({start_ms:String(now-60000),end_ms:now}),
 JSON.stringify({start_ms:now-60000,end_ms:String(now)}),
 JSON.stringify({start_ms:now-60000,end_ms:[]}),
 JSON.stringify({start_ms:now-60000,end_ms:{}}),
 JSON.stringify({start_ms:now-60000,end_ms:null}),
 JSON.stringify({start_ms:now,end_ms:now}),
 JSON.stringify({start_ms:now-day-1,end_ms:now}),
 `{"start_ms":${now-60000},"end_ms":1e999}`];
dirty.forEach((data,i) => insert.run('dirty', 'd'+i, 'focus_segment', now, data, 'd'+i, 1, i+1, 0, ''));
// JSON numeric .0 remains a valid JS safe integer; adjacent/cross-day intervals remain valid.
const midnight = Date.parse('2026-11-11T00:00:00+08:00');
insert.run('legacy', 'first', 'focus_segment', midnight, JSON.stringify({start_ms:midnight-20000,end_ms:midnight+20000}), 'a', 1, 101, 0, '');
insert.run('legacy', 'overlap', 'focus_segment', midnight, JSON.stringify({start_ms:midnight-10000,end_ms:midnight+30000}), 'b', 1, 102, 0, '');
insert.run('legacy', 'adjacent', 'focus_segment', midnight, `{"start_ms":${midnight+30000}.0,"end_ms":${midnight+40000}.0}`, 'c', 1, 103, 0, '');
// Upper end bound must retain max-duration intervals crossing the query window edge.
insert.run('boundary', 'max-day', 'focus_segment', midnight+day-1, JSON.stringify({start_ms:midnight-1,end_ms:midnight+day-1}), 'edge', 1, 104, 0, '');
db.exec('COMMIT');
const digest = () => createHash('sha256').update(JSON.stringify(db.prepare('SELECT * FROM device_telemetry_event ORDER BY sn,event_id').all())).digest('hex');
const before = digest();
// Observe the real SQL sent by production, without changing its execution or results.
const prepare = DatabaseSync.prototype.prepare;
let focusSql = '';
DatabaseSync.prototype.prepare = function(sql: string) {
 if (sql.includes('SELECT event_id, data_json, occurred_at_ms, server_received_ms')) focusSql = sql;
 return prepare.call(this, sql);
};
const bootStart = performance.now();
const root = process.env.SERVER_UNDER_TEST;
const moduleUrl = root ? pathToFileURL(join(root,'src/telemetry-store.ts')) : new URL('../src/telemetry-store.ts', import.meta.url);
const { telemetryStore } = await import(moduleUrl.href);
const bootstrap_ms = performance.now()-bootStart;
assert.equal(digest(), before, 'additive index bootstrap must preserve all existing event bytes');
const rebootStart = performance.now();
await import(moduleUrl.href+'?idempotent-reopen');
const repeat_bootstrap_ms = performance.now()-rebootStart;
assert.equal(digest(), before, 'repeat bootstrap must preserve all existing event bytes');
assert.ok(telemetryStore.usageRange('dirty','2026-11-05','2026-11-11').every((d:any) => !d.available && d.focus_minutes === null && d.updated_at_ms === null));
const legacy = telemetryStore.usageRange('legacy','2026-11-10','2026-11-11');
assert.deepEqual(legacy, [
 {date:'2026-11-10',available:true,focus_minutes:0,updated_at_ms:101},
 {date:'2026-11-11',available:true,focus_minutes:1,updated_at_ms:103},
]);
assert.equal(telemetryStore.usageRange('boundary','2026-11-10','2026-11-10')[0].focus_minutes, 0);
assert.equal(telemetryStore.usageRange('boundary','2026-11-11','2026-11-11')[0].focus_minutes, 1440);
function stats(times: number[]) {
 times.sort((a,b)=>a-b);
 return {samples:times.length,p50_ms:times[12],p95_ms:times[23],max_ms:times[24]};
}
const times: number[] = [];
for (let i=0;i<25;i++) {
 const start=performance.now();
 const daily=telemetryStore.usageRange(sn,'2026-11-05','2026-11-11');
 times.push(performance.now()-start);
 assert.deepEqual(daily.map((d:any)=>d.focus_minutes),[1440,1440,1440,1440,1440,1440,720]);
}
const usage = stats(times);
assert.equal(digest(), before, 'usage reads must not rewrite legacy evidence');
const params = (from:number,to:number) => (focusSql.match(/\?/g)||[]).length === 3 ? [sn,to,from] : [sn,from,to+day,to];
const plan = (from:number,to:number) => prepare.call(db,'EXPLAIN QUERY PLAN '+focusSql).all(...params(from,to));
const plans = {usage:plan(Date.parse('2026-11-04T00:00:00+08:00'),Date.parse('2026-11-13T00:00:00+08:00')),
 ingest_recent:plan(now-60000,now),ingest_historical:plan(now-29*day-60000,now-29*day)};
const meta = {schemaVersion:1,deviceTsMs:now,serverReceivedMs:now+1000,traceId:'isolated-perf'};
function ingest(kind:string,start:number,end:number,id:string) {
 const t=performance.now();
 const outcome=telemetryStore.ingestEvent(sn,{event_id:id,type:'focus_segment',occurred_at_ms:end,data:{start_ms:start,end_ms:end}},meta);
 assert.equal(outcome,kind);
 return performance.now()-t;
}
const recent:number[]=[], historical:number[]=[], accepted:number[]=[];
for(let i=0;i<25;i++) {
 recent.push(ingest('focus_segment_overlap',now-60000,now,'recent'+i));
 historical.push(ingest('focus_segment_overlap',now-29*day-60000,now-29*day,'historical'+i));
 accepted.push(ingest('accepted',now+i*1000,now+(i+1)*1000,'new'+i));
}
// Writes after additive migration must tolerate legacy dirty JSON and preserve normal validation.
assert.equal(telemetryStore.ingestEvent('dirty',{event_id:'valid',type:'focus_segment',occurred_at_ms:now,data:{start_ms:now-60000,end_ms:now}},meta),'accepted');
assert.equal(telemetryStore.ingestEvent('dirty',{event_id:'overlap',type:'focus_segment',occurred_at_ms:now,data:{start_ms:now-1000,end_ms:now}},meta),'focus_segment_overlap');
insert.run('dirty','after-index','focus_segment',now,'{still-bad','after-index',1,now,0,'');
assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');
const report = {scope:'isolated desktop; deterministic 30d focus + 4x posture, no production',rows:216000,
 fixture_now:now,fixture_sha256:before,bootstrap_ms,repeat_bootstrap_ms,usage,preferred_p50_under_50ms:usage.p50_ms<50,ingest_recent:stats(recent),
 ingest_historical:stats(historical),ingest_accepted:stats(accepted),sql:focusSql,plans,
 migration:{rows_unchanged:true,dirty_json_before_and_after:true,integrity:'ok'},db:dir};
console.log(JSON.stringify(report,null,2));
if(process.env.PERF_REPORT) writeFileSync(process.env.PERF_REPORT,JSON.stringify(report,null,2)+'\n');
for(const rows of Object.values(plans)) assert.ok(rows.some((r:any)=>/USING INDEX idx_tel_focus_sn_end .*<expr>>\? AND <expr><\?/.test(r.detail)),'focus lookup must use both end bounds in the index');
// Hardware timing is reported, not a universal CI limit. Compare identical fixtures when supplied.
if(process.env.PERF_BASELINE) {
 const baseline=JSON.parse(readFileSync(process.env.PERF_BASELINE,'utf8'));
 assert.equal(report.fixture_sha256,baseline.fixture_sha256);
 assert.ok(usage.p50_ms < baseline.usage.p50_ms/2,'same-fixture usage p50 must improve by at least 2x');
}
db.close();
