import assert from 'node:assert/strict';import {mkdtempSync,rmSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {once} from 'node:events';import {Worker} from 'node:worker_threads';
import {serve} from '@hono/node-server';import {SignJWT} from 'jose';import {ArkStore} from './src/ark/store.ts';import {createArkRoutes} from './src/ark/routes.ts';
const root=mkdtempSync(join(tmpdir(),'p003-t5-ark-lock-'));process.env.DEVICES_DB_PATH=join(root,'devices.db');const file=join(root,'ark.db');const i={sn:'BJP00399999999999901',account_id:'t5-isolated',epoch:1},now=Date.now(),secret='only-isolated-test';const store=new ArkStore(file,undefined,()=>({enabled:true,limitBytes:1e9,reserveBytes:0,freeBytes:1e12}));store.authorize(i,now-1000);
const errors=[],accept=store.accept.bind(store);store.accept=(...args)=>{try{return accept(...args)}catch(e){errors.push({code:e.code,sqlite_code:e.errcode,name:e.name});throw e}};
const route=createArkRoutes({store:()=>store,runtime:()=>({identity:()=>i}),secret:()=>secret,ceiling:()=>[i.sn],acceptsCredential:()=>true,isAdmin:()=>false});const server=serve({fetch:route.fetch,hostname:'127.0.0.1',port:0});if(!server.listening)await once(server,'listening');let worker;
try { const token=await new SignJWT({kind:'p003-device'}).setSubject(i.sn).setProtectedHeader({alg:'HS256'}).setIssuedAt().setExpirationTime('1m').sign(new TextEncoder().encode(secret));const sample=JSON.parse(readFileSync('../../docs/ark-brain-20261031/snapshot-v1.example.json','utf8'));const body={...sample,snapshot_id:'lock-1',boot_id:'lock-test',boot_started_at_ms:now-1,captured_at_ms:now,sequence:1};
const post=()=>fetch('http://127.0.0.1:'+server.address().port+'/state',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});
const warm=await post();assert.equal(warm.status,200);assert.equal((await warm.json()).status,'accepted');
const results=[];
for(const [held,sequence,expected]of [[250,2,503],[45,3,200]]){
 // Real asset changes must archive; changing only sequence is intentionally deduplicated.
 body.snapshot_id='physical-'+sequence;body.sequence=sequence;body.wallets={...body.wallets,family_coin:sequence};
 const errorsBefore=errors.length;
 worker=new Worker(`const {parentPort,workerData}=require('node:worker_threads');const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(workerData.file);db.exec('BEGIN IMMEDIATE');parentPort.postMessage('held');setTimeout(()=>{db.exec('ROLLBACK');db.close();parentPort.postMessage('released')},workerData.held)`,{eval:true,workerData:{file,held},execArgv:[]});await once(worker,'message');const exit=once(worker,'exit');const started=performance.now();const r=await post(),b=await r.json(),ms=performance.now()-started;
 assert.equal(r.status,expected);assert.ok(errors.length>errorsBefore,'must actually encounter SQLite BUSY');assert.ok(errors.slice(errorsBefore).every(e=>(e.sqlite_code&255)===5));
 if(expected===503){assert.equal(store.current(i).snapshot.sequence,1);assert.equal(store.db.prepare('SELECT count(*) n FROM ark_archive_outbox').get().n,1);}
 await exit;const retry=await post();assert.equal(retry.status,200);assert.equal((await retry.json()).status,expected===503?'accepted':'duplicate');assert.equal(store.db.prepare('SELECT count(*) n FROM ark_archive_outbox').get().n,sequence);
 results.push({held_ms:held,status:r.status,wall_ms:ms,sqlite_busy_attempts:errors.length-errorsBefore,records:sequence});
}
console.log(JSON.stringify({scope:'LINUX_SYNTHETIC_REAL_HTTP_AND_SQLITE_LOCKS_NOT_LOAD_PASS',node:process.version,sqlite:store.db.prepare('select sqlite_version() v').get().v,results}));
}finally {if(worker)await worker.terminate();server.closeAllConnections();await new Promise(r=>server.close(r));store.close();rmSync(root,{recursive:true,force:true})}
