/** Synthetic loopback HTTP + isolated SQLite, never production. */
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
const root=mkdtempSync(join(tmpdir(),'miniapp-admin-'));process.chdir(root);
// Redirect inherited DB overrides too: transitive admin stores must remain isolated.
for(const key of Object.keys(process.env))if(key.endsWith('_DB_PATH'))process.env[key]=join(root,key+'.db');
for(const key of ['TELEMETRY','DEVICES','ACCOUNTS','PROFILE','ARK','CONFIG','PAIRING','BLE_BINDINGS','CONVERSATION','OTA'])process.env[`${key}_DB_PATH`]=join(root,`${key}.db`);
process.env.AUTH_JWT_SECRET='isolated-admin-test';process.env.ARK_CONTEXT_SN_ALLOW='';process.env.ARK_RECORDS_SN_ALLOW='';process.env.ARK_RECORDS_MIN_FREE_BYTES='1';
process.env.STUDIO_USER='test-admin';process.env.STUDIO_PASS='test-password';process.env.STUDIO_EDITOR_USERS='test-editor';process.env.STUDIO_EDITOR_PASS='editor-password';
delete process.env.PARENT_CONVERSATION_SCOPE_JSON;delete process.env.ARK_RECORDS_LEGACY_SCOPE_JSON;
const {Hono}=await import('hono');const {serve}=await import('@hono/node-server');const {SignJWT}=await import('jose');
const {parentTelemetryRoute}=await import('../src/routes/telemetry.js');const {authRoute}=await import('../src/routes/auth.js');
const {miniappAdminRoute}=await import('../src/routes/miniapp-admin.js');
const {adminDataRoute}=await import('../src/routes/admin-data.js');
const {deviceRegistryStore:registry}=await import('../src/device-registry-store.js');const {accountStore}=await import('../src/account-store.js');
const {telemetryStore,dayOf}=await import('../src/telemetry-store.js');const {arkStore}=await import('../src/ark/service.js');
const {recordsStore}=await import('../src/ark/records-service.js');const {RecordSchema}=await import('../src/ark/records-contract.js');const {LegacyRecordSchema}=await import('../src/ark/records-legacy.js');
const {configStore}=await import('../src/config-store.js');const {otaStore}=await import('../src/ota-store.js');await import('../src/conversation-store.js');
const app=new Hono();app.route('/auth',authRoute);app.route('/api/admin',adminDataRoute);app.route('/api/admin-child',miniappAdminRoute);app.route('/v1/parent/devices',parentTelemetryRoute);
const server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:0});await new Promise<void>(r=>server.listening?r():server.once('listening',r));const base=`http://127.0.0.1:${(server.address() as any).port}`;
const accounts=new DatabaseSync(process.env.ACCOUNTS_DB_PATH!),devices=new DatabaseSync(process.env.DEVICES_DB_PATH!),conversations=new DatabaseSync(process.env.CONVERSATION_DB_PATH!);
after(async()=>{accounts.close();devices.close();conversations.close();await new Promise<void>(r=>server.close(()=>r()));});console.log(`ISOLATED_EVIDENCE_DIR=${root}`);
async function req(path:string,token='',body?:unknown){const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...(token?{authorization:`Bearer ${token}`} : {}),'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const text=await r.text();let value:any;try{value=JSON.parse(text);}catch{value={raw:text};}return {status:r.status,headers:r.headers,body:value};}
const admin=(await req('/auth/login','',{username:'test-admin',password:'test-password'})).body.token;
const editor=(await req('/auth/login','',{username:'test-editor',password:'editor-password'})).body.token;
const guest=(await req('/auth/login','',{username:'guest',password:'123456'})).body.token;
let serial=0;
async function fixture(){const sn=`BJP003260601${String(++serial).padStart(8,'0')}`,owner=`test-parent-${serial}`;accounts.prepare("INSERT INTO account(id,nickname,role,created_at,phone) VALUES(?,'test','parent',?,?)").run(owner,Date.now(),'138'+String(serial).padStart(8,'0'));registry.add(sn,'test');registry.setParentAccountId(sn,owner);registry.setAccountId(sn,accountStore.createDeviceAccount(sn,'test').id);const dev=registry.get(sn)!;process.env.ARK_CONTEXT_SN_ALLOW+=`,${sn}`;process.env.ARK_RECORDS_SN_ALLOW+=`,${sn}`;arkStore().authorize(registry.arkIdentity(sn)!,Date.now()-86400000*7);const grant=arkStore().grant(registry.arkIdentity(sn)!)!;const scope={sn,public_id:dev.public_id!,parent_account_id:owner,account_id:dev.account_id!,binding_version:dev.binding_version,epoch:grant.epoch};process.env.PARENT_CONVERSATION_SCOPE_JSON=JSON.stringify(scope);const parent=await new SignJWT({accountId:owner,role:'parent'}).setProtectedHeader({alg:'HS256'}).setIssuer('p003').setAudience('kidshub').setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(process.env.AUTH_JWT_SECRET));return {sn,owner,pub:dev.public_id!,account:dev.account_id!,parent,grant,scope};}
type F=Awaited<ReturnType<typeof fixture>>;
const dash=(f:F,token=admin)=>req(`/api/admin/devices/${f.sn}/miniapp/dashboard`,token);
const page=(f:F,kind='records',q='',token=admin)=>req(`/api/admin/devices/${f.sn}/miniapp/${kind}${q}`,token);
function message(f:F,id:string,ts:number){conversations.prepare("INSERT INTO conversation(id,account_id,session_id,role,text,ts,tokens,memory_excluded) VALUES(?,?,'test','user','isolated text',?,0,0)").run(id,f.account,ts);}
function insertRecord(f:F,id:string,sequence:number){const store=recordsStore(),credential={sn:f.sn,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600},identity=store.preflight(credential,[]);const record=RecordSchema.parse({record_id:id,save_id:'save',sequence,origin_grant_id:f.grant.grant_id,origin_epoch:f.grant.epoch,occurred_at_ms:Date.now()-1000,time_quality:'reported',logical_day:dayOf(Date.now()),source_mode:'normal',reason:'reward_claim',business_source_id:id,tank_id:null,stage_id:null,resource_changes:[{resource_id:'family_coin',delta:2,before:0,after:2}],item_changes:[]});assert.equal(store.accept(credential,identity,record),'accepted');}
function snapshot(f:F,mode='normal'){const now=Date.now();arkStore().accept(registry.arkIdentity(f.sn)!,{schema_version:1,snapshot_id:'snapshot-'+mode,boot_id:'boot',boot_started_at_ms:now-60000,sequence:mode==='normal'?1:2,captured_at_ms:now,logical_day:dayOf(now),config_revision:'rules',content_version:'content',source_mode:mode,wallets:{family_coin:0,stardust:null},inventory:{'M-CARD-001':0},progress:{timer_state:'unknown',next_reward:{status:'unknown',kind:'unknown',item_id:null,stage_id:null,remaining_seconds:null},claimable_count:null}} as any,now);}

test('all detail endpoints enforce admin authorization and no-store on denied responses',async()=>{const f=await fixture();for(const kind of ['dashboard','records','conversations'])for(const [token,status] of [['',401],['invalid',401],[editor,403],[guest,403],[f.parent,401]] as const){const r=kind==='dashboard'?await dash(f,token):await page(f,kind,'',token);assert.equal(r.status,status,kind);assert.equal(r.headers.get('cache-control'),'no-store');}});
test('admin and parent DTO equality; valid zero, missing null, normal assets and no invented record count',async()=>{const realNow=Date.now,fixed=realNow();Date.now=()=>fixed;try{const f=await fixture();snapshot(f);const now=Date.now();telemetryStore.ingestEvent(f.sn,{event_id:'short',type:'focus_segment',occurred_at_ms:now,data:{start_ms:now-1000,end_ms:now}},{schemaVersion:1,deviceTsMs:now,serverReceivedMs:now,traceId:''});insertRecord(f,'reward',1);message(f,'equal-message',now);const a=await dash(f),p=await req(`/v1/parent/devices/${f.pub}/dashboard`,f.parent);assert.equal(a.status,200,JSON.stringify(a.body));assert.deepEqual(a.body.data,p.body.data);assert.equal(a.body.data.usage.today.focus_minutes,0);assert.equal(a.body.data.usage.daily[0].focus_minutes,null);assert.equal(a.body.data.ark.wallets.family_coin,0);assert.equal(a.body.data.ark.wallets.stardust,null);assert.equal(a.body.data.conversations.message_count,1);assert.equal('count' in a.body.data.records,false);assert.equal(a.body.binding.parent_phone,'138'+String(serial).padStart(8,'0'));assert.equal(a.headers.get('cache-control'),'no-store');assert.ok(!JSON.stringify(a.body).includes(f.grant.grant_id));}finally{Date.now=realNow;}});
test('metadata uses real config and last OTA self-report, never private status payload',async()=>{const f=await fixture();let d=await dash(f);assert.equal(d.status,200);assert.equal(d.body.integration.reported_version.reason,'no_report');assert.equal(d.body.integration.reported_version.version_code,null);configStore.setValue(f.sn,'ark_records.enabled',true);otaStore.reportCheck(f.sn,901,'test-v901','{"token":"must-not-escape"}');d=await dash(f);assert.equal(d.body.integration.upload_config.ark_records.configured_enabled,true);assert.equal(d.body.integration.upload_config.ark_records.effective_enabled,false);assert.equal(d.body.integration.reported_version.version_code,901);assert.ok(!JSON.stringify(d.body).includes('must-not-escape'));});
test('unbound and invalid parent role return explicit identity-only state',async()=>{const f=await fixture();message(f,'private',1);registry.setParentAccountId(f.sn,null);let r=await dash(f);assert.equal(r.status,200);assert.equal(r.body.data,null);assert.equal(r.body.reason,'unbound');assert.equal(r.body.binding.parent_phone,null);assert.equal((await page(f)).status,404);registry.setParentAccountId(f.sn,f.account);r=await dash(f);assert.equal(r.body.data,null);assert.equal(r.body.reason,'parent_account_invalid');assert.equal((await page(f,'conversations')).status,404);});
test('GM and unknown snapshots preserve reported facts while normal-only assets remain unavailable',async()=>{for(const mode of ['gm','unknown']){const f=await fixture();snapshot(f,mode);const r=await dash(f);assert.equal(r.status,200);assert.equal(r.body.data.ark.reason,'non_normal');assert.equal(r.body.data.ark.wallets.family_coin,null);const reported=r.body.data.ark.reported_state;assert.equal(reported.source_mode,mode);assert.equal(reported.wallets.family_coin,0);assert.equal(reported.wallets.stardust,null);assert.equal(reported.inventory['M-CARD-001'],0);assert.equal(reported.logical_day,dayOf(Date.now()));assert.equal(reported.progress.timer_state,'unknown');assert.equal(reported.progress.next_reward.remaining_seconds,null);assert.ok(reported.received_at_ms>0);const parent=await req(`/v1/parent/devices/${f.pub}/dashboard`,f.parent);assert.equal(parent.status,200);assert.deepEqual(parent.body.data.ark,r.body.data.ark);registry.setParentAccountId(f.sn,null);assert.equal((await req(`/v1/parent/devices/${f.pub}/dashboard`,f.parent)).status,404);assert.equal((await dash(f)).body.data,null);}});
test('baseline remains baseline without fabricated income or acquisition',async()=>{const f=await fixture();process.env.ARK_RECORDS_LEGACY_SCOPE_JSON=JSON.stringify({...f.scope,grant_id:f.grant.grant_id,save_ids:'*'});const runtime=JSON.parse(readFileSync(new URL('./fixtures/ark-records-mini009-runtime.json',import.meta.url),'utf8'));const raw=LegacyRecordSchema.parse(runtime.records[0]),store=recordsStore(),credential={sn:f.sn,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600},scope=store.preflightLegacy(credential,raw.save_id);assert.equal(store.acceptLegacy(credential,scope,{save_id:raw.save_id,coverage_from_ms:Date.now()-1000,dropped_records:0},raw),'accepted');const r=await dash(f);assert.equal(r.status,200);assert.equal(r.body.data.records.yesterday_income.family_coin,null);assert.equal(r.body.data.records.latest_items.available,false);const p=await page(f);assert.equal(p.status,200);assert.ok(p.body.data.items[0].baseline);assert.deepEqual(p.body.data.items[0].resource_changes,[]);assert.equal('count' in p.body.data,false);});
test('records preserve filters, paging DTO and 400/410 cursors; unbinding denies old cursor',async()=>{const f=await fixture();insertRecord(f,'first',1);insertRecord(f,'second',2);const r=await page(f,'records','?limit=1&resource_id=family_coin');assert.equal(r.status,200);assert.equal(r.body.data.items.length,1);assert.equal(r.body.data.has_more,true);assert.equal('count' in r.body.data,false);const cursor=r.body.data.next_cursor,p=await req(`/v1/parent/devices/${f.pub}/ark/records?limit=1&resource_id=family_coin`,f.parent);assert.deepEqual(r.body.data.items,p.body.data.items);assert.equal((await page(f,'records','?save_id=other')).body.data.items.length,0);assert.equal((await page(f,'records','?limit=1&limit=2')).status,400);assert.equal((await page(f,'records','?cursor=bogus')).status,400);const real=Date.now;Date.now=()=>real()+1800001;try{assert.equal((await page(f,'records','?limit=1&resource_id=family_coin&cursor='+cursor)).status,410);}finally{Date.now=real;}registry.setParentAccountId(f.sn,null);assert.equal((await page(f,'records','?cursor='+cursor)).status,404);});
test('conversation date filters, counts, cursors match parent without parent token signing',async()=>{const f=await fixture(),day=Date.parse('2026-11-16T00:00:00+08:00');message(f,'chat-one',day);message(f,'chat-two',day+1000);message(f,'chat-old',day-1);const q='?limit=1&from_day=2026-11-16&to_day=2026-11-16',r=await page(f,'conversations',q);assert.equal(r.status,200);assert.equal(r.body.data.message_count,2);assert.equal(r.body.data.items[0].id,'chat-two');const p=await req(`/v1/parent/devices/${f.pub}/conversations${q}`,f.parent);assert.deepEqual(r.body.data.items,p.body.data.items);const next=await page(f,'conversations',q+'&cursor='+r.body.data.next_cursor);assert.equal(next.body.data.items[0].id,'chat-one');assert.equal(next.body.data.has_more,false);const real=Date.now;Date.now=()=>real()+1800001;try{assert.equal((await page(f,'conversations',q+'&cursor='+r.body.data.next_cursor)).status,410);}finally{Date.now=real;}assert.equal((await page(f,'conversations','?limit=51')).status,400);});
test('mid-read authority changes discard aggregate after real second-connection writes',async()=>{for(const mutation of ['owner','binding','epoch','role','grant','enabled']){const f=await fixture();snapshot(f);assert.equal((await dash(f)).status,200);const original=telemetryStore.usageRange.bind(telemetryStore);let once=false;telemetryStore.usageRange=(...args:Parameters<typeof original>)=>{const result=original(...args);if(!once){once=true;if(mutation==='owner'){devices.prepare("UPDATE device_registry SET parent_account_id='other' WHERE sn=?").run(f.sn);devices.prepare('UPDATE device_registry SET parent_account_id=? WHERE sn=?').run(f.owner,f.sn);}if(mutation==='binding')devices.prepare('UPDATE device_registry SET binding_version=binding_version+1 WHERE sn=?').run(f.sn);if(mutation==='epoch')devices.prepare('UPDATE ark_device_epoch SET epoch=epoch+1 WHERE sn=?').run(f.sn);if(mutation==='role')accounts.prepare("UPDATE account SET role='device' WHERE id=?").run(f.owner);if(mutation==='grant'){const other=new DatabaseSync(process.env.ARK_DB_PATH!);try{other.prepare("UPDATE ark_grant SET grant_id='replaced' WHERE sn=?").run(f.sn);}finally{other.close();}}if(mutation==='enabled')arkStore().db.exec('UPDATE ark_settings SET enabled=0');}return result;};try{const r=await dash(f);assert.equal(r.status,404,mutation+': '+JSON.stringify(r.body));assert.equal(r.body.data,undefined);assert.ok(!JSON.stringify(r.body).includes('wallets'));}finally{telemetryStore.usageRange=original;}}});

// Catches a rebind after all telemetry/Ark reads but while the independent conversation snapshot is open.
test('admin discards ABA aggregate during conversation read while parent keeps legacy domain degradation',async()=>{
 const f=await fixture();message(f,'late-private',1000);assert.equal((await dash(f)).status,200);
 const original=DatabaseSync.prototype.prepare;let fired=false;
 DatabaseSync.prototype.prepare=function(sql:string){
  const statement=original.call(this,sql);
  if(sql.startsWith('SELECT rowid water,id anchor FROM conversation')){
   const get=statement.get.bind(statement);
   statement.get=(...args:any[])=>{if(!fired){fired=true;registry.setParentAccountId(f.sn,'different-owner');registry.setParentAccountId(f.sn,f.owner);}return get(...args);};
  }
  return statement;
 };
 try{const r=await dash(f);assert.equal(fired,true);assert.equal(r.status,404);assert.equal(r.body.data,undefined);}
 finally{DatabaseSync.prototype.prepare=original;}
 const parent=await req(`/v1/parent/devices/${f.pub}/dashboard`,f.parent);
 assert.equal(parent.status,200);assert.equal(parent.body.data.conversations.reason,'not_enabled');
});
test('unopened Brain and disabled device retain identity; unknown device and timezone stay explicit',async()=>{
 const f=await fixture();registry.setAccountId(f.sn,null);const r=await dash(f);
 assert.equal(r.status,200);assert.equal(r.body.binding.brain_opened,false);assert.equal(r.body.data.ark.available,false);
 registry.setStatus(f.sn,'disabled');const disabled=await dash(f);assert.equal(disabled.status,200);assert.equal(disabled.body.binding.status,'disabled');
 assert.equal((await req(`/api/admin/devices/${f.sn}/miniapp/dashboard?timezone=UTC`,admin)).status,400);
 assert.equal((await dash({...f,sn:'missing'})).status,404);
});

test('authority change between binding header lookup and aggregate guard cannot return a stale header or invalid parent',async()=>{
 for(const mutation of ['binding-header','owner-role']){
  const f=await fixture();const original=accountStore.findAccount.bind(accountStore);let reads=0;
  accountStore.findAccount=(id:string)=>{const value=original(id);if(id===f.owner&&++reads===(mutation==='binding-header'?1:2)){
   if(mutation==='binding-header'){registry.setParentAccountId(f.sn,'different');registry.setParentAccountId(f.sn,f.owner);}
   else accounts.prepare("UPDATE account SET role='device' WHERE id=?").run(f.owner);
  }return value;};
  try{const r=await dash(f);assert.equal(r.status,404,mutation);assert.equal(r.body.data,undefined);}
  finally{accountStore.findAccount=original;}
 }
});

// Outer auth middleware must also mark early rejections no-store.
test('actual adminDataRoute and independently mounted child both enforce admin-only no-store',async()=>{
 const f=await fixture();
 for(const prefix of ['/api/admin','/api/admin-child'])for(const [token,status] of [['',401],[editor,403],[admin,200]] as const){
  const r=await req(`${prefix}/devices/${f.sn}/miniapp/dashboard`,token);
  assert.equal(r.status,status,prefix);assert.equal(r.headers.get('cache-control'),'no-store');
 }
});

// Catches losing the conversation scope's unique Brain-account condition after its own final check.
test('admin aggregate rejects a shared Brain account introduced after domain authorization',async()=>{
 const f=await fixture();message(f,'unique-brain-private',1000);
 const other='BJP00326060199999991';registry.add(other,'test');
 const before=await dash(f);assert.equal(before.status,200);
 assert.equal(before.body.data.conversations.available,true);assert.equal(before.body.data.conversations.message_count,1);
 const original=otaStore.listDeviceStatus.bind(otaStore);let fired=false;
 otaStore.listDeviceStatus=()=>{
  const result=original();
  if(!fired){fired=true;devices.prepare('UPDATE device_registry SET account_id=? WHERE sn=?').run(f.account,other);}
  return result;
 };
 try{
  const r=await dash(f);assert.equal(fired,true,'the independent SQLite writer must run after the domain read');
  assert.equal((await req(`/v1/parent/devices/${f.pub}/conversations`,f.parent)).status,404);
  assert.equal(r.status,404);assert.equal(r.body.data,undefined);
  assert.ok(!JSON.stringify(r.body).includes('unique-brain-private'));
 }finally{otaStore.listDeviceStatus=original;}
});

test('deployed route contract exposes shared historical usage and admin verified identity state',async()=>{
 const f=await fixture();
 const a=await dash(f),p=await req(`/v1/parent/devices/${f.pub}/dashboard`,f.parent);
 assert.equal(a.status,200);assert.equal(p.status,200);
 assert.ok(a.body.data.historical_usage,'admin must call enriched async reader');
 assert.ok(p.body.data.historical_usage,'parent must call the same enriched reader');
 assert.ok(a.body.data.observations,'historical observations must have an explicit availability state');
 assert.ok(a.body.wechat_identity,'identity must be returned from the account store');
 assert.equal(a.body.wechat_identity.openid,null,'no synthetic identity for SMS accounts');
 assert.equal(a.body.wechat_identity.unionid,null);
});

test('observations routes enforce auth, scope and request validation',async()=>{
 const f=await fixture();
 for(const [token,status] of [['',401],[editor,403]] as const){
  const r=await page(f,'observations','',token);assert.equal(r.status,status);assert.equal(r.headers.get('cache-control'),'no-store');
 }
 const parentMissing=await req(`/v1/parent/devices/missing/observations`,f.parent);assert.equal(parentMissing.status,404);
 const invalid=await page(f,'observations','?limit=5000');assert.equal(invalid.status,400,'route must be mounted and reject invalid limit before upstream work');
});
