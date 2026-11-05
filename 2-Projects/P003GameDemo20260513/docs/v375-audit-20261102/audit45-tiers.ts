/** 独立真实HTTP/持久化审查；仅合成身份和私有临时库。复制到候选scripts运行。 */
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';import {gzipSync} from 'node:zlib';
import {SignJWT} from 'jose';import {serve} from '@hono/node-server';
import {AnalyticsStore} from '../src/analytics/store.js';
import {AnalyticsWriter} from '../src/analytics/writer.js';
import {AnalyticsDeviceReader} from '../src/analytics/device-context.js';
import {createAnalyticsApp} from '../src/analytics/index.js';
import {analyticsTierControlRoute} from '../src/analytics/tier-control-route.js';
import {pruneAnalytics} from '../src/analytics/rollup.js';
import {readArkHistory} from '../src/ark/history.js';
import {aggregateFixture,sampleFixture,invalidFixtures} from './fixtures.js';
const dir=mkdtempSync(join(tmpdir(),'audit45-tiers-')),DAY=86400000;
process.env.CONFIG_DB_PATH=join(dir,'unused-singleton.db');
const {ConfigStore}=await import('../src/config-store.js');
const config=new ConfigStore(join(dir,'config.db'));
const sn='BJP00326010198000001',other='BJP00326010198000002',devices=[{sn,status:'active'},{sn:other,status:'active'}];
const registry=new DatabaseSync(join(dir,'devices.db'));
registry.exec(`CREATE TABLE device_registry(sn TEXT PRIMARY KEY,status TEXT,binding_policy TEXT DEFAULT 'legacy',binding_version INTEGER DEFAULT 0,parent_account_id TEXT);CREATE TABLE device_binding_state(sn TEXT PRIMARY KEY,binding_policy TEXT,binding_version INTEGER);CREATE TABLE device_credential_revocation(sn TEXT PRIMARY KEY,not_before_sec INTEGER);`);
for(const d of devices)registry.prepare('INSERT INTO device_registry(sn,status) VALUES (?,?)').run(d.sn,d.status);
config.saveAnalyticsPolicy({expected_revision:0,enabled:true,subjects:[sn,other],hour:23},[sn,other],'audit45');
const control=join(dir,'control.json');writeFileSync(control,'{"enabled":true}',{mode:0o600});
const store=new AnalyticsStore(join(dir,'analytics.db'));let writer=new AnalyticsWriter(store.path);
const reader=new AnalyticsDeviceReader({devicesPath:join(dir,'devices.db'),configPath:join(dir,'config.db'),deviceKeySecret:'audit45-synthetic-hmac',envAllow:[]});
const opts={store,writer,reader,authSecret:'audit45-synthetic-jwt',internalSecret:'audit45-synthetic-internal',controlPath:control,allowSubjects:[],diskFreeBytes:()=>20*1024**3};
const app=createAnalyticsApp(opts),server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:0});
const ready=async()=>{const deadline=Date.now()+15000;while(!server.listening||!writer.ready){assert.ok(Date.now()<deadline);await new Promise(r=>setTimeout(r,10));}};
await ready();const addr=server.address();assert.ok(addr&&typeof addr!=='string');const base='http://127.0.0.1:'+addr.port;
const admin=analyticsTierControlRoute({authorize:h=>h==='audit45-admin'?'admin':h?'parent':'none',config,devices:()=>devices,internalUrl:base,internalSecret:opts.internalSecret});
const adminServer=serve({fetch:admin.fetch,hostname:'127.0.0.1',port:0});
await new Promise<void>(r=>adminServer.listening?r():adminServer.once('listening',r));const aa=adminServer.address();assert.ok(aa&&typeof aa!=='string');const adminBase='http://127.0.0.1:'+aa.port;
const token=async(subject:string)=>new SignJWT({kind:'p003-device'}).setSubject(subject).setProtectedHeader({alg:'HS256'}).setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(opts.authSecret));
const tokens=[await token(sn),await token(other)],now=Date.now(),key=reader.readAnalyticsDeviceContext(sn).deviceKey;
const raw=(id:string)=>({schema_version:1,client_event_id:id,event_name:'app.bridge_ready',occurred_at_ms:now,session_id:'audit45-synthetic',sequence:1,priority:'normal',context:{},properties:{}});
let sequence=0;const results:any[]=[];
const manage=(suffix='',method='GET',body?:unknown,auth='audit45-admin',subject=sn)=>fetch(adminBase+'/'+subject+suffix,{method,headers:{Authorization:auth,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
async function post(events:any[],device=0,gzip=true){const rid='audit45-tier-'+ ++sequence;
 const json=JSON.stringify({schema_version:1,batch_id:'audit45-batch',sent_at_ms:Date.now(),client:{content_version:'audit45-synthetic'},events});
 const r=await fetch(base+'/v1/device/analytics/events:batch',{method:'POST',headers:{Authorization:'Bearer '+tokens[device],'X-Request-Id':rid,...(gzip?{'Content-Encoding':'gzip'}:{})},body:gzip?gzipSync(json):json});
 assert.equal(r.status,200);const ack=await r.json();assert.equal(ack.request_id,rid);assert.equal(ack.ok,true);
 const all=[...ack.accepted_event_ids,...ack.duplicated_event_ids,...ack.rejected.map((x:any)=>x.client_event_id)];assert.equal(new Set(all).size,all.length);
 assert.deepEqual([...all].sort(),[...new Set(events.map(x=>x.client_event_id))].sort());return ack;
}
async function grant(names=['app.bridge_ready'],max=1000){const revision=(await(await manage()).json()).revision;
 const r=await manage('/requests','POST',{expected_revision:revision,allowed_event_names:names,ttl_seconds:1800,max_events:max,lookback_days:3});assert.equal(r.status,200);return (await r.json()).request;
}
const sample=(id:string,request:string)=>({...sampleFixture(request,now),client_event_id:id});
async function rejectedSample(event:any,reason:string,device=0){const id='audit45-raw-'+sequence,ack=await post([event,raw(id)],device);assert.deepEqual(ack.accepted_event_ids,[id]);assert.deepEqual(ack.rejected,[{client_event_id:event.client_event_id,reason}]);}
async function check(name:string,fn:()=>Promise<void>){const start=performance.now();try{await fn();results.push({name,status:'PASS',ms:performance.now()-start});}
 catch(error){results.push({name,status:'FAIL',error:String(error),ms:performance.now()-start});}}
let firstGrant:any,firstSample:any,agg=aggregateFixture(now);
try{
 await check('默认关、admin鉴权、单设备配置和CAS',async()=>{
  assert.equal((await manage('','GET',undefined,'')).status,401);assert.equal((await manage('','GET',undefined,'parent')).status,403);
  const state=await(await manage()).json();assert.equal(state.analytics.tiering_enabled,false);assert.equal(state.client_applied,false);
  assert.equal((await manage('','PUT',{expected_revision:state.revision,settings:{tiering_enabled:true,aggregate_upload_enabled:true}})).status,200);
  assert.equal((await manage('','PUT',{expected_revision:state.revision,settings:{request_gzip_enabled:true}})).status,409);
  assert.equal((config.effectiveSnapshot(other).analytics as any).tiering_enabled,false);
  assert.equal((await fetch(base+'/internal/analytics/tiering?sn='+sn)).status,401);
 });
 await check('精确信封混批、分表、计数20和原始余额事实',async()=>{
  firstGrant=await grant();firstSample=sample('audit45-first-sample',firstGrant.id);
  const day=new Date(now+28800000).toISOString().slice(0,10);
  const logical={...raw('audit45-normal'),event_name:'g1.logical_day_changed',occurred_at_ms:now-2000,properties:{previous_logical_day:day,logical_day:day,previous_usage_day_index:1,usage_day_index:2,gm_override:false}};
  const wallet={...raw('audit45-wallet'),event_name:'g1.wallet_balance_changed',occurred_at_ms:now-500,properties:{item_id:'C-FAMILY-001',before:0,after:7,delta:7}};
  const events=[logical,wallet,agg,firstSample];const ack=await post(events);assert.deepEqual(ack.accepted_event_ids,events.map(x=>x.client_event_id));
  assert.equal(store.db.prepare("SELECT count(*) n FROM analytics_event WHERE event_name LIKE 'analytics.%'").get()!.n,0);
  assert.equal(store.db.prepare("SELECT count(*) n FROM analytics_rollup_fact WHERE event_name LIKE 'analytics.%'").get()!.n,0);
  assert.equal(store.db.prepare("SELECT sum(source_event_count) n FROM analytics_tier_event WHERE tier='aggregate'").get()!.n,20);
  assert.equal(readArkHistory(store,key,now-3000,Date.now()).wallets.family_coin?.value,7);
 });
 await check('跨设备请求越权逐条拒收，合法raw仍accepted',async()=>{await rejectedSample(sample('audit45-cross-device',firstGrant.id),'diagnostic_request_invalid',1);});
 await check('跨新请求重复样本不再结算或占用额度',async()=>{
  const next=await grant(),route=sampleFixture(next.id,now);const replay={...firstSample,context:route.context,session_id:route.session_id};
  const ack=await post([replay]);assert.deepEqual(ack.duplicated_event_ids,[firstSample.client_event_id]);
  assert.equal(store.db.prepare('SELECT accepted FROM analytics_diagnostic_usage WHERE request_id=?').get(next.id),undefined);
  const conflict={...replay,properties:{...replay.properties,source_occurred_at_ms:now-2000}};
  await rejectedSample(conflict,'client_event_id_conflict');
 });
 await check('源范围及额度限制，重复不占额度',async()=>{
  const g=await grant(['settings.closed']);await rejectedSample(sample('audit45-scope',g.id),'diagnostic_source_not_allowed');
  const q=await grant(['app.bridge_ready'],1),e=sample('audit45-quota-one',q.id);
  assert.deepEqual((await post([e])).accepted_event_ids,[e.client_event_id]);assert.deepEqual((await post([e])).duplicated_event_ids,[e.client_event_id]);
  await rejectedSample(sample('audit45-quota-two',q.id),'diagnostic_request_limit');
 });
 await check('请求到期/撤销/未来创建逐条拒收',async()=>{
  const g=await grant();config.db.prepare('UPDATE analytics_diagnostic_request SET expires_at_ms=? WHERE id=?').run(Date.now()-1,g.id);
  await rejectedSample(sample('audit45-expired',g.id),'diagnostic_request_expired');
  const rev=await grant();assert.equal((await manage('/requests/'+rev.id,'DELETE')).status,200);
  await rejectedSample(sample('audit45-revoked',rev.id),'diagnostic_request_revoked');
  const future=await grant();config.db.prepare('UPDATE analytics_diagnostic_request SET created_at_ms=? WHERE id=?').run(Date.now()+DAY,future.id);
  await rejectedSample(sample('audit45-future-request',future.id),'diagnostic_request_invalid');
 });
 await check('样本捕获/源时钟与3天回溯边界',async()=>{
  const g=await grant();const e=sample('audit45-stale',g.id);e.occurred_at_ms=now-4*DAY;e.properties.source_occurred_at_ms=now-4*DAY;
  await rejectedSample(e,'diagnostic_sample_stale');
  const future=sample('audit45-future',g.id);future.occurred_at_ms=now+DAY;future.properties.source_occurred_at_ms=now+DAY;
  await rejectedSample(future,'diagnostic_sample_stale');
  const oldSource=sample('audit45-source-stale',g.id);oldSource.properties.source_occurred_at_ms=now-4*DAY;
  await rejectedSample(oldSource,'diagnostic_sample_stale');
 });
 await check('新字段非法/错误位置/资产伪装均逐条拒收',async()=>{
  const bad=invalidFixtures(now).map((x,i)=>({...x.event,client_event_id:'audit45-invalid-'+i}));const ack=await post([...bad,raw('audit45-legal-mixed')]);
  assert.deepEqual(ack.accepted_event_ids,['audit45-legal-mixed']);assert.equal(ack.rejected.length,bad.length);
 });
 await check('完整但尚未闭合的周期不能accepted',async()=>{
  const open=aggregateFixture(now+7*DAY);open.client_event_id='audit45-open-period';
  const ack=await post([open,raw('audit45-raw-open')]);assert.deepEqual(ack.accepted_event_ids,['audit45-raw-open']);
  assert.equal(ack.rejected.length,1);
 });
 await check('600条聚合旁证不挤占Ark raw扫描或改变余额',async()=>{
  for(let start=0;start<600;start+=200){const events=Array.from({length:200},(_,i)=>({...agg,client_event_id:'audit45-isolation-'+(i+start)}));assert.equal((await post(events)).accepted_event_ids.length,200);}
  const h=readArkHistory(store,key,now-3000,Date.now());assert.equal(h.wallets.family_coin?.value,7);assert.notEqual(h.reason,'query_limit');
  assert.equal(readArkHistory(store,key.slice(0,12),now-3000,Date.now()).status,'unknown');
  assert.equal(readArkHistory(store,reader.readAnalyticsDeviceContext(other).deviceKey,now-3000,Date.now()).wallets.family_coin,null);
 });
 await check('样本payload TTL后墓碑/额度保留且重启重放仍dup',async()=>{
  await writer.close();store.db.prepare("UPDATE analytics_tier_event SET received_at_ms=? WHERE tier='diagnostic'").run(Date.now()-4*DAY);
  const seen=Number(store.db.prepare('SELECT count(*) n FROM analytics_event_seen').get()!.n),usage=store.db.prepare('SELECT * FROM analytics_diagnostic_usage ORDER BY request_id').all();
  const before=Number(store.db.prepare("SELECT count(*) n FROM analytics_tier_event WHERE tier='diagnostic'").get()!.n);
  assert.equal(pruneAnalytics(store,Date.now(),1).events,Math.min(1,before));
  pruneAnalytics(store,Date.now(),5000);assert.equal(store.db.prepare("SELECT count(*) n FROM analytics_tier_event WHERE tier='diagnostic'").get()!.n,0);
  assert.equal(store.db.prepare('SELECT count(*) n FROM analytics_event_seen').get()!.n,seen);assert.deepEqual(store.db.prepare('SELECT * FROM analytics_diagnostic_usage ORDER BY request_id').all(),usage);
  writer=new AnalyticsWriter(store.path);opts.writer=writer;await ready();const ack=await post([firstSample,agg]);assert.deepEqual(ack.duplicated_event_ids,[firstSample.client_event_id,agg.client_event_id]);
  assert.equal(store.db.prepare("SELECT count(*) n FROM analytics_tier_event WHERE tier='diagnostic'").get()!.n,0);
 });
 await check('GM raw逻辑日使同日资产回unknown',async()=>{
  const day=new Date(now+28800000).toISOString().slice(0,10),gm={...raw('audit45-gm'),event_name:'g1.logical_day_changed',properties:{previous_logical_day:day,logical_day:day,previous_usage_day_index:1,usage_day_index:2,gm_override:true}};
  assert.deepEqual((await post([gm])).accepted_event_ids,[gm.client_event_id]);assert.equal(readArkHistory(store,key,now-3000,Date.now()).wallets.family_coin,null);
 });
}finally{
 server.closeAllConnections();adminServer.closeAllConnections();await Promise.all([new Promise<void>(r=>server.close(()=>r())),new Promise<void>(r=>adminServer.close(()=>r()))]);await writer.close();store.close();registry.close();config.db.close();rmSync(dir,{recursive:true,force:true});
}
const failed=results.filter(r=>r.status==='FAIL');
console.log(JSON.stringify({suite:'audit45-independent-tiers',status:failed.length?'FAIL':'PASS',results,not_verified:['real Android/PCK','production proxy','real voice','7-day savings']},null,2));
if(failed.length)process.exitCode=1;
