/** Isolated databases and loopback HTTP only. No production credentials or business writes. */
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Hono} from 'hono';
import {serve} from '@hono/node-server';
import {SignJWT} from 'jose';
const dir=mkdtempSync(join(tmpdir(),'weekly-service-'));process.chdir(dir);
for(const key of Object.keys(process.env))if(key.endsWith('_DB_PATH'))process.env[key]=join(dir,key+'.db');
for(const key of ['ACCOUNTS','DEVICES','TELEMETRY','WEEKLY_REPORTS','ARK','CONFIG','OTA','PROFILE','CONVERSATION','PAIRING','BLE_BINDINGS'])process.env[key+'_DB_PATH']=join(dir,key+'.db');
process.env.AUTH_JWT_SECRET='weekly-isolated-test';process.env.ARK_CONTEXT_SN_ALLOW='';process.env.ARK_RECORDS_SN_ALLOW='';
process.env.STUDIO_USER='weekly-admin';process.env.STUDIO_PASS='weekly-test-password';
process.env.ANALYTICS_INTERNAL_SECRET='weekly-internal-test';delete process.env.PARENT_CONVERSATION_SCOPE_JSON;
const {deviceRegistryStore:registry}=await import('../src/device-registry-store.js');
const {accountStore}=await import('../src/account-store.js');
const {telemetryStore}=await import('../src/telemetry-store.js');
const {readParentWeeklyReport,refreshWeeklyReports}=await import('../src/weekly-report-service.js');
const {weeklyReportStore}=await import('../src/weekly-report-store.js');
const {parentTelemetryRoute}=await import('../src/routes/telemetry.js');
const {miniappAdminRoute}=await import('../src/routes/miniapp-admin.js');
const {authRoute}=await import('../src/routes/auth.js');
const {weekStartOf}=await import('../src/weekly-calculation.js');
const accounts=new DatabaseSync(process.env.ACCOUNTS_DB_PATH!),telemetry=new DatabaseSync(process.env.TELEMETRY_DB_PATH!);
const servers:ReturnType<typeof serve>[]=[];
async function start(app:Hono){const server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:0});servers.push(server);await new Promise<void>(r=>server.listening?r():server.once('listening',r));return 'http://127.0.0.1:'+(server.address() as any).port;}
let mutation:(()=>void)|null=null,analyticsDown=false;let analyticsProgress:any[]=[];
const internal=new Hono();internal.post('/internal/analytics/parent-observations',c=>{
 if(mutation){const action=mutation;mutation=null;action();}
 if(analyticsDown)return c.json({ok:false},503);
 return c.json({ok:true,data:{summary:{available:false},progress:analyticsProgress,page:{items:[],has_more:false,next_cursor:null}}});
});
process.env.ANALYTICS_INTERNAL_URL=await start(internal);
const app=new Hono();app.route('/auth',authRoute);app.route('/v1/parent/devices',parentTelemetryRoute);app.route('/api/admin',miniappAdminRoute);
const base=await start(app);
async function token(id:string,role='parent'){return new SignJWT({accountId:id,role}).setProtectedHeader({alg:'HS256'}).setIssuer('p003').setAudience('kidshub').setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(process.env.AUTH_JWT_SECRET));}
async function get(path:string,bearer=''){const r=await fetch(base+path,{headers:bearer?{authorization:'Bearer '+bearer}:{}});return {status:r.status,cache:r.headers.get('cache-control'),body:await r.json() as any};}
let serial=0;
async function fixture(history=true){const id=++serial,sn='BJP003260601'+String(id).padStart(8,'0'),owner='weekly-parent-'+id;
 accounts.prepare("INSERT INTO account(id,nickname,role,created_at) VALUES(?,'test','parent',?)").run(owner,Date.now());
 registry.add(sn,'test');registry.setParentAccountId(sn,owner);registry.setAccountId(sn,accountStore.createDeviceAccount(sn,'test').id);
 const d=registry.get(sn)!,scope={sn,public_id:d.public_id!,parent_account_id:owner,account_id:d.account_id!,binding_version:d.binding_version,epoch:registry.arkIdentity(sn)!.epoch};
 if(history)process.env.PARENT_CONVERSATION_SCOPE_JSON=JSON.stringify(scope);else delete process.env.PARENT_CONVERSATION_SCOPE_JSON;
 return {sn,owner,pub:d.public_id!,scope,token:await token(owner)};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function event(f:Fixture,id:string,type:string,time:number,data:any,received=time){assert.equal(telemetryStore.ingestEvent(f.sn,{event_id:id,type,occurred_at_ms:time,data},{schemaVersion:1,deviceTsMs:received,serverReceivedMs:received,traceId:''}),'accepted');}
const at=Date.parse('2026-11-17T10:00:00+08:00'),week='2026-11-16';
after(async()=>{for(const s of servers)await new Promise<void>(r=>s.close(()=>r()));accounts.close();telemetry.close();weeklyReportStore().close();});

test('same legacy URL adds natural-week report; parent/admin identical; missing null and old keys retained',async()=>{
 const f=await fixture();event(f,'focus','focus_segment',at,{start_ms:at-600000,end_ms:at});event(f,'remind','posture_reminder',at,{outcome:'played'});
 const p=await get(`/v1/parent/devices/${f.pub}/weekly-report?week_start=${week}`,f.token);
 assert.equal(p.status,200,JSON.stringify(p.body));assert.equal(p.cache,'no-store');
 assert.deepEqual(Object.keys(p.body.data).sort(),['week_start','eye_health_rate','guarded_minutes','posture_alert_count','percentile','highlights','data_quality','report'].sort());
 assert.equal(p.body.data.report.metrics.usage.total_seconds,600);assert.equal(p.body.data.report.metrics.active_days.value,1);assert.equal(p.body.data.report.metrics.posture_reminders.value,1);
 assert.equal(p.body.data.report.daily[0].observed_seconds,null);
 const login=await fetch(base+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'weekly-admin',password:'weekly-test-password'})});const admin=(await login.json() as any).token;
 const a=await get(`/api/admin/devices/${f.sn}/miniapp/weekly-report?week_start=${week}`,admin);assert.equal(a.status,200);assert.deepEqual(a.body.data,p.body.data);assert.equal(a.cache,'no-store');
 const def=await get(`/v1/parent/devices/${f.pub}/weekly-report`,f.token);assert.equal(def.body.data.week_start,weekStartOf(Date.now()));
 const old=await get(`/v1/parent/devices/${f.pub}/weekly-report?week_start=2026-10-26`,f.token);assert.equal(old.body.data.guarded_minutes,0);assert.equal(old.body.data.report.metrics.usage.total_seconds,null);
 const nonMonday=await get(`/v1/parent/devices/${f.pub}/weekly-report?week_start=2026-11-17`,f.token);assert.equal(nonMonday.status,200);assert.equal(nonMonday.body.data.week_start,'2026-11-17');assert.equal(nonMonday.body.data.report.week_start,week);
});
test('HTTP unauthorized, wrong parent, role, invalid dates/timezone cannot read reports',async()=>{
 const f=await fixture(),path=`/v1/parent/devices/${f.pub}/weekly-report`;
 assert.equal((await get(path)).status,401);assert.equal((await get(path,await token('other'))).status,404);const legacyRole=await get(path,await token(f.owner,'device'));assert.equal(legacyRole.status,200);assert.equal(legacyRole.body.data.report,null);
 for(const q of ['week_start=bad','week_start=2026-02-30','timezone=UTC'])assert.equal((await get(path+'?'+q,f.token)).status,400);
 assert.equal((await get(`/api/admin/devices/${f.sn}/miniapp/weekly-report`)).status,401);
});
test('known cooldown is zero but no events is null; estimates never qualify active days',async()=>{
 const f=await fixture();event(f,'cool','posture_reminder',at,{outcome:'suppressed_cooldown'});event(f,'posture','posture_round',at,{result:'correct',valid_frames:10});
 const r=(await readParentWeeklyReport(f.pub,f.owner,'parent',week,at+1000)).data.report;
 assert.equal(r.metrics.posture_reminders.value,0);assert.equal(r.metrics.active_days.value,null);assert.equal(r.metrics.usage.total_seconds,null);assert.equal(r.metrics.usage.supplemental_seconds,60);
});
test('raw cleanup retains weekly evidence and late upload revises the original week',async()=>{
 const f=await fixture();event(f,'first','focus_segment',at,{start_ms:at-300000,end_ms:at});
 const publishedAt=Date.parse('2026-11-22T22:00:00+08:00'),r1=(await readParentWeeklyReport(f.pub,f.owner,'parent',week,publishedAt)).data.report;
 telemetry.prepare('DELETE FROM device_telemetry_event WHERE sn=?').run(f.sn);
 const r2=(await readParentWeeklyReport(f.pub,f.owner,'parent',week,publishedAt+1000)).data.report;
 assert.equal(r2.metrics.usage.total_seconds,300);assert.equal(r2.revision,r1.revision);
 event(f,'late','focus_segment',at+300000,{start_ms:at,end_ms:at+300000},publishedAt+2000);
 const r3=(await readParentWeeklyReport(f.pub,f.owner,'parent',week,publishedAt+3000)).data.report;
 assert.equal(r3.metrics.usage.total_seconds,600);assert.equal(r3.published_at_ms,r1.published_at_ms);assert.equal(r3.status,'revised');assert.equal(r3.revision,r1.revision+1);
});
test('telemetry failure retains published metrics and revision; Analytics failure preserves real focus',async()=>{
 const f=await fixture();event(f,'focus','focus_segment',at,{start_ms:at-300000,end_ms:at});
 const before=(await readParentWeeklyReport(f.pub,f.owner,'parent',week,at+1000)).data.report;
 telemetry.exec('ALTER TABLE device_telemetry_event RENAME TO missing_event');
 try{const after=(await readParentWeeklyReport(f.pub,f.owner,'parent',week,at+2000)).data.report;assert.equal(after.metrics.usage.total_seconds,300);assert.equal(after.revision,before.revision);assert.equal(after.coverage.reason,'retained_dependency_unavailable');}
 finally{telemetry.exec('ALTER TABLE missing_event RENAME TO device_telemetry_event');}
 analyticsDown=true;try{const r=(await readParentWeeklyReport(f.pub,f.owner,'parent',week,at+3000)).data.report;assert.equal(r.metrics.usage.total_seconds,300);}finally{analyticsDown=false;}
});
test('owner ABA and epoch changes while awaiting analytics discard whole response before persistence',async()=>{
 for(const kind of ['aba','epoch','role','shared-account']){
  const f=await fixture();event(f,'private','focus_segment',at,{start_ms:at-300000,end_ms:at});
  mutation=()=>{if(kind==='aba'){registry.setParentAccountId(f.sn,'other');registry.setParentAccountId(f.sn,f.owner);}if(kind==='epoch'){const db=new DatabaseSync(process.env.DEVICES_DB_PATH!);try{db.prepare('UPDATE ark_device_epoch SET epoch=epoch+1 WHERE sn=?').run(f.sn);}finally{db.close();}}if(kind==='role')accounts.prepare("UPDATE account SET role='device' WHERE id=?").run(f.owner);if(kind==='shared-account'){const sn='BJP00326060199999999';if(!registry.get(sn))registry.add(sn,'test');registry.setAccountId(sn,f.scope.account_id);}};
  await assert.rejects(()=>readParentWeeklyReport(f.pub,f.owner,'parent',week,at+1000),(e:any)=>e.status===404,kind);
 }
});
test('ungranted or rebound owner receives only evidence after current scope activation',async()=>{
 const f=await fixture(false);event(f,'old-owner','focus_segment',at,{start_ms:at-300000,end_ms:at});
 const empty=(await readParentWeeklyReport(f.pub,f.owner,'parent',week,at+1000)).data.report;assert.equal(empty.metrics.usage.total_seconds,null);
 event(f,'new-owner','focus_segment',at+302000,{start_ms:at+2000,end_ms:at+302000});
 const fresh=(await readParentWeeklyReport(f.pub,f.owner,'parent',week,at+303000)).data.report;assert.equal(fresh.metrics.usage.total_seconds,300);
 registry.setParentAccountId(f.sn,null);registry.setParentAccountId(f.sn,f.owner);
 const rebound=(await readParentWeeklyReport(f.pub,f.owner,'parent',week,at+304000)).data.report;assert.equal(rebound.metrics.usage.total_seconds,null);assert.notEqual(rebound.report_id,fresh.report_id);
});
test('scheduler catches up missed publication without any viewer request',async()=>{
 const f=await fixture();event(f,'scheduled','focus_segment',at,{start_ms:at-300000,end_ms:at});
 await refreshWeeklyReports(Date.parse('2026-11-23T00:00:00+08:00'));
 const r=(await readParentWeeklyReport(f.pub,f.owner,'parent',week,Date.parse('2026-11-23T00:00:01+08:00'))).data.report;
 assert.equal(r.status,'published');assert.equal(r.metrics.usage.total_seconds,300);assert.equal(r.data_cutoff_at_ms,r.period_end_ms);
});

test('等价历史授权JSON重排和格式化不能新建scope或丢失已清理来源的周报补充',async()=>{
 const f=await fixture();
 event(f,'stable-focus','focus_segment',at,{start_ms:at-300000,end_ms:at});
 event(f,'stable-posture','posture_round',at+300000,{result:'correct',valid_frames:10});
 const publishedAt=Date.parse('2026-11-22T22:00:00+08:00');
 const before=(await readParentWeeklyReport(f.pub,f.owner,'parent',week,publishedAt)).data.report;
 assert.equal(before.metrics.usage.total_seconds,300);
 assert.equal(before.metrics.usage.supplemental_seconds,60);
 telemetry.prepare('DELETE FROM device_telemetry_event WHERE sn=?').run(f.sn);
 process.env.PARENT_CONVERSATION_SCOPE_JSON=JSON.stringify(Object.fromEntries(Object.entries(f.scope).reverse()),null,2);
 const after=(await readParentWeeklyReport(f.pub,f.owner,'parent',week,publishedAt+1000)).data.report;
 assert.equal(after.report_id,before.report_id);
 assert.equal(after.revision,before.revision);
 assert.equal(after.published_at_ms,before.published_at_ms);
 assert.equal(after.metrics.usage.total_seconds,300);
 assert.equal(after.metrics.usage.supplemental_seconds,60);
 assert.deepEqual(after,before);
});

test('其他设备历史授权启用和替换不能使当前普通scope丢失已留存数据',async()=>{
 const f=await fixture(false);
 await readParentWeeklyReport(f.pub,f.owner,'parent',week,at+1000);
 event(f,'current-focus','focus_segment',at+302000,{start_ms:at+2000,end_ms:at+302000});
 event(f,'current-posture','posture_round',at+362000,{result:'correct',valid_frames:10});
 const publishedAt=Date.parse('2026-11-22T22:00:00+08:00');
 const before=(await readParentWeeklyReport(f.pub,f.owner,'parent',week,publishedAt)).data.report;
 assert.equal(before.metrics.usage.total_seconds,300);
 assert.equal(before.metrics.usage.supplemental_seconds,60);
 telemetry.prepare('DELETE FROM device_telemetry_event WHERE sn=?').run(f.sn);
 for(let change=0;change<2;change++){
  await fixture(); // 每次都把全局历史授权切到另一个真实绑定的测试设备。
  const after=(await readParentWeeklyReport(f.pub,f.owner,'parent',week,publishedAt+1000+change)).data.report;
  assert.equal(after.report_id,before.report_id);
  assert.equal(after.revision,before.revision);
  assert.equal(after.metrics.usage.total_seconds,300);
  assert.equal(after.metrics.usage.supplemental_seconds,60);
  assert.deepEqual(after,before);
 }
});

test('原始清理后用已保存有位置估算与晚到真实片段重建并集，互不重叠保留、重叠不虚加',async()=>{
 for(const overlaps of [false,true]){
  const f=await fixture(),postureAt=overlaps?at:at-3600000;
  event(f,'retained-posture','posture_round',postureAt,{result:'correct',valid_frames:10});
  const first=(await readParentWeeklyReport(f.pub,f.owner,'parent',week,at+1000)).data.report!;
  assert.equal(first.metrics.usage.combined_seconds,60);
  telemetry.prepare('DELETE FROM device_telemetry_event WHERE sn=?').run(f.sn);
  const end=overlaps?at+240000:at+3600000;
  event(f,'late-focus','focus_segment',end,{start_ms:end-300000,end_ms:end});
  const next=(await readParentWeeklyReport(f.pub,f.owner,'parent',week,end+1000)).data.report!;
  assert.equal(next.metrics.usage.total_seconds,300);
  assert.equal(next.metrics.usage.combined_seconds,overlaps?300:360,'已保存的60秒有位置估算仅在不重叠时追加');
  assert.equal(next.metrics.usage.supplemental_seconds,overlaps?0:60);
  assert.equal(next.metrics.active_days.value,1);
  const stable=(await readParentWeeklyReport(f.pub,f.owner,'parent',week,end+2000)).data.report!;
  assert.equal(stable.revision,next.revision,'重复读取相同证据不增加修订');
 }
});

test('设备停用或家长账号缺失时旧周报字段保持，新增report独立不可用',async()=>{
 for(const reason of ['disabled','missing-parent']){
  const f=await fixture();event(f,'legacy-played','posture_reminder',at,{outcome:'played'});
  const before=(await readParentWeeklyReport(f.pub,f.owner,'parent',week,at+1000)).data;
  if(reason==='disabled')registry.setStatus(f.sn,'disabled');
  else accounts.prepare('DELETE FROM account WHERE id=?').run(f.owner);
  const response=await get(`/v1/parent/devices/${f.pub}/weekly-report?week_start=${week}`,f.token);
  assert.equal(response.status,200,reason);
  assert.equal(response.body.data.report,null,reason);
  assert.equal(response.body.data.report_unavailable_reason,'current_binding_unavailable');
  for(const key of ['week_start','eye_health_rate','guarded_minutes','posture_alert_count','percentile','highlights','data_quality'])assert.deepEqual(response.body.data[key],before[key as keyof typeof before],reason+' '+key);
 }
});


test('晚到离位可下调有位置补充估算，已留存奖励counter高水位独立保留且不相加',async()=>{
 for(const withCounter of [false,true]){
  const f=await fixture();
  analyticsProgress=withCounter?[{event_id:'reward-counter-900',kind:'progress',occurred_at_ms:at,received_at_ms:at+100,time_status:'reported',progress:{elapsed_seconds:900}}]:[];
  try{
   event(f,'present','presence_transition',at,{state:'present'});
   const before=(await readParentWeeklyReport(f.pub,f.owner,'parent',week,at+600000)).data.report!;
   assert.equal(before.metrics.usage.combined_seconds,withCounter?900:300);
   event(f,'late-absent','presence_transition',at+60000,{state:'absent'},at+660000);
   analyticsProgress=[]; // 原始奖励观测已离开保留窗口，只能使用已保存counter。
   const after=(await readParentWeeklyReport(f.pub,f.owner,'parent',week,at+661000)).data.report!;
   assert.equal(after.metrics.usage.total_seconds,null);
   assert.equal(after.metrics.usage.combined_seconds,withCounter?900:60);
   assert.equal(after.metrics.usage.supplemental_seconds,withCounter?900:60);
   assert.equal(after.metrics.active_days.value,null);
  }finally{analyticsProgress=[];}
 }
});

test('历史授权数据库校验故障返回503且不新建普通scope，恢复后保留原报告',async()=>{
 const f=await fixture();event(f,'authority-evidence','focus_segment',at,{start_ms:at-300000,end_ms:at});
 const before=(await readParentWeeklyReport(f.pub,f.owner,'parent',week,at+1000)).data.report!;
 assert.equal(before.metrics.usage.total_seconds,300);
 const scopeCount=weeklyReportStore().db.prepare('SELECT COUNT(*) n FROM weekly_scope').get()!.n;
 const originalPath=process.env.DEVICES_DB_PATH;
 process.env.DEVICES_DB_PATH=join(dir,'missing-authority-database.db');
 try{
  await assert.rejects(()=>readParentWeeklyReport(f.pub,f.owner,'parent',week,at+2000),(error:any)=>error.status===503&&error.message==='weekly_authorization_dependency_unavailable');
  assert.equal(weeklyReportStore().db.prepare('SELECT COUNT(*) n FROM weekly_scope').get()!.n,scopeCount,'校验失败不能冒充无历史授权再开scope');
 }finally{process.env.DEVICES_DB_PATH=originalPath;}
 const recovered=(await readParentWeeklyReport(f.pub,f.owner,'parent',week,at+3000)).data.report!;
 assert.equal(recovered.report_id,before.report_id);assert.equal(recovered.revision,before.revision);assert.equal(recovered.metrics.usage.total_seconds,300);
});

test('临时Analytics故障与恢复只改变读取提示，无新事实时不修订已发布周报',async()=>{
 const f=await fixture(),published=Date.parse('2026-11-22T22:00:00+08:00');
 const counter={event_id:'stable-reward-900',kind:'progress',occurred_at_ms:at,received_at_ms:at+100,time_status:'reported',progress:{elapsed_seconds:900}};
 analyticsProgress=[counter];
 try{
  event(f,'stable-focus','focus_segment',at,{start_ms:at-300000,end_ms:at});
  event(f,'stable-reminder','posture_reminder',at,{outcome:'played'});
  const before=(await readParentWeeklyReport(f.pub,f.owner,'parent',week,published)).data.report!;
  assert.equal(before.status,'published');assert.equal(before.metrics.usage.combined_seconds,900);
  analyticsDown=true;analyticsProgress=[];
  const unavailable=(await readParentWeeklyReport(f.pub,f.owner,'parent',week,published+1000)).data.report!;
  assert.equal(unavailable.coverage.supplemental_available,false);
  assert.equal(unavailable.coverage.reason,'partial_history_retained_supplement');
  analyticsDown=false;analyticsProgress=[counter];
  const recovered=(await readParentWeeklyReport(f.pub,f.owner,'parent',week,published+2000)).data.report!;
  for(const report of [unavailable,recovered]){
   assert.deepEqual(report.metrics,before.metrics);
   assert.equal(report.revision,before.revision);assert.equal(report.published_at_ms,before.published_at_ms);assert.equal(report.updated_at_ms,before.updated_at_ms);assert.equal(report.status,before.status);
  }
  assert.equal(recovered.coverage.supplemental_available,true);
 }finally{analyticsDown=false;analyticsProgress=[];}
});

// Weekly calculations retain millisecond precision; old dashboard defaults keep rounded seconds.
test('subsecond focus never turns rounding remainder into supplemental usage',async()=>{
 const f=await fixture();event(f,'fractional','focus_segment',at,{start_ms:at-299999,end_ms:at});
 const r=(await readParentWeeklyReport(f.pub,f.owner,'parent',week,at+1000)).data.report!;
 assert.equal(r.metrics.usage.total_seconds,299.999);assert.equal(r.metrics.usage.combined_seconds,299.999);
 assert.equal(r.metrics.usage.supplemental_seconds,0);assert.equal(r.metrics.active_days.value,0);
});
