// Copy unchanged into a fixed, private server archive's scripts/ before running.
// Uses synthetic identities and local HTTP only; never send these fixtures to production.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
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

test('patched Rust projection → real local HTTP → SQLite → proxy → answer',async t=>{
 const fixtures=JSON.parse(readFileSync(process.env.ARK_WALLET_FIXTURES_IN!, 'utf8'));
 assert.deepEqual(Object.keys(fixtures).sort(),['gm','nonzero','null','unknown','zero']);
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
 const sample=(name:string)=>({schema_version:1,snapshot_id:'rust-'+(++seq),boot_id:'rust-boot',boot_started_at_ms:bootStartedAt,captured_at_ms:Date.now(),sequence:seq,content_version:'synthetic-v376-patch',...fixtures[name]});
 const send=(body:unknown)=>fetch(origin+'/ark/state',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});
 try{
  for(const name of ['zero','nonzero','null','gm','unknown'])await t.test('real Rust '+name+' retains semantics and authority',async()=>{
   const body=sample(name),res=await send(body);assert.equal(res.status,200);const receipt=await res.json();assert.equal(receipt.status,'accepted');
   assert.deepEqual(store.current(identity)!.snapshot,body);
   const facts=(await proxy.context(sn)).facts_v1!;assert.ok(facts);
   const expected=name==='zero'?0:name==='nonzero'?7:null;
   assert.equal(facts.assets.family_coin?.value??null,expected);
   assert.equal(facts.assets.stardust?.value??null,name==='zero'?0:name==='nonzero'?13:null);
   const answer=answerArk('我有多少家族币',facts)!;
   if(expected===null)assert.match(answer,/查不到/);else assert.match(answer,new RegExp('余额是'+expected+'枚'));
   if(name==='gm'||name==='unknown')assert.equal(facts.progress,null);
   // The Rust fixture's logical day is intentionally preserved. Fresh transport
   // timestamps do not make a previous-day game progress current.
   if(body.logical_day!==cstDay(Date.now()))assert.equal(facts.progress,null);
   const dupe=await(await send(body)).json();assert.equal(dupe.status,'duplicate');assert.equal(dupe.received_at_ms,receipt.received_at_ms);
   const saved=store.current(identity);store.close();store=new ArkStore(join(dir,'ark.db'));runtime=createRuntime();assert.deepEqual(store.current(identity),saved);
   assert.deepEqual((await proxy.context(sn)).facts_v1,facts);
  });
  await t.test('normal restart accepts zero after GM; binding epoch still isolates old save',async()=>{
   assert.equal((await send(sample('gm'))).status,200);assert.equal((await proxy.context(sn)).facts_v1!.assets.family_coin,null);
   assert.equal((await send(sample('zero'))).status,200);assert.equal(identity.epoch,1);
   assert.equal((await proxy.context(sn)).facts_v1!.assets.family_coin!.value,0);
   assert.equal((await proxy.context(other)).prompt,'');
   identity={...identity,epoch:2};assert.equal(store.current(identity),null);assert.equal((await send(sample('zero'))).status,403);
  });
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));store.close();rmSync(dir,{recursive:true,force:true});}
});
