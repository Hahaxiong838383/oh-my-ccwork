import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {once} from 'node:events';
import {serve} from '@hono/node-server';import {SignJWT} from 'jose';
import {ArkStore} from '../src/ark/store.js';import {createArkRoutes} from '../src/ark/routes.js';
import {retryArkBusy} from '../src/ark/busy-retry.js';

const busy=()=>Object.assign(new Error('database is locked'),{code:'ERR_SQLITE_ERROR',errcode:5});
async function fixture(){
 const root=mkdtempSync(join(tmpdir(),'ark-busy-http-'));process.env.DEVICES_DB_PATH=join(root,'devices.db');
 const now=Date.now(),original={sn:'BJP00399999999999901',account_id:'synthetic-busy',epoch:1},secret='only-isolated-test';
 let identity={...original},valid=true,calls=0,fail:()=>void=()=>{};
 const store=new ArkStore(join(root,'ark.db'),undefined,()=>({enabled:true,limitBytes:1e9,reserveBytes:0,freeBytes:1e12}));store.authorize(identity,now-1000);
 const accept=store.accept.bind(store);store.accept=(...args)=>{calls++;fail();return accept(...args);};
 const route=createArkRoutes({store:()=>store,runtime:()=>({identity:()=>identity} as any),secret:()=>secret,ceiling:()=>[original.sn],acceptsCredential:()=>valid,isAdmin:()=>false});
 const server=serve({fetch:route.fetch,hostname:'127.0.0.1',port:0});if(!server.listening)await once(server,'listening');
 const token=await new SignJWT({kind:'p003-device'}).setSubject(original.sn).setProtectedHeader({alg:'HS256'}).setIssuedAt().setExpirationTime('1m').sign(new TextEncoder().encode(secret));
 const base=JSON.parse(readFileSync(new URL('../../../docs/ark-brain-20261031/snapshot-v1.example.json',import.meta.url),'utf8'));
 const body={...base,snapshot_id:'retry-snapshot',boot_id:'retry-boot',boot_started_at_ms:now-1,captured_at_ms:now,sequence:1};
 return {store,original,body,calls:()=>calls,fail:(f:()=>void)=>{fail=f;},revoke:()=>{valid=false;},rebind:()=>{identity={...identity,account_id:'different-owner',epoch:2};},
  post:()=>fetch('http://127.0.0.1:'+(server.address() as any).port+'/state',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)}),
  count:()=>Number(store.db.prepare('SELECT count(*) n FROM ark_archive_outbox').get()!.n),
  async close(){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));store.close();rmSync(root,{recursive:true,force:true});}};
}
test('transient SQLite BUSY yields then accepts exactly one snapshot; same content stays duplicate',async()=>{
 const f=await fixture();try{f.fail(()=>{if(f.calls()===1)throw busy();});const r=await f.post();assert.equal(r.status,200);assert.equal((await r.json()).status,'accepted');assert.equal(f.calls(),2);assert.equal(f.count(),1);
  assert.equal((await(await f.post()).json()).status,'duplicate');assert.equal(f.count(),1);
 }finally{await f.close();}
});
test('persistent BUSY is bounded, does not create records, and remains a retryable failure',async()=>{
 const f=await fixture();try{f.fail(()=>{throw busy();});const r=await f.post();assert.equal(r.status,503);assert.equal((await r.json()).error,'ark_dependency_unavailable');assert.ok(f.calls()>=1&&f.calls()<=3);assert.equal(f.count(),0);assert.equal(f.store.current(f.original),null);
 }finally{await f.close();}
});
test('non-BUSY dependency failure is not retried',async()=>{
 const f=await fixture();try{f.fail(()=>{throw new Error('forced_non_busy');});assert.equal((await f.post()).status,503);assert.equal(f.calls(),1);assert.equal(f.count(),0);}finally{await f.close();}
});
test('a consumed retry budget never starts a fresh window',async()=>{
 let calls=0;await assert.rejects(retryArkBusy(async()=>{calls++;await new Promise(r=>setTimeout(r,90));throw busy();}));assert.equal(calls,1);
});
test('SQLite IO failure is never mistaken for BUSY',async()=>{
 let calls=0;await assert.rejects(retryArkBusy(async()=>{calls++;throw Object.assign(new Error('disk error'),{code:'ERR_SQLITE_ERROR',errcode:10});}));assert.equal(calls,1);
});
for(const change of ['credential','owner','grant'] as const)test('retry rechecks '+change+' after yielding, before another write',async()=>{
 const f=await fixture();try{f.fail(()=>{if(f.calls()===1){if(change==='credential')f.revoke();else if(change==='owner')f.rebind();else f.store.configure(false,[],Date.now());throw busy();}});
  const r=await f.post();assert.equal(r.status,change==='credential'?401:403);assert.equal(f.calls(),1);assert.equal(f.count(),0);
 }finally{await f.close();}
});
