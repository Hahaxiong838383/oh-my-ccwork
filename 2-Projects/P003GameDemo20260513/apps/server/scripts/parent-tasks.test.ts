import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { test } from 'node:test';

const dir=mkdtempSync(join(tmpdir(),'p003-tasks-'));
process.chdir(dir);
for (const k of Object.keys(process.env)) if (k.endsWith('_DB_PATH')) delete process.env[k];
for (const k of ['ACCOUNTS','DEVICES','TELEMETRY','ARK','PARENT_TASKS']) process.env[k+'_DB_PATH']=join(dir,k+'.db');
process.env.AUTH_JWT_SECRET='integration-test-local-only';
delete process.env.PARENT_CONVERSATION_SCOPE_JSON;
const { accountStore }=await import('../src/account-store.js');
const { deviceRegistryStore:registry }=await import('../src/device-registry-store.js');
const { inviteAuthRoute }=await import('../src/routes/invite-auth.js');
const { parentTasksRoute }=await import('../src/routes/parent-tasks.js');
const { telemetryStore }=await import('../src/telemetry-store.js');
const { taskStore, TaskStore }=await import('../src/parent-tasks/store.js');
const { taskScopeForDevice }=await import('../src/parent-tasks/scope.js');
const { arkStore }=await import('../src/ark/service.js');
const app=new Hono().route('/auth',inviteAuthRoute).route('/v1/parent/devices',parentTasksRoute);
const now=Date.parse('2026-11-18T15:00:00+08:00');
const hour=3600000, day=24*hour;
async function fixture(suffix:string, trustedHistory=true) {
  const sn='BJP00326081002'+suffix.padStart(6,'0'), owner=accountStore.createInvite('QA parent');
  registry.add(sn,'QA'); registry.setParentAccountId(sn,owner.account_id); registry.setAccountId(sn,accountStore.createDeviceAccount(sn,'QA terminal').id);
  const d=registry.get(sn)!;
  if(trustedHistory)process.env.PARENT_CONVERSATION_SCOPE_JSON=JSON.stringify({public_id:d.public_id,sn,
    parent_account_id:owner.account_id,account_id:d.account_id,binding_version:d.binding_version,epoch:registry.arkIdentity(sn)!.epoch});
  const session=await app.request('/auth/invite',{method:'POST',body:JSON.stringify({code:owner.code})});
  const token=(await session.json() as any).token;
  const path='/v1/parent/devices/'+d.public_id+'/tasks';
  async function call(method:string,url=path,body?:unknown,key?:string,bearer=token) {
    const res=await app.request(url,{method,headers:{'content-type':'application/json',authorization:'Bearer '+bearer,...(key?{'Idempotency-Key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:res.status,body:await res.json() as any};
  }
  return {sn,owner,path,call,token,scope:taskScopeForDevice(sn)!};
}
function focus(sn:string,id:string,start:number,end:number,received=end) {
  return telemetryStore.ingestEvent(sn,{event_id:id,type:'focus_segment',occurred_at_ms:end,data:{start_ms:start,end_ms:end}},
    {schemaVersion:1,deviceTsMs:received,serverReceivedMs:received,traceId:'test'});
}
function snap(snapshot_id:string,captured_at_ms:number,sequence:number,coins:number) {
  return {schema_version:1 as const,snapshot_id,boot_id:'test-boot',boot_started_at_ms:now-hour,sequence,
    captured_at_ms,logical_day:'2026-11-18',config_revision:'qa',content_version:'qa',source_mode:'normal' as const,
    wallets:{family_coin:coins,stardust:0},inventory:{'M-CARD-001':0},progress:{timer_state:'paused' as const,
    next_reward:{status:'unknown' as const,kind:'unknown' as const,item_id:null,stage_id:null,remaining_seconds:null},claimable_count:null}};
}
test('6 个家长路由、按期确认及独立钱包到账、真实快照乱序',async()=>{
  const f=await fixture('5');
  const other=accountStore.createInvite('QA other');
  const login=await app.request('/auth/invite',{method:'POST',body:JSON.stringify({code:other.code})});
  const otherToken=(await login.json() as any).token;
  const localNow=Date.now;
  Date.now=()=>now;
  try {
    process.env.ARK_CONTEXT_SN_ALLOW=f.sn;
    const ark=arkStore(),identity=registry.arkIdentity(f.sn)!;
    ark.authorize(identity,now-hour);
    ark.accept(identity,snap('qa100',now-1000,1,100),now);
    assert.equal((await f.call('GET',f.path,undefined,undefined,'')).status,401);
    const denied=await f.call('GET',f.path,undefined,undefined,otherToken);
    assert.equal(denied.status,404); assert.equal(denied.body.reason,'resource_not_found');
    const empty=await f.call('GET',f.path+'?view=active&limit=20');
    assert.equal(empty.status,200);assert.deepEqual(empty.body.data,{items:[],wallet:{family_coin:100,snapshot_id:'qa100',sync_state:'synced'},next_cursor:null});
    const req={template:'daily_reading',goal_minutes:20,reward_coins:35,repeat:'once',description:'阅读'};
    const begin=now-30*60000;
    assert.equal(focus(f.sn,'first',begin,begin+19*60_000),'accepted');
    assert.equal(focus(f.sn,'first',begin,begin+19*60_000),'duplicated');
    const created=await f.call('POST',f.path,req,'create');
    assert.equal(created.status,200,JSON.stringify(created));
    const item=created.body.data.item, path=f.path+'/'+item.task_id, detail=path+'?occurrence_id='+item.occurrence_id;
    const confirm=path+'/occurrences/'+item.occurrence_id+'/confirm';
    assert.equal(item.progress.usage_seconds,1140);
    assert.deepEqual((await f.call('POST',f.path,req,'create')).body,created.body);
    assert.equal((await f.call('POST',f.path,{...req,goal_minutes:19},'create')).status,409);
    assert.equal((await f.call('POST',confirm,{},'early')).body.reason,'occurrence_not_eligible');
    const edit={occurrence_id:item.occurrence_id,expected_definition_version:1,description:null};
    assert.equal((await f.call('PATCH',path,edit,'edit')).body.data.item.definition_version,2);
    assert.equal((await f.call('PATCH',path,edit,'stale')).body.reason,'definition_version_mismatch');
    assert.equal(focus(f.sn,'extra',begin+19*60000,begin+20*60000),'accepted');
    const ready=(await f.call('GET',detail)).body.data;
    assert.deepEqual(ready.item.actions,['confirm']); assert.equal(ready.wallet.family_coin,100);
    assert.equal((await f.call('DELETE',detail+'&expected_definition_version=2',undefined,'delete')).body.reason,'occurrence_locked');
    assert.equal((await f.call('POST',confirm,{amount:35},'inject')).status,400);
    const [one,two]=await Promise.all([f.call('POST',confirm,{},'a'),f.call('POST',confirm,{},'b')]);
    assert.equal(one.status,200); const payment=one.body.data;
    assert.deepEqual(payment,two.body.data); assert.equal(payment.state,'pending_payment');assert.equal(payment.amount,35);
    const store=taskStore();
    store.transaction(()=>assert.ok(store.recordPaid(f.scope,item.task_id,item.occurrence_id,payment.settlement_id,'qa135',now)));
    assert.equal((await f.call('GET',detail)).body.data.wallet.sync_state,'syncing');
    ark.accept(identity,snap('qa135',now,2,135),now);
    // A later real transaction overwrites ark_current before the parent reads again.
    ark.accept(identity,snap('qa140',now+100,3,140),now+100);
    const latest=(await f.call('GET',detail)).body.data;
    assert.equal(latest.item.state,'paid');assert.deepEqual(latest.wallet,{family_coin:140,snapshot_id:'qa140',sync_state:'synced'});
    assert.deepEqual((await f.call('GET',f.path+'?view=history')).body.data.items.map((i:any)=>i.settlement_id),[payment.settlement_id]);
    const restarted=new TaskStore(process.env.PARENT_TASKS_DB_PATH!);
    assert.equal(restarted.item(f.scope,item.task_id,item.occurrence_id).settlement_id,payment.settlement_id);restarted.db.close();
    registry.setParentAccountId(f.sn,other.account_id);
    assert.equal((await f.call('GET',detail)).status,404);
    assert.equal((await f.call('GET',detail,undefined,undefined,otherToken)).status,404);
  } finally {Date.now=localNow;}
});
test('删除后补传，两个任务可各自核算，跨期老规则保持，换绑不继承证据',async()=>{
  const f=await fixture('6'), store=taskStore();
  const run=<T>(t:number,fn:()=>T)=>store.transaction(()=>{store.refresh(f.scope,t);return fn();});
  const rule={template:'daily_reading',repeat:'once',goal_minutes:30,reward_coins:10};
  focus(f.sn,'a',now-hour,now-hour+28*60000);
  const first=run(now,()=>store.create(f.scope,rule,now)).item;
  run(now,()=>store.remove(f.scope,first.task_id,first.occurrence_id,1,now));
  const second=run(now+1,()=>store.create(f.scope,rule,now+1)).item;
  focus(f.sn,'late',now-10*60000,now-5*60000,now+day);
  const items=run(now+day,()=>store.allItems(f.scope));
  for(const i of items){assert.equal(i.progress.usage_seconds,1980);assert.equal(i.state,'awaiting_confirmation');}
  const refs=[first,second].map(i=>run(now+day,()=>store.confirm(f.scope,i.task_id,i.occurrence_id)).settlement_id);
  assert.notEqual(refs[0],refs[1]);
  const old=run(now,()=>store.create(f.scope,{template:'weekly_usage',required_days:1,reward_coins:150},now)).item;
  assert.equal(old.state,'awaiting_confirmation');
  const next=run(now+7*day,()=>store.allItems(f.scope)).find(i=>i.task_id===old.task_id&&i.state==='active')!;
  run(now+7*day,()=>store.edit(f.scope,next.task_id,next.occurrence_id,1,{reward_coins:95},now+7*day));
  assert.equal(store.item(f.scope,old.task_id,old.occurrence_id).reward_coins,150);
  assert.equal(store.item(f.scope,next.task_id,next.occurrence_id).rule_version,2);
  const g=await fixture('7',false);
  focus(g.sn,'foreign-history',now-day,now-day+hour,now);
  const fresh=store.transaction(()=>store.create(g.scope,{template:'weekly_usage',required_days:1},now)).item;
  assert.equal(fresh.progress.received_usage,false);
});
