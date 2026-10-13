import assert from 'node:assert/strict';import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {DatabaseSync} from 'node:sqlite';
const {AnalyticsStore,cstDay,DAY_MS}=await import('../src/analytics/store.js');const {settleAnalyticsBatch}=await import('../src/analytics/ingest.js');const {validateAnalyticsBatch}=await import('../src/analytics/contracts.js');const {queryAnalytics}=await import('../src/analytics/admin-query.js');const {AnalyticsDeviceReader}=await import('../src/analytics/device-context.js');const {createAnalyticsApp}=await import('../src/analytics/index.js');
const dir=mkdtempSync(join(tmpdir(),'analytics-query-')),store=new AnalyticsStore(join(dir,'analytics.db')),now=Date.now(),old=now-3*DAY_MS;
const ctx=(key:string)=>({deviceKey:key.repeat(64),active:true,uploadEnabled:true,uploadHourCst:23});
const ingest=(key:string,id:string,occurred:number,received:number,name='app.bridge_ready')=>settleAnalyticsBatch(store,ctx(key),validateAnalyticsBatch({schema_version:1,batch_id:id,sent_at_ms:received,client:{},events:[{schema_version:1,client_event_id:id,event_name:name,occurred_at_ms:occurred,session_id:'session',sequence:1,priority:'normal',context:{},properties:name==='app.session_started'?{platform:'Android',entry_mode:'launcher'}:{}}]}),id,received);
ingest('a','late-a',old,now,'app.session_started');ingest('b','today-b',now,now);ingest('a','old-a',old,old);
const {rollupDirtyDays}=await import('../src/analytics/rollup.js');rollupDirtyDays(store,now);
const window='from='+cstDay(old)+'&to='+cstDay(old)+'&device_alias='+encodeURIComponent('设备-'+ 'a'.repeat(12));
const prepare=store.db.prepare.bind(store.db);
// Inspect the exact SQL executed by the public query, including hit/miss and both time dimensions.
for(const dimension of ['received','occurred'])for(const id of ['old-a','missing']){
 let plans:string[]=[];store.db.prepare=((sql:string)=>{const statement=prepare(sql);if(!sql.includes('FROM analytics_event WHERE'))return statement;const all=statement.all.bind(statement);statement.all=((...args:any[])=>{plans=(prepare('EXPLAIN QUERY PLAN '+sql).all(...args) as {detail:string}[]).map(r=>r.detail);return all(...args);}) as typeof statement.all;return statement;}) as typeof store.db.prepare;
 queryAnalytics(store,'events',new URLSearchParams('dimension='+dimension+'&client_event_id='+id),now);store.db.prepare=prepare;
 assert.ok(plans.some(p=>p.includes('analytics_event_client_received')),'精确ID匹配/缺失应使用ID前导索引：'+plans.join(';'));
}
store.db.prepare=((sql:string)=>{assert.ok(!sql.includes('analytics_rollup_fact'),'overview禁止同步扫描逐事件fact');return prepare(sql);}) as typeof store.db.prepare;
const overview=queryAnalytics(store,'overview',new URLSearchParams(window+'&dimension=occurred'),now);
assert.equal(overview.event_count,2,'发生日+设备筛选必须真实作用');assert.equal(overview.active_devices,1);assert.deepEqual(overview.devices,[{device_alias:'设备-'+ 'a'.repeat(12)}]);
assert.equal(queryAnalytics(store,'overview',new URLSearchParams(window+'&dimension=received'),now).event_count,1);
assert.equal(queryAnalytics(store,'batches',new URLSearchParams(window+'&dimension=occurred'),now).items.length,1,'batch总用received日筛选');
assert.equal(overview.rollup.complete,true);assert.equal(overview.rollup.dirty_days,0);
store.db.prepare=prepare;
const daily=queryAnalytics(store,'daily',new URLSearchParams(window+'&dimension=occurred'),now);
assert.equal(daily.items.length,1);assert.equal(daily.items[0].event_count,2);assert.equal(daily.items[0].sessions,1);assert.equal(daily.items[0].groups.activity['app.session_started'],1);
ingest('a','not-rolled-up',old,now+100);
ingest('a','rejected-receipt',now,now+150,'unregistered.event');
const stale=queryAnalytics(store,'overview',new URLSearchParams(window+'&dimension=occurred'),now);
assert.equal(stale.event_count,2,'dirty期间返回已有日汇总，不全扫fact补新鲜数据');assert.equal(stale.rollup.complete,false);assert.equal(stale.rollup.dirty_days,1);
const received=queryAnalytics(store,'overview',new URLSearchParams('dimension=received'),now);
assert.equal(received.active_devices,2,'跨日同设备不能相加重复计数');assert.equal(received.last_received_at_ms,now);assert.equal(received.last_batch_received_at_ms,now+150,'纯拒收批次到达也推进独立批次水位');
assert.equal(queryAnalytics(store,'overview',new URLSearchParams('device_alias='+encodeURIComponent('设备-'+ 'a'.repeat(12))),now).devices.length,2,'候选设备不受当前alias再次缩窄');
assert.equal(queryAnalytics(store,'overview',new URLSearchParams(window.replace(/&device_alias=.*/,'')),now).devices.length,1);
rollupDirtyDays(store,now+200);assert.equal(queryAnalytics(store,'overview',new URLSearchParams(window),now).event_count,3);
// A second real connection commits rollup after summary read but before dirty read.
ingest('a','snapshot-arrival',old,now+400);const concurrent=new AnalyticsStore(store.path);let interleaved=false;
store.db.prepare=((sql:string)=>{const statement=prepare(sql);if(sql.includes('event_count')&&sql.includes('FROM analytics_device_day')){const get=statement.get.bind(statement);statement.get=((...args:any[])=>{const result=get(...args);if(!interleaved){interleaved=true;assert.equal(rollupDirtyDays(concurrent,now+500),2);}return result;}) as typeof statement.get;}return statement;}) as typeof store.db.prepare;
const snapshot=queryAnalytics(store,'overview',new URLSearchParams(window),now);store.db.prepare=prepare;concurrent.close();
assert.equal(interleaved,true);assert.equal(snapshot.event_count,3);assert.equal(snapshot.rollup.complete,false,'旧摘要不可配新commit的dirty=0冒称完整');assert.equal(snapshot.rollup.dirty_days,1);
assert.equal(queryAnalytics(store,'overview',new URLSearchParams(window),now).event_count,4);
store.transaction(()=>{queryAnalytics(store,'overview',new URLSearchParams(window),now);assert.equal(store.db.isTransaction,true,'不得提交或破坏调用方现有事务');});assert.equal(store.db.isTransaction,false);
store.db.prepare=((sql:string)=>{if(sql.includes('FROM analytics_device_day'))throw new Error('test-read-failure');return prepare(sql);}) as typeof store.db.prepare;assert.throws(()=>queryAnalytics(store,'overview',new URLSearchParams(window),now),/test-read-failure/);store.db.prepare=prepare;assert.equal(store.db.isTransaction,false,'异常读snapshot必须回滚并释放reader');
assert.throws(()=>queryAnalytics(store,'overview',new URLSearchParams('from=2026-02-31&to=2026-03-01')),/INVALID_QUERY/);
assert.throws(()=>queryAnalytics(store,'daily',new URLSearchParams('from=2020-01-01&to=2026-10-13')),/INVALID_QUERY/);
assert.throws(()=>queryAnalytics(store,'daily',new URLSearchParams('device_alias=BJP00312345678901234')),/INVALID_QUERY/);
const devices=new DatabaseSync(join(dir,'devices.db'));devices.exec('CREATE TABLE device_registry(sn TEXT,status TEXT);CREATE TABLE device_credential_revocation(sn TEXT,not_before_sec INTEGER);');devices.close();
const config=new DatabaseSync(join(dir,'config.db'));config.exec(`CREATE TABLE device_config(scope TEXT,key TEXT,value_json TEXT);INSERT INTO device_config VALUES('(global)','analytics.event_upload_enabled','false'),('(global)','analytics.daily_upload_hour_cst','0');`);config.close();
const reader=new AnalyticsDeviceReader({devicesPath:join(dir,'devices.db'),configPath:join(dir,'config.db'),deviceKeySecret:'fake-key',envAllow:[]});
const control=join(dir,'control.json');writeFileSync(control,'{"enabled":false}',{mode:0o600});const app=createAnalyticsApp({store,reader,authSecret:'fake',internalSecret:'fake',controlPath:control,allowSubjects:[],diskFreeBytes:()=>20*1024**3});
const response=await app.request('/internal/analytics/collection-config',{headers:{'X-Analytics-Internal-Token':'fake'}});assert.equal(response.status,200);const value=await response.json();assert.equal(value.allowlist_count,0);assert.deepEqual(value.global,{event_upload_enabled:false,daily_upload_hour_cst:0});assert.deepEqual(value.device_defaults,{event_upload_enabled:false,daily_upload_hour_cst:23});
const coverageApp=createAnalyticsApp({store,reader,authSecret:'fake',internalSecret:'fake',controlPath:control,allowSubjects:['synthetic'],diskFreeBytes:()=>20*1024**3});let coverageRead=false;
store.db.prepare=((sql:string)=>{if(sql.includes('device_key IN')){coverageRead=true;assert.equal(store.db.isTransaction,true,'HTTP额外名单coverage也必须在同一snapshot内');}return prepare(sql);}) as typeof store.db.prepare;
assert.equal((await coverageApp.request('/internal/analytics/overview',{headers:{'X-Analytics-Internal-Token':'fake'}})).status,200);store.db.prepare=prepare;assert.equal(coverageRead,true);assert.equal(store.db.isTransaction,false);
// Existing populated databases obtain the missing index at startup without replacing raw/seen data.
const rawCount=store.db.prepare('SELECT count(*) n FROM analytics_event').get()!.n,seenCount=store.db.prepare('SELECT count(*) n FROM analytics_event_seen').get()!.n;
store.db.exec('DROP INDEX analytics_event_client_received');const migrated=new AnalyticsStore(store.path);
assert.equal(migrated.db.prepare('SELECT count(*) n FROM analytics_event').get()!.n,rawCount);assert.equal(migrated.db.prepare('SELECT count(*) n FROM analytics_event_seen').get()!.n,seenCount);
assert.equal(migrated.db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='index' AND name='analytics_event_client_received'").get()!.n,1);migrated.close();
store.close();rmSync(dir,{recursive:true,force:true});console.log('analytics query: PASS (cross-day dimension/alias filters, batch receive-day, actual global empty-allowlist config)');
