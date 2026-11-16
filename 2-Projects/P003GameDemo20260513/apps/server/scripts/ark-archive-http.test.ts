import assert from 'node:assert/strict';import {test} from 'node:test';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {once} from 'node:events';
import {serve} from '@hono/node-server';import {SignJWT} from 'jose';
import {ArkStore} from '../src/ark/store.js';import {createArkRoutes} from '../src/ark/routes.js';
test('actual loopback HTTP: full archive returns 503 Retry-After, never ACKs or updates latest; disabled mode preserves contract',async()=>{
 const root=mkdtempSync(join(tmpdir(),'ark-archive-http-'));process.env.DEVICES_DB_PATH=join(root,'devices.db');
 const now=Date.now(),i={sn:'BJP00399999999999901',account_id:'synthetic-device',epoch:1},secret='isolated-secret';let enabled=true,limitBytes=1e7;
 const store=new ArkStore(join(root,'ark.db'),undefined,()=>({enabled,limitBytes,reserveBytes:0,freeBytes:1e12}));store.authorize(i,now-1000);
 const route=createArkRoutes({store:()=>store,runtime:()=>({identity:(sn:string)=>sn===i.sn?i:null} as any),secret:()=>secret,ceiling:()=>[i.sn],acceptsCredential:()=>true,isAdmin:()=>false});
 const server=serve({fetch:route.fetch,port:0,hostname:'127.0.0.1'});if(!server.listening)await once(server,'listening');
 try{
  const token=await new SignJWT({kind:'p003-device'}).setProtectedHeader({alg:'HS256'}).setSubject(i.sn).setIssuedAt().setExpirationTime('1m').sign(new TextEncoder().encode(secret));
  const base=JSON.parse(readFileSync(new URL('../../../docs/ark-brain-20261031/snapshot-v1.example.json',import.meta.url),'utf8'));
  const s={...base,snapshot_id:'s1',boot_id:'b1',boot_started_at_ms:now-1,captured_at_ms:now,sequence:1};
  const post=(body:any)=>fetch('http://127.0.0.1:'+(server.address() as any).port+'/state',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await (await post(s)).json()).status,'accepted');limitBytes=1;
  assert.equal((await (await post(s)).json()).status,'duplicate');const changed={...s,snapshot_id:'s2',sequence:2,wallets:{family_coin:777,stardust:3}};
  const r=await post(changed);assert.equal(r.status,503);assert.equal(r.headers.get('retry-after'),'60');assert.deepEqual(await r.json(),{ok:false,error:'archive_buffer_full'});assert.equal(store.current(i)?.snapshot.sequence,1);
  enabled=false;assert.equal((await (await post(changed)).json()).status,'accepted');assert.equal(store.current(i)?.snapshot.wallets.family_coin,777);assert.equal((store.db.prepare('SELECT count(*) n FROM ark_archive_outbox').get() as any).n,1);
 }finally{await new Promise<void>((r,e)=>server.close(x=>x?e(x):r()));store.close();rmSync(root,{recursive:true,force:true});}
});
