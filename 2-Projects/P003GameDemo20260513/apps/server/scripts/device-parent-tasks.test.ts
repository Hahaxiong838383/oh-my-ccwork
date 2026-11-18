import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { SignJWT } from 'jose';

const root=mkdtempSync(join(tmpdir(),'parent-task-device-'));
process.chdir(root);
for(const key of Object.keys(process.env))if(key.endsWith('_DB_PATH'))process.env[key]=join(root,key+'.db');
const sn='BJP00326060199998888', save='save-test';
for(const key of ['TELEMETRY','DEVICES','ACCOUNTS','ARK','PARENT_TASKS'])process.env[key+'_DB_PATH']=join(root,key+'.db');
Object.assign(process.env,{AUTH_JWT_SECRET:'isolated-device-task-test',STUDIO_USER:'task-test',STUDIO_PASS:'test-only',
 ARK_RECORDS_SN_ALLOW:sn,ARK_CONTEXT_SN_ALLOW:sn,ARK_RECORDS_MIN_FREE_BYTES:'1',ARK_RECORDS_UPLOAD_PER_MINUTE:'1000'});
const {taskStore}=await import('../src/parent-tasks/store.js');
const {taskScopeForDevice}=await import('../src/parent-tasks/scope.js');
const {deviceTaskSync}=await import('../src/parent-tasks/device.js');
const {deviceParentTasksRoute}=await import('../src/routes/device-parent-tasks.js');
const {parentTasksRoute}=await import('../src/routes/parent-tasks.js');
const {miniappAdminRoute}=await import('../src/routes/miniapp-admin.js');
const {recordsParentRoute,recordsDeviceRoute,recordsStore}=await import('../src/ark/records-service.js');
const {authRoute}=await import('../src/routes/auth.js');
const {inviteAuthRoute}=await import('../src/routes/invite-auth.js');
const {accountStore}=await import('../src/account-store.js');
const {deviceRegistryStore:registry}=await import('../src/device-registry-store.js');
const {telemetryStore,dayOf}=await import('../src/telemetry-store.js');
const {arkStore}=await import('../src/ark/service.js');
const app=new Hono();
app.route('/auth',authRoute);app.route('/auth',inviteAuthRoute);
app.route('/v1/device/parent-tasks',deviceParentTasksRoute);app.route('/v1/parent/devices',parentTasksRoute);
app.route('/v1/parent/devices',recordsParentRoute);app.route('/v1/device/ark',recordsDeviceRoute);app.route('/api/admin',miniappAdminRoute);
async function request(path:string,token:string,body?:unknown,idempotency?:string){
 const response=await app.request(path,{method:body===undefined?'GET':'POST',
  headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{}),...(idempotency?{'Idempotency-Key':idempotency}:{})},
  ...(body===undefined?{}:{body:JSON.stringify(body)})});
 return {status:response.status,body:await response.json() as any};
}
test('real routes with temporary SQLite: 20min/35, normal save, consent, isolated receipts and both histories',async()=>{
 const parent=accountStore.createInvite('fixture parent');
 registry.add(sn,'fixture');registry.setParentAccountId(sn,parent.account_id);registry.setAccountId(sn,accountStore.createDeviceAccount(sn,'fixture device').id);
 const d=registry.get(sn)!,ident=registry.arkIdentity(sn)!,now=Date.now();
 const scope={sn,public_id:d.public_id!,parent_account_id:parent.account_id,account_id:d.account_id,binding_version:d.binding_version,epoch:ident.epoch};
 process.env.PARENT_CONVERSATION_SCOPE_JSON=JSON.stringify(scope);
 arkStore().authorize(ident,now-86400000);process.env.ARK_RECORDS_LEGACY_SCOPE_JSON=JSON.stringify({...scope,grant_id:arkStore().grant(ident)!.grant_id,save_ids:'*'});
 const p=(await request('/auth/invite','',{code:parent.code})).body.token;
 const a=(await request('/auth/login','',{username:'task-test',password:'test-only'})).body.token;
 const t=await new SignJWT({kind:'p003-device',sub:sn,binding_version:d.binding_version}).setProtectedHeader({alg:'HS256'}).setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(process.env.AUTH_JWT_SECRET));
 const P='/v1/parent/devices/'+d.public_id+'/tasks', D='/v1/device/parent-tasks', W='/api/admin/devices/'+sn+'/miniapp';
 const sync=(patch={})=>request(D+'/sync',t,{contract_version:'1.0',binding_version:d.binding_version,save_id:save,source_mode:'normal',client_version:'test',...patch});
 const receipts=(items:any[])=>request(D+'/receipts:batch',t,{contract_version:'1.0',receipts:items});
 const record=(r:any)=>request('/v1/device/ark/records:batch',t,{schema_version:1,contract_id:'p003-ark-records-r1',batch_id:'b'+r.record_id,save_id:r.save_id,
   coverage_from_ms:now-86400000,dropped_records:0,records:[r]});
 const base={occurred_at_ms:now-4000,logical_day:dayOf(now),source_mode:'normal',config_revision:'test',active_ecotank_id:null};
 const baseline=(saveId:string,at:number)=>({...base,occurred_at_ms:at,record_id:saveId+':1',sequence:1,save_id:saveId,
   record_kind:'baseline',data:{wallet:{'C-FAMILY-001':100},inventory:[],history_complete_before_baseline:false}});
 const snapshot=(id:string,seq:number,mode:'gm'|'normal',amount:number)=>{
  const capture=now-2000+10*seq;
  arkStore().accept(ident,{schema_version:1,snapshot_id:id,captured_at_ms:capture,boot_id:'boot',boot_started_at_ms:now-60000,sequence:seq,
   logical_day:dayOf(now),config_revision:'rules',content_version:'content',source_mode:mode,wallets:{family_coin:amount,stardust:null},inventory:{'M-CARD-001':null},
   progress:{timer_state:'unknown',next_reward:{status:'unknown',kind:'unknown',item_id:null,stage_id:null,remaining_seconds:null},claimable_count:null}},Date.now());
 };
 const usage=(id:string,start:number,end:number)=>{
  assert.equal(telemetryStore.ingestEvent(sn,{event_id:id,type:'focus_segment',occurred_at_ms:end,data:{start_ms:start,end_ms:end}},
   {schemaVersion:1,deviceTsMs:end,serverReceivedMs:now,traceId:'test'}),'accepted');
 };
 const legacy=await new SignJWT({kind:'p003-device',sub:sn}).setProtectedHeader({alg:'HS256'}).setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(process.env.AUTH_JWT_SECRET));
 const body={contract_version:'1.0' as const,binding_version:d.binding_version,save_id:save,source_mode:'normal' as const,client_version:'test'};
 const isolatedDevices=new DatabaseSync(process.env.DEVICES_DB_PATH!);
 isolatedDevices.prepare('UPDATE device_registry SET updated_at=? WHERE sn=?').run(now-60_000,sn);
 isolatedDevices.close();
 assert.equal((await request(D+'/sync',legacy,body)).status,200);
 assert.equal((await request(D+'/sync','',{})).status,401);
 assert.equal((await sync({contract_version:'0.9'})).status,426);
 assert.equal((await sync({binding_version:d.binding_version+1})).status,409);
 assert.deepEqual((await sync()).body.data.items,[]);
 usage('focus-a',now-1200000,now-60000);snapshot('balance100',1,'normal',100);
 const created=await request(P,p,{template:'daily_reading',repeat:'once',goal_minutes:20,reward_coins:35,sync_to_xiaoke:true,description:'parent only'},'create');
 assert.equal(created.status,200,JSON.stringify(created.body));
 const item=created.body.data.item;
 assert.equal(item.state,'active');assert.equal(item.progress.usage_seconds,1140);
 const first=(await sync()).body.data;assert.equal(first.items[0].description,null);assert.deepEqual(first.authorizations,[]);
 assert.deepEqual((await sync({since_cursor:first.sync_cursor})).body.data.items,[]);
 const common={task_id:item.task_id,occurrence_id:item.occurrence_id,binding_version:d.binding_version,save_id:save};
 const delivered={...common,kind:'task_received',receipt_id:'downloaded',definition_version:1};
 assert.deepEqual((await receipts([delivered])).body.data.accepted_receipt_ids,['downloaded']);
 usage('focus-b',now-60000,now);
 const ready=(await sync()).body.data;assert.equal(ready.items[0].state,'awaiting_confirmation');assert.deepEqual(ready.authorizations,[]);
 const confirm=P+'/'+item.task_id+'/occurrences/'+item.occurrence_id+'/confirm';
 const settled=(await request(confirm,p,{},'confirm')).body.data;
 assert.equal(settled.amount,35);assert.equal(settled.wallet.family_coin,100);
 assert.equal((await request(confirm,p,{},'confirm-again')).body.data.settlement_id,settled.settlement_id);
 assert.deepEqual((await sync()).body.data.authorizations,[],'missing save evidence');
 assert.equal((await record(baseline('old-save',now-8000))).status,200);
 assert.equal((await record(baseline(save,now-4000))).status,200);
 assert.equal(recordsStore().trustedTaskSave(sn,parent.account_id,'old-save'),false);
 assert.deepEqual((await sync({save_id:'old-save'})).body.data.authorizations,[]);
 snapshot('gm',2,'gm',999);assert.deepEqual((await sync()).body.data.authorizations,[],'newest snapshot is GM');
 snapshot('balance100-normal',3,'normal',100);
 const weekly=await request(P,p,{template:'weekly_usage',required_days:7},'weekly');
 assert.equal(weekly.status,200);
 const frozen=taskStore().transaction(()=>deviceTaskSync(taskStore(),taskScopeForDevice(sn)!,body,true,Date.now(),1));
 assert(frozen.next_cursor);
 const grant=(await sync()).body.data.authorizations[0];
 assert.equal(grant.settlement_id,settled.settlement_id);assert.equal(grant.amount,35);
 const time=Date.now(),recordId=save+':2';
 const paid={...common,kind:'wallet_applied',receipt_id:'paid',settlement_id:grant.settlement_id,amount:35,currency:'C-FAMILY-001',record_id:recordId,
   applied_at_ms:time,post_snapshot_id:'balance135'};
 const changes={wallet_changes:[{resource_id:'C-FAMILY-001',before:100,after:135,delta:35}],inventory_changes:[],makeup_grants:[],makeup_uses:[],previous_source_mode:'normal',
  grants:[{reward_instance_id:grant.settlement_id,source_kind:'parent_task',source_id:item.occurrence_id,logical_day:dayOf(now),config_revision:'test',granted_at_ms:time,status:'granted',
    resolved_rewards:[{kind:'currency',item_id:'C-FAMILY-001',quantity:35,tank_id:null,layer:null}]}]};
 const journal={...base,occurred_at_ms:time,record_id:recordId,sequence:2,save_id:save,record_kind:'business_commit',data:changes};
 assert.deepEqual((await record(journal)).body.data.accepted_record_ids,[recordId]);
 const views=async()=>(await Promise.all([request('/v1/parent/devices/'+d.public_id+'/ark/records?resource_id=family_coin',p),request(W+'/records?resource_id=family_coin',a)]))
  .map(r=>{assert.equal(r.status,200);return r.body.data.items.filter((i:any)=>i.settlement_id===grant.settlement_id)});
 for(const v of await views())assert.deepEqual(v,[]);
 const early=(await receipts([{...paid,applied_at_ms:0},{...paid,save_id:'old-save',receipt_id:'wrong'},{...paid,amount:40,receipt_id:'wrong2'}])).body.data;
 assert.equal(early.rejected.length,3);assert.deepEqual(early.accepted_receipt_ids,[]);
 const out=(await receipts([delivered,paid])).body.data;
 assert.equal((await sync({cursor:frozen.next_cursor})).status,409,'paid while a page was in flight');
 assert.deepEqual(out.accepted_receipt_ids,['paid']);assert.deepEqual(out.duplicated_receipt_ids,['downloaded']);
 for(const v of await views()){assert.equal(v.length,1);assert.equal(v[0].resource_changes[0].delta,35);assert.equal(v[0].source_id,item.occurrence_id);}
 assert.deepEqual((await record(journal)).body.data.duplicated_record_ids,[recordId]);
 assert.deepEqual((await receipts([paid,{...paid,receipt_id:'resend'}])).body.data.duplicated_receipt_ids,['paid','resend']);
 assert.equal((await request(W+'/parent-tasks',a)).body.data.audit.r1_state,'matched');
 assert.equal((await request(W+'/parent-tasks','')).status,401);
 const detail=P+'/'+item.task_id+'?occurrence_id='+item.occurrence_id;
 assert.equal((await request(detail,p)).body.data.wallet.sync_state,'syncing');
 snapshot('balance135',4,'normal',135);
 const done=(await request(detail,p)).body.data;
 assert.equal(done.item.state,'paid');assert.equal(done.wallet.family_coin,135);assert.equal(done.wallet.sync_state,'synced');
 assert.deepEqual((await sync()).body.data.authorizations,[]);
 registry.setParentAccountId(sn,accountStore.createInvite('new parent').account_id);
 const afterRebind=await request(D+'/sync',legacy,{...body,binding_version:registry.get(sn)!.binding_version});
 assert.equal(afterRebind.status,401);assert.equal(afterRebind.body.reason,'binding_credential_refresh_required');
});
