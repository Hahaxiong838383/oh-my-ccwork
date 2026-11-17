/** Synthetic mini009 wire over real loopback HTTP/SQLite; never production records. */
import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {Hono} from 'hono';
import {serve} from '@hono/node-server';
import {SignJWT} from 'jose';
import {RecordsStore} from '../src/ark/records-store.js';
import {canonical} from '../src/ark/records-contract.js';
import {DashboardRecordsSchema,RecentActivitySchema} from '../docs/records-r1/schema.mjs';

process.env.AUTH_JWT_SECRET='isolated-legacy-http-only';
const {createRecordsDeviceRoutes,createRecordsParentRoutes}=await import('../src/ark/records-routes.js');
process.env.ARK_RECORDS_MIN_FREE_BYTES='1';
for(const k of ['UPLOAD_PER_MINUTE','UPLOAD_PER_HOUR','GLOBAL_UPLOAD_PER_MINUTE','GLOBAL_UPLOAD_PER_HOUR'])process.env[`ARK_RECORDS_${k}`]='10000';
const SN='BJP00326060100009991';
async function fixture(t:TestContext){
 const root=mkdtempSync(join(tmpdir(),'ark-legacy-http-')),arkPath=join(root,'ark.db'),devicesPath=join(root,'devices.db');
 const devices=new DatabaseSync(devicesPath),ark=new DatabaseSync(arkPath),grant=randomUUID();
 devices.exec(`CREATE TABLE device_registry(sn TEXT PRIMARY KEY,public_id TEXT,account_id TEXT,parent_account_id TEXT,status TEXT,binding_policy TEXT,binding_version INTEGER);
 CREATE TABLE device_binding_state(sn TEXT PRIMARY KEY,binding_policy TEXT,binding_version INTEGER);
 CREATE TABLE device_credential_revocation(sn TEXT PRIMARY KEY,not_before_sec INTEGER);
 CREATE TABLE ark_device_epoch(sn TEXT PRIMARY KEY,epoch INTEGER);`);
 devices.prepare('INSERT INTO device_registry VALUES(?,?,?,?,?,?,?)').run(SN,'dev_0123456789abcdef','legacy-device','legacy-parent','active','ble-key-v1',1);
 devices.prepare('INSERT INTO device_binding_state VALUES(?,?,?)').run(SN,'ble-key-v1',1);
 devices.prepare('INSERT INTO ark_device_epoch VALUES(?,?)').run(SN,2);
 ark.exec('CREATE TABLE ark_settings(id INTEGER PRIMARY KEY,enabled INTEGER);INSERT INTO ark_settings VALUES(1,1);CREATE TABLE ark_grant(sn TEXT PRIMARY KEY,account_id TEXT,epoch INTEGER,grant_id TEXT,not_before_ms INTEGER);');
 ark.prepare('INSERT INTO ark_grant VALUES(?,?,?,?,?)').run(SN,'legacy-device',2,grant,Date.now()-1000);
 const scope={sn:SN,public_id:'dev_0123456789abcdef',account_id:'legacy-device',parent_account_id:'legacy-parent',binding_version:1,epoch:2,grant_id:grant,save_ids:'*'};
 process.env.ARK_RECORDS_LEGACY_SCOPE_JSON=JSON.stringify(scope);
 const store=new RecordsStore({arkPath,devicesPath,allowed:sn=>sn===SN,validAccount:()=>true,secret:()=>process.env.AUTH_JWT_SECRET!});
 const app=new Hono(),options={store:()=>store,secret:()=>process.env.AUTH_JWT_SECRET!};
 app.route('/v1/device/ark',createRecordsDeviceRoutes(options));app.route('/v1/parent/devices',createRecordsParentRoutes(options));
 const server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:0});
 await new Promise<void>(r=>server.listening?r():server.once('listening',r));
 t.after(async()=>{await new Promise<void>(r=>server.close(()=>r()));store.close();devices.close();ark.close();delete process.env.ARK_RECORDS_LEGACY_SCOPE_JSON;});
 const jwt=async(parent=false,version=1,owner='legacy-parent')=>{
  let j=new SignJWT(parent?{accountId:owner,role:'parent'}:{kind:'p003-device',sub:SN,binding_version:version}).setProtectedHeader({alg:'HS256'}).setIssuedAt().setExpirationTime('1h');
  if(parent)j=j.setIssuer('p003').setAudience('kidshub');return j.sign(new TextEncoder().encode(process.env.AUTH_JWT_SECRET));
 };
 const token=await jwt(),parent=await jwt(true),base=`http://127.0.0.1:${(server.address() as any).port}`;
 async function req(path:string,auth:string,body?:unknown){const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${auth}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json() as any,headers:r.headers};}
 return {store,devices,ark,scope,jwt,token,parent,req,post:(body:unknown)=>req('/v1/device/ark/records:batch',token,body),page:(q='')=>req('/v1/parent/devices/dev_0123456789abcdef/ark/records'+q,parent)};
}
const yesterday=()=>{const d=new Date(Date.now()+8*3600000-86400000).toISOString().slice(0,10);return Date.parse(d+'T12:00:00+08:00');};
function record(sequence=2,patch:Record<string,unknown>={}){return {record_id:`save-legacy:${sequence}`,save_id:'save-legacy',sequence,occurred_at_ms:yesterday()+sequence,logical_day:'2026-11-15',source_mode:'normal',record_kind:'business_commit',config_revision:'config-synthetic',active_ecotank_id:null,
 data:{wallet_changes:[{resource_id:'C-FAMILY-001',before:0,after:7,delta:7}],inventory_changes:[],grants:[],makeup_grants:[],makeup_uses:[],previous_source_mode:'normal'},...patch};}
function batch(records=[record()],patch:Record<string,unknown>={}){return {schema_version:1,contract_id:'p003-ark-records-r1',batch_id:'arb-synthetic',save_id:'save-legacy',coverage_from_ms:yesterday()-86400000,dropped_records:0,records,...patch};}

test('actual Runtime serializer records upload through the Launcher envelope without v1 context or origin',async t=>{
 const f=await fixture(t);
 // mini010 retains this mini009 wire. Keep the actual Rust serializer records
 // unchanged; only wrap the fields that Launcher sends over HTTP.
 const runtime=JSON.parse(readFileSync(new URL('./fixtures/ark-records-mini009-runtime.json',import.meta.url),'utf8'));
 const wire={schema_version:1,contract_id:runtime.contract_id,batch_id:'arb-runtime-fixture',save_id:runtime.save_id,
  coverage_from_ms:runtime.coverage_from_ms,dropped_records:runtime.dropped_records,records:runtime.records};
 const before=canonical(wire),ids=runtime.records.map((r:any)=>r.record_id);
 // No /records/context request or synthetic origin metadata is used.
 const uploaded=await f.post(wire);assert.equal(uploaded.status,200,JSON.stringify(uploaded.body));
 assert.equal(uploaded.body.data.batch_id,wire.batch_id);assert.deepEqual(uploaded.body.data.accepted_record_ids,ids);
 assert.deepEqual(uploaded.body.data.duplicated_record_ids,[]);assert.deepEqual(uploaded.body.data.rejected,[]);
 const stored=()=>f.store.db.prepare('SELECT record_id,body,body_hash,coverage_from_ms,dropped_records FROM ark_record_legacy WHERE sn=? ORDER BY sequence').all(SN);
 const rows=stored();assert.equal(rows.length,runtime.records.length);
 for(let i=0;i<rows.length;i++){
  const raw=canonical(runtime.records[i]);assert.equal(rows[i].record_id,ids[i]);assert.equal(rows[i].body,raw);
  assert.equal(rows[i].body_hash,createHash('sha256').update(raw).digest('hex'));
  assert.equal(rows[i].coverage_from_ms,runtime.coverage_from_ms);assert.equal(rows[i].dropped_records,runtime.dropped_records);
 }
 const page=await f.page();assert.equal(page.status,200);assert.equal(page.headers.get('cache-control'),'no-store');
 assert.deepEqual(page.body.data.items.map((r:any)=>r.record_id).sort(),[...ids].sort());
 for(const item of page.body.data.items){
  const raw=runtime.records.find((r:any)=>r.record_id===item.record_id);
  for(const key of ['record_id','save_id','sequence','record_kind','source_mode','logical_day','config_revision'])assert.equal(item[key],raw[key]);
  assert.equal(item.format,runtime.contract_id);assert.equal(item.authorization_source,'legacy_explicit_scope');
  assert.equal(item.origin_verified,false);assert.equal(item.origin_grant_id,undefined);assert.equal(item.origin_epoch,undefined);
 }
 const replay=await f.post(wire);assert.equal(replay.status,200);assert.equal(replay.body.data.batch_id,wire.batch_id);
 assert.deepEqual(replay.body.data.accepted_record_ids,[]);assert.deepEqual(replay.body.data.duplicated_record_ids,ids);assert.deepEqual(replay.body.data.rejected,[]);
 assert.deepEqual(stored(),rows);assert.equal(canonical(wire),before);
});

test('mini009 original envelope accepted, immutable ID replay, history before v1 grant visible',async t=>{
 const f=await fixture(t),r=record();const a=await f.post(batch([r]));assert.equal(a.status,200,JSON.stringify(a.body));assert.deepEqual(a.body.data.accepted_record_ids,[r.record_id]);
 const replay=await f.post(batch([Object.fromEntries(Object.entries(r).reverse())]));assert.deepEqual(replay.body.data.duplicated_record_ids,[r.record_id]);
 const p=await f.page();assert.equal(p.status,200);assert.equal(p.headers.get('cache-control'),'no-store');assert.equal(p.body.data.items.length,1);
 const item=p.body.data.items[0];assert.equal(item.record_id,r.record_id);assert.equal(item.format,'p003-ark-records-r1');assert.equal(item.authorization_source,'legacy_explicit_scope');assert.equal(item.origin_grant_id,undefined);assert.equal(item.resource_changes[0].delta,7);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM ark_record_legacy').get()!.n,1);
 const conflict=await f.post(batch([{...r,logical_day:'2026-11-14'}]));assert.equal(conflict.body.data.rejected[0].reason,'record_id_conflict');
});
test('explicit scope absent, foreign parent, changed binding and ABA cannot expose legacy history',async t=>{
 const f=await fixture(t);assert.equal((await f.post(batch())).status,200);
 assert.equal((await f.req('/v1/parent/devices/dev_0123456789abcdef/ark/records',await f.jwt(true,1,'other'))).status,404);
 delete process.env.ARK_RECORDS_LEGACY_SCOPE_JSON;assert.equal((await f.post(batch())).status,403);assert.equal((await f.page()).body.data.items.length,0);
 process.env.ARK_RECORDS_LEGACY_SCOPE_JSON=JSON.stringify(f.scope);
 f.devices.prepare('UPDATE device_registry SET binding_version=3 WHERE sn=?').run(SN);f.devices.prepare('UPDATE device_binding_state SET binding_version=3 WHERE sn=?').run(SN);
 assert.equal((await f.post(batch())).status,401);assert.equal((await f.page()).body.data.items.length,0);
 assert.equal((await f.req('/v1/device/ark/records:batch',await f.jwt(false,3),batch())).status,403);
});
test('partial durable insert then capacity 503 preserves retry; old IDs duplicated on replay',async t=>{
 const f=await fixture(t);process.env.ARK_RECORDS_PER_SN_RECORDS='1';
 try{const b=batch([record(2),record(3)]),r=await f.post(b);assert.equal(r.status,503);assert.equal(r.body.data,undefined);assert.ok(Number(r.headers.get('retry-after'))>=900);assert.equal(f.store.db.prepare('SELECT count(*) n FROM ark_record_legacy').get()!.n,1);
 delete process.env.ARK_RECORDS_PER_SN_RECORDS;const retry=await f.post(b);assert.equal(retry.status,200);assert.deepEqual(retry.body.data.duplicated_record_ids,['save-legacy:2']);assert.deepEqual(retry.body.data.accepted_record_ids,['save-legacy:3']);}
 finally{delete process.env.ARK_RECORDS_PER_SN_RECORDS;}
});
test('baseline preserves known state, contributes no income/acquisition; coverage gaps survive replay',async t=>{
 const f=await fixture(t),r=record(1,{record_kind:'baseline',data:{wallet:{'C-FAMILY-001':25,'C-STARDUST-001':3,'M-CARD-001':1},inventory:[],history_complete_before_baseline:false}});
 const a=await f.post(batch([r],{dropped_records:4}));assert.equal(a.status,200,JSON.stringify(a.body));assert.deepEqual(a.body.data.accepted_record_ids,[r.record_id]);
 await f.post(batch([r]));const p=(await f.page()).body.data;assert.equal(p.items[0].record_kind,'baseline');assert.deepEqual(p.items[0].resource_changes,[]);assert.deepEqual(p.items[0].item_changes,[]);assert.equal(p.coverage.complete,false);assert.equal(p.coverage.dropped_records,4);
 const d=f.store.dashboard(f.scope.public_id,f.scope.parent_account_id);assert.equal(d.yesterday_income.available,false);assert.equal(d.yesterday_income.family_coin,null);assert.equal(d.latest_items.available,false);
});
test('legacy paging freezes both watermarks and accepts full legacy ID filter without losing old v1',async t=>{
 const f=await fixture(t);assert.equal((await f.post(batch([record(2),record(3)]))).status,200);
 const one=(await f.page('?limit=1')).body.data;assert.equal(one.items.length,1);assert.equal(one.has_more,true);
 await f.post(batch([record(4)]));const two=(await f.page('?limit=1&cursor='+encodeURIComponent(one.next_cursor))).body.data;
 assert.deepEqual([one.items[0].record_id,two.items[0].record_id],['save-legacy:3','save-legacy:2']);assert.equal(two.has_more,false);
 assert.equal((await f.page('?limit=1&resource_id=stardust&cursor='+encodeURIComponent(one.next_cursor))).status,400);
 assert.equal((await f.page('?resource_id=stardust')).body.data.items.length,0);
});
test('unknown contract and envelope failure never ACK; invalid record rejected with original ID',async t=>{
 const f=await fixture(t);assert.equal((await f.post(batch([record()],{contract_id:'future'}))).status,400);
 assert.equal((await f.post(batch([record()],{extra:true}))).status,400);
 const r=await f.post(batch([{...record(),sn:SN}]));assert.equal(r.status,200);assert.equal(r.body.data.rejected[0].record_id,'save-legacy:2');assert.equal(r.body.data.rejected[0].reason,'invalid_record');
});
test('v1 and legacy share ID/sequence uniqueness and merge into the same cursor window',async t=>{
 const f=await fixture(t),v1={record_id:'v1-event',save_id:'save-v1',sequence:1,origin_grant_id:f.scope.grant_id,origin_epoch:2,occurred_at_ms:Date.now(),time_quality:'reported',logical_day:null,source_mode:'normal',reason:'reward_claim',business_source_id:'v1-reward',tank_id:null,stage_id:null,resource_changes:[{resource_id:'family_coin',delta:2,before:0,after:2}],item_changes:[]};
 assert.equal((await f.post({schema_version:1,batch_id:'v1-batch',records:[v1]})).status,200);
 assert.equal((await f.post(batch())).status,200);
 const a=(await f.page('?limit=1')).body.data,b=(await f.page('?limit=1&cursor='+encodeURIComponent(a.next_cursor))).body.data;
 assert.deepEqual([a.items[0].record_id,b.items[0].record_id],['v1-event','save-legacy:2']);
 const conflict=await f.post({schema_version:1,batch_id:'conflict',records:[{...v1,record_id:'save-legacy:2',save_id:'save-conflict',business_source_id:'another'}]});
 assert.equal(conflict.body.data.rejected[0].reason,'record_id_conflict');
});
test('legacy identifiers longer than v1 stay unchanged and remain filterable',async t=>{
 const f=await fixture(t),save='s'.repeat(84),r=record(2,{save_id:save,record_id:save+':2'});
 const a=await f.post(batch([r],{save_id:save}));assert.deepEqual(a.body.data.accepted_record_ids,[r.record_id]);
 const p=await f.page('?save_id='+save);assert.equal(p.status,200);assert.equal(p.body.data.items[0].record_id,r.record_id);
});
test('authority rechecked after COMMIT using a second SQLite connection',async t=>{
 const f=await fixture(t);await f.post(batch());
 const original=f.store.db.exec.bind(f.store.db);let armed=true;
 f.store.db.exec=((sql:string)=>{const result=original(sql);if(armed&&sql==='COMMIT'){armed=false;f.devices.exec("UPDATE device_registry SET binding_version=3;UPDATE device_binding_state SET binding_version=3;");}return result;}) as typeof f.store.db.exec;
 assert.equal((await f.page()).status,404);
 f.store.db.exec=original;
});
test('inventory-backed makeup card delta is visible and filterable, without a new item acquisition',async t=>{
 const f=await fixture(t),item={item_id:'M-CARD-001',kind:'consumable',quantity:2,tank_id:null,layer:null,status:'active',acquired_at_ms:yesterday()};
 const r=record(2,{data:{wallet_changes:[],inventory_changes:[{item_id:item.item_id,before:item,after:{...item,quantity:1}}],grants:[],makeup_grants:[],makeup_uses:[{tank_id:null,logical_day:'2026-11-14',usage_day_index:1}],previous_source_mode:'normal'}});
 assert.deepEqual((await f.post(batch([r]))).body.data.accepted_record_ids,[r.record_id]);
 const p=await f.page('?resource_id=M-CARD-001');assert.equal(p.status,200);assert.equal(p.body.data.items.length,1);assert.equal(p.body.data.items[0].resource_changes[0].delta,-1);assert.deepEqual(p.body.data.items[0].item_changes,[]);
});

test('acknowledged GM reward and historical target day immediately reach recent activity without normal income',async t=>{
 const f=await fixture(t),at=yesterday(),item={item_id:'PART-TEST',kind:'ecotank_part',quantity:2,tank_id:'tank-test',layer:'base',status:'pending_activation',acquired_at_ms:at};
 const grant={reward_instance_id:'reward-history',source_kind:'daily_gift',source_id:'gift-history',logical_day:'2026-10-03',resolved_rewards:[{kind:'currency',item_id:'C-FAMILY-001',quantity:7,tank_id:null,layer:null}],status:'granted',config_revision:'test',granted_at_ms:at};
 const r=record(2,{source_mode:'gm',logical_day:'2026-10-12',data:{...record().data,grants:[grant],inventory_changes:[{item_id:item.item_id,before:null,after:item}],makeup_grants:[{tank_id:'tank-test'}],makeup_uses:[{tank_id:'tank-test',logical_day:'2026-10-02',usage_day_index:3}],previous_source_mode:'unknown'}});
 const uploaded=await f.post(batch([r]));assert.equal(uploaded.status,200);assert.deepEqual(uploaded.body.data.accepted_record_ids,[r.record_id]);
 const d=f.store.dashboard(f.scope.public_id,f.scope.parent_account_id),page=(await f.page()).body.data;
 assert.equal(d.recent_activity.available,true);assert.equal(d.recent_activity.source,'ark_records');assert.deepEqual(d.recent_activity.items,page.items);
 DashboardRecordsSchema.parse(d);const {recent_activity,...oldReadShape}=d;DashboardRecordsSchema.parse(oldReadShape);
 for(const bad of [{...recent_activity,source:'unknown'},{...recent_activity,items:[{...page.items[0],origin_grant_id:f.scope.grant_id}]},{...recent_activity,items:[{...page.items[0],grants:'invalid'}]},{...recent_activity,next_cursor:'unexpected'},{...recent_activity,available:false},{...recent_activity,items:Array(21).fill(page.items[0])}])assert.equal(RecentActivitySchema.safeParse(bad).success,false);
 const projected=d.recent_activity.items[0] as any;
 assert.equal(projected.source_mode,'gm');assert.equal(projected.logical_day,'2026-10-12');assert.equal(projected.grants[0].logical_day,'2026-10-03');
 assert.deepEqual(projected.grants,[grant]);assert.deepEqual(projected.inventory_changes,r.data.inventory_changes);
 assert.deepEqual(projected.makeup_grants,r.data.makeup_grants);assert.deepEqual(projected.makeup_uses,r.data.makeup_uses);
 assert.equal(d.yesterday_income.available,false);assert.equal(d.yesterday_income.family_coin,null);assert.equal(d.latest_items.reason,'non_normal');
 await f.post(batch([r]));assert.equal(f.store.dashboard(f.scope.public_id,f.scope.parent_account_id).recent_activity.items.length,1);
 delete process.env.ARK_RECORDS_LEGACY_SCOPE_JSON;assert.equal(f.store.dashboard(f.scope.public_id,f.scope.parent_account_id).recent_activity.items.length,0);
});

test('dashboard recent activity cursor continues the existing records page without duplicate or new-arrival leakage',async t=>{
 const f=await fixture(t),records=Array.from({length:21},(_,i)=>record(i+1));
 for(let start=0;start<records.length;start+=16)assert.equal((await f.post(batch(records.slice(start,start+16)))).status,200);
 const recent=f.store.dashboard(f.scope.public_id,f.scope.parent_account_id).recent_activity;
 assert.equal(recent.items.length,20);assert.equal(recent.limit,20);assert.equal(recent.has_more,true);assert.ok(recent.next_cursor);
 await f.post(batch([record(22)]));
 const next=await f.page('?limit=20&cursor='+encodeURIComponent(recent.next_cursor!));assert.equal(next.status,200);assert.equal(next.body.data.items.length,1);assert.equal(next.body.data.items[0].record_id,'save-legacy:1');assert.equal(next.body.data.has_more,false);
 assert.equal((f.store.dashboard(f.scope.public_id,f.scope.parent_account_id).recent_activity.items[0] as any).record_id,'save-legacy:22');
});
