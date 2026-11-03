// Copy unchanged into a fixed, private server archive's scripts/ before running.
// Uses synthetic identities and local HTTP only; never send these fixtures to production.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {serve} from '@hono/node-server';
import {Hono} from 'hono';
import {SignJWT} from 'jose';
import {ArkStore} from '../src/ark/store.js';
import {ArkRuntime} from '../src/ark/runtime.js';
import {createArkRoutes} from '../src/ark/routes.js';
import {arkFactsRoute,ArkFactsProxy} from '../src/ark/proxy.js';
import {answerArk} from '../src/ark/answer.js';
import {cstDay} from '../src/ark/contracts.js';

test('v376 wallet contract: real local HTTP → durable store → authority → proxy → factual answer',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'v376-wallet-'));
 let store=new ArkStore(join(dir,'ark.db'));
 const sn='BJP00399999999999901',other='BJP00399999999999902';
 let identity={sn,account_id:'synthetic-v376',epoch:1};
 const secret='synthetic-credential',proxySecret='synthetic-proxy-'.repeat(3);
 const createRuntime=()=>new ArkRuntime({store,workerAccountId:'worker',readIdentity:s=>s===sn?identity:null,validAccount:a=>a===identity.account_id,internalUrl:'',internalSecret:''});
 let runtime=createRuntime();
 store.configure(true,[identity],Date.now()-1000);
 const app=new Hono();
 app.route('/ark',createArkRoutes({store:()=>store,runtime:()=>runtime,ceiling:()=>[sn],secret:()=>secret,acceptsCredential:()=>true,isAdmin:h=>h==='Bearer synthetic-admin'}));
 app.route('/internal/ark-facts',arkFactsRoute({secret:()=>proxySecret,allowed:()=>[sn],facts:s=>runtime.preview(s)}));
 const server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:0});
 if(!server.listening)await once(server,'listening');
 const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
 const proxy=new ArkFactsProxy({url:origin,secret:proxySecret,allowed:()=>[sn]});
 const token=await new SignJWT({kind:'p003-device'}).setProtectedHeader({alg:'HS256'}).setSubject(sn).setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode(secret));
 let seq=0;const bootStartedAt=Date.now()-60000;
 const sample=(family:number|null,star:number|null,source='normal')=>{
  const now=Date.now();return {schema_version:1,snapshot_id:'synthetic-'+(++seq),boot_id:'synthetic-boot',boot_started_at_ms:bootStartedAt,captured_at_ms:now,sequence:seq,logical_day:cstDay(now),content_version:'synthetic-v376',config_revision:'synthetic-rules',source_mode:source,wallets:{family_coin:family,stardust:star},inventory:{'M-CARD-001':1},progress:{timer_state:'paused',claimable_count:0,next_reward:{status:'locked',kind:'chest',item_id:null,stage_id:'FIRST-03',remaining_seconds:300}}};
 };
 const send=(body:unknown)=>fetch(origin+'/ark/state',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});
 try{
  await t.test('normal null remains unknown; card 1 and paused chest remain independently available',async()=>{
   const res=await send(sample(null,null));assert.equal(res.status,200);assert.equal((await res.json()).status,'accepted');
   assert.deepEqual(store.current(identity)!.snapshot.wallets,{family_coin:null,stardust:null});
   const read=await proxy.context(sn),facts=read.facts_v1!;assert.ok(facts);assert.equal(facts.assets.family_coin,null);assert.equal(facts.assets.stardust,null);assert.equal(facts.assets.makeup_card!.value,1);
   assert.equal(answerArk('我有多少家族币',facts),'家族币余额我暂时查不到，可以看设备上的资源页面。');
   assert.match(answerArk('我有多少星尘',facts)!,/查不到/);assert.match(answerArk('我有几张补勤卡',facts)!,/1张/);
   const answer=answerArk('下一个宝箱还要多久',facts)!;assert.match(answer,/暂停.*宝箱.*5分钟有效使用时间/);assert.doesNotMatch(answer,/自动到账|下一项是家族币/);
   assert.match(answerArk('下一个宝箱还要多久',facts,[],Date.now()+30001)!,/查不到/);
   const preview=await(await fetch(origin+'/ark/admin/preview?sn='+sn,{headers:{authorization:'Bearer synthetic-admin'}})).json();assert.deepEqual(preview.facts_v1,facts);
  });
  await t.test('authoritative zero persists, answers zero, duplicate does not refresh freshness',async()=>{
   const s=sample(0,0),first=await(await send(s)).json();assert.equal(first.status,'accepted');
   const duplicate=await(await send(s)).json();assert.equal(duplicate.status,'duplicate');assert.equal(duplicate.received_at_ms,first.received_at_ms);
   const f=(await proxy.context(sn)).facts_v1!;assert.equal(f.assets.family_coin!.value,0);assert.equal(f.assets.stardust!.value,0);assert.match(answerArk('我有多少家族币',f)!,/余额是0枚/);
  });
  await t.test('nonzero values are exact; no conversion to daily earnings',async()=>{
   assert.equal((await send(sample(7,13))).status,200);const f=(await proxy.context(sn)).facts_v1!;
   assert.match(answerArk('我有多少家族币',f)!,/7枚/);assert.match(answerArk('我有多少星尘',f)!,/余额是13/);assert.match(answerArk('我今天赚了多少家族币',f)!,/不能把钱包余额/);
  });
  await t.test('GM → fresh normal reset cannot leak GM balances or replace identity epoch',async()=>{
   const epoch=identity.epoch;assert.equal((await send(sample(999,888,'gm'))).status,200);
   const gm=(await proxy.context(sn)).facts_v1!;assert.equal(gm.assets.family_coin,null);assert.equal(gm.progress,null);
   assert.equal((await send(sample(0,0))).status,200);assert.equal(identity.epoch,epoch);
   assert.equal((await proxy.context(sn)).facts_v1!.assets.family_coin!.value,0);
  });
  await t.test('missing, stringified null and negative wallet fields are rejected rather than coerced',async()=>{
   for(const wallet of [{stardust:null},{family_coin:'null',stardust:null},{family_coin:-1,stardust:null}])assert.equal((await send({...sample(null,null),wallets:wallet})).status,400);
   assert.equal(store.current(identity)!.snapshot.wallets.family_coin,0);
  });
  await t.test('restart preserves exact accepted wallet and timestamp; rebinding epoch denies old grant',async()=>{
   const saved=store.current(identity);store.close();store=new ArkStore(join(dir,'ark.db'));runtime=createRuntime();assert.deepEqual(store.current(identity),saved);
   assert.equal((await proxy.context(sn)).facts_v1!.assets.family_coin!.value,0);
   assert.equal((await proxy.context(other)).prompt,'');
   identity={...identity,epoch:identity.epoch+1};assert.equal(store.current(identity),null);assert.equal((await send(sample(0,0))).status,403);
  });
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));store.close();rmSync(dir,{recursive:true,force:true});}
});
