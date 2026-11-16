/** Extra isolation counterexamples. Isolated temp SQLite only. */
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
const here=dirname(fileURLToPath(import.meta.url));
const server=join(here,'archive/2-Projects/P003GameDemo20260513/apps/server');
const root=mkdtempSync(join(tmpdir(),'ark-records-r1-probe-'));
process.chdir(root);
for(const key of ['TELEMETRY','DEVICES','ACCOUNTS','PROFILE','ARK','CONFIG','PAIRING','BLE_BINDINGS'])process.env[`${key}_DB_PATH`]=join(root,`${key.toLowerCase()}.db`);
process.env.AUTH_JWT_SECRET='isolated-records-probe-only';
process.env.ARK_CONTEXT_SN_ALLOW='';
process.env.ARK_RECORDS_SN_ALLOW='';
for(const k of ['UPLOAD_PER_MINUTE','UPLOAD_PER_HOUR','GLOBAL_UPLOAD_PER_MINUTE','GLOBAL_UPLOAD_PER_HOUR','CONTEXT_PER_MINUTE'])process.env[`ARK_RECORDS_${k}`]='10000';
process.env.ARK_RECORDS_MIN_FREE_BYTES='1';
const contract=await import(join(server,'docs/records-r1/schema.mjs'));
const {Hono}=await import('hono');
const {serve}=await import('@hono/node-server');
const {SignJWT}=await import('jose');
const {deviceTelemetryRoute,parentTelemetryRoute}=await import(join(server,'src/routes/telemetry.js'));
const {arkRoute}=await import(join(server,'src/routes/ark.js'));
const {deviceRegistryStore:registry}=await import(join(server,'src/device-registry-store.js'));
const {accountStore}=await import(join(server,'src/account-store.js'));
const {arkStore}=await import(join(server,'src/ark/service.js'));
const app=new Hono();
app.route('/v1/device/ark',arkRoute);
app.route('/v1/device/telemetry',deviceTelemetryRoute);
app.route('/v1/parent/devices',parentTelemetryRoute);
const serverHttp=serve({fetch:app.fetch,hostname:'127.0.0.1',port:0});
await new Promise<void>(r=>serverHttp.listening?r():serverHttp.once('listening',r));
const base=`http://127.0.0.1:${(serverHttp.address() as any).port}`;
arkStore();
const db=new DatabaseSync(process.env.ARK_DB_PATH!);
const checks:string[]=[];
function note(name:string){checks.push(name);console.log('PASS',name);}
async function jwt(payload:any,parent=false){
 let j=new SignJWT(payload).setProtectedHeader({alg:'HS256'}).setIssuedAt().setExpirationTime('1h');
 if(parent)j=j.setIssuer('p003').setAudience('kidshub');
 return j.sign(new TextEncoder().encode(process.env.AUTH_JWT_SECRET));
}
async function req(path:string,token:string,body?:any){
 const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const text=await r.text();let value;try{value=JSON.parse(text);}catch{value={raw:text};}
 return {status:r.status,body:value as any};
}
try{
 const sn='BJP00326060100000099',owner='r1-parent-probe';
 registry.add(sn,'synthetic');registry.setParentAccountId(sn,owner);
 registry.setAccountId(sn,accountStore.createDeviceAccount(sn,'synthetic').id);
 process.env.ARK_CONTEXT_SN_ALLOW=sn;process.env.ARK_RECORDS_SN_ALLOW=sn;
 arkStore().authorize(registry.arkIdentity(sn)!,Date.now()-7*86400000);
 const grant=arkStore().grant(registry.arkIdentity(sn)!)!;
 const pub=registry.get(sn)!.public_id!;
 const token=await jwt({kind:'p003-device',sub:sn});
 const parent=await jwt({accountId:owner,role:'parent'},true);
 const now=Date.now();
 const snapshot={schema_version:1,snapshot_id:'wallet-seven',boot_id:'boot',boot_started_at_ms:now-1000,sequence:1,captured_at_ms:now,logical_day:new Date(now+8*3600000).toISOString().slice(0,10),config_revision:'rules',content_version:'content',source_mode:'normal',wallets:{family_coin:7,stardust:4},inventory:{'M-CARD-001':2},progress:{timer_state:'unknown',next_reward:{status:'unknown',kind:'unknown',item_id:null,stage_id:null,remaining_seconds:null},claimable_count:null}};
 assert.equal((await req('/v1/device/ark/state',token,snapshot)).status,200);
 const rec={record_id:'r1',save_id:'save1',sequence:1,origin_grant_id:grant.grant_id,origin_epoch:grant.epoch,occurred_at_ms:now-1000,time_quality:'reported',logical_day:'2026-11-10',source_mode:'normal',reason:'reward_claim',business_source_id:'source-r1',tank_id:null,stage_id:null,resource_changes:[{resource_id:'family_coin',delta:2,before:0,after:2},{resource_id:'stardust',delta:3,before:null,after:null}],item_changes:[{operation:'acquired',item_instance_id:'item-r1',item_id:'component',item_kind:'tank_component',quantity:1,state:'pending_activation'}]};
 const uploaded=await req('/v1/device/ark/records:batch',token,{schema_version:1,batch_id:'batch',records:[rec]});
 assert.equal(uploaded.status,200);assert.deepEqual(uploaded.body.data.accepted_record_ids,['r1']);
 const baseline=await req(`/v1/parent/devices/${pub}/dashboard`,parent);
 assert.equal(baseline.status,200);
 assert.equal(baseline.body.data.ark.wallets.family_coin,7);
 assert.equal(baseline.body.data.ark.inventory['M-CARD-001'],2);
 assert.equal(baseline.body.data.records.yesterday_income.family_coin,null);
 db.exec('ALTER TABLE ark_record RENAME TO ark_record_unavailable');
 try{
  const degraded=await req(`/v1/parent/devices/${pub}/dashboard`,parent);
  assert.equal(degraded.status,200);
  assert.deepEqual(degraded.body.data.ark,baseline.body.data.ark);
  assert.deepEqual(degraded.body.data.usage,baseline.body.data.usage);
  assert.deepEqual(degraded.body.data.device,baseline.body.data.device);
  assert.equal(degraded.body.data.ark.wallets.family_coin,7);
  assert.equal(degraded.body.data.ark.wallets.stardust,4);
  const r=degraded.body.data.records;
  contract.DashboardRecordsSchema.parse(r);
  assert.equal(r.yesterday_income.reason,'dependency_unavailable');
  assert.equal(r.latest_items.reason,'dependency_unavailable');
  assert.equal(r.yesterday_income.available,false);
  assert.equal(r.yesterday_income.source_mode,null);
  assert.equal(r.latest_items.source_mode,null);
  assert.equal(r.yesterday_income.family_coin,null);
  assert.equal(r.yesterday_income.stardust,null);
  assert.notEqual(r.yesterday_income.family_coin,0);
  assert.notEqual(r.yesterday_income.family_coin,7);
  assert.equal(r.latest_items.record_id,null);
  assert.deepEqual(r.latest_items.items,[]);
  note('records_sql_failure_preserves_real_ark_wallet_and_null_income');
  const ctx=await req('/v1/device/ark/records/context',token);
  assert.equal(ctx.status,200);
  contract.ContextSchema.parse(ctx.body);
  note('context_survives_records_table_rename');
  const page=await req(`/v1/parent/devices/${pub}/ark/records`,parent);
  assert.equal(page.status,503);
  assert.equal(page.body.data,undefined);
  note('parent_page_stays_503_without_ack_payload');
  const upload=await req('/v1/device/ark/records:batch',token,{schema_version:1,batch_id:'during',records:[{...rec,record_id:'during-failure',sequence:2,business_source_id:'source-during',item_changes:[{operation:'acquired',item_instance_id:'item-during',item_id:'component',item_kind:'tank_component',quantity:1,state:'pending_activation'}]}]});
  assert.equal(upload.status,503);
  assert.equal(upload.body.data,undefined);
  assert.equal(upload.body.data?.accepted_record_ids,undefined);
  note('upload_stays_503_without_ack');
  const wrong=await req(`/v1/parent/devices/${pub}/dashboard`,await jwt({accountId:'wrong-owner',role:'parent'},true));
  assert.equal(wrong.status,404);
  note('wrong_owner_stays_404_during_records_failure');
  const overlayZero={...r,yesterday_income:{...r.yesterday_income,family_coin:0}};
  assert.equal(contract.DashboardRecordsSchema.safeParse(overlayZero).success,false);
  note('schema_rejects_fabricated_zero_income');
 }finally{db.exec('ALTER TABLE ark_record_unavailable RENAME TO ark_record');}
 const count=Number(db.prepare('SELECT COUNT(*) n FROM ark_record WHERE sn=?').get(sn)!.n);
 assert.equal(count,1);
 const recovered=await req(`/v1/parent/devices/${pub}/dashboard`,parent);
 assert.equal(recovered.status,200);
 assert.equal(recovered.body.data.ark.wallets.family_coin,7);
 assert.equal(recovered.body.data.records.yesterday_income.reason,'policy_pending');
 const retry=await req('/v1/device/ark/records:batch',token,{schema_version:1,batch_id:'retry',records:[{...rec,record_id:'during-failure',sequence:2,business_source_id:'source-during',item_changes:[{operation:'acquired',item_instance_id:'item-during',item_id:'component',item_kind:'tank_component',quantity:1,state:'pending_activation'}]}]});
 assert.equal(retry.status,200);
 assert.deepEqual(retry.body.data.accepted_record_ids,['during-failure']);
 assert.equal(Number(db.prepare('SELECT COUNT(*) n FROM ark_record WHERE sn=?').get(sn)!.n),2);
 note('recovery_retries_original_id_without_losing_committed_row');
 db.exec('ALTER TABLE ark_current RENAME TO ark_current_unavailable');
 try{
  const arkFail=await req(`/v1/parent/devices/${pub}/dashboard`,parent);
  assert.equal(arkFail.status,503);
  note('legacy_ark_current_failure_still_503');
 }finally{db.exec('ALTER TABLE ark_current_unavailable RENAME TO ark_current');}
 console.log(JSON.stringify({ok:true,isolated_dir:root,checks}));
}finally{
 db.close();
 await new Promise<void>(r=>serverHttp.close(()=>r()));
}
