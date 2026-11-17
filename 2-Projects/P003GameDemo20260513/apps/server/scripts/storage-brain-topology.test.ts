import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,realpathSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {fork} from 'node:child_process';
import {serve} from '@hono/node-server';
import {SignJWT} from 'jose';
import {ArkStore} from '../src/ark/store.js';
import {unknownHistory} from '../src/ark/contracts.js';
import {startSharedQuery} from './storage-shared-query-client.js';
import {startArkProducer} from './storage-ark-producer.js';

test('mixed harness writes Ark in the existing Brain child, independent of a blocked Analytics loop',async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'p003-t5-brain-topology-'))),secret='a'.repeat(64),now=Date.now();
 const identity={sn:'BJP00399999900000001',account_id:'t5-synthetic-0',epoch:1};
 writeFileSync(join(root,'config.json'),JSON.stringify({synthetic:true,continuous_ark:true,devices:1,receiver_pid:process.pid}));
 const ark=new ArkStore(join(root,'ark.db'));ark.authorize(identity,now-1000);
 const receiver=serve({hostname:'127.0.0.1',port:0,fetch:r=>Promise.resolve(Response.json(new URL(r.url).pathname==='/ready'?{ready:true}:unknownHistory()))});
 if(!receiver.listening)await once(receiver,'listening');
 let service:Awaited<ReturnType<typeof startSharedQuery>>|undefined,probe:ReturnType<typeof fork>|undefined;
 try{
  service=await startSharedQuery(root,'http://127.0.0.1:'+(receiver.address()as any).port,secret);
  assert.equal(service.brainPid,service.child.pid);assert.notEqual(service.brainPid,process.pid);
  assert.match(service.arkUrl,/^http:\/\/127\.0\.0\.1:\d+\/t5\/ark\/state$/);
  const token=await new SignJWT({kind:'p003-device'}).setSubject(identity.sn).setProtectedHeader({alg:'HS256'}).setIssuedAt().setExpirationTime('1m').sign(new TextEncoder().encode(secret));
  const sample=JSON.parse(readFileSync(new URL('../../../docs/ark-brain-20261031/snapshot-v1.example.json',import.meta.url),'utf8'));
  const body={...sample,snapshot_id:'topology-1',boot_id:'topology',boot_started_at_ms:now-1,captured_at_ms:now,sequence:1};
  const probePath=join(root,'probe.mjs');
  writeFileSync(probePath,`process.on('message',async m=>{try{const r=await fetch(m.url,{method:'POST',headers:{authorization:'Bearer '+m.token,'content-type':'application/json'},body:JSON.stringify(m.body),signal:AbortSignal.timeout(2000)});process.send({at:Date.now(),status:r.status,pid:Number(r.headers.get('X-T5-Brain-Pid')),body:await r.json()});}catch(e){process.send({error:String(e)});}process.disconnect();});process.send({ready:true});`);
  probe=fork(probePath,[],{execArgv:[],stdio:['ignore','ignore','pipe','ipc']});
  await once(probe,'message');const received=once(probe,'message');
  probe.send({url:service.arkUrl,token,body});
  // Block ONLY the process hosting the Analytics socket. The real HTTP client
  // and Brain socket must finish independently; no synthetic success response.
  const blockedAt=Date.now();Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,600);const resumedAt=Date.now();
  const [result]=await received;assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.body.status,'accepted');
  assert.equal(result.pid,service.brainPid);assert(result.at>=blockedAt&&result.at<resumedAt,'Ark HTTP must complete while Analytics is blocked');
  assert.equal(ark.current(identity)?.snapshot.snapshot_id,body.snapshot_id);
  const replay=await fetch(service.arkUrl,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await replay.json()).status,'duplicate');assert.equal(ark.db.prepare('SELECT count(*) n FROM ark_archive_outbox').get()!.n,1);
  // The load-generating client must also keep working while Analytics is busy.
  let rounds=0;const producer=startArkProducer({root,url:service.arkUrl,brainPid:service.brainPid,tokens:[token],startedMs:Date.now(),durationMs:300,intervalMs:1000},n=>{rounds=n;});
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,600);const clientResumedAt=Date.now();await producer.promise;
  const record=JSON.parse(readFileSync(join(root,'ark-continuous.jsonl'),'utf8').trim());
  assert.equal(rounds,1);assert.equal(record.status,200);assert.equal(record.brain_pid,service.brainPid);assert.equal(record.producer_thread,true);
  assert(record.at_ms+record.ms<clientResumedAt,'device-side producer measurement must exclude the blocked Analytics event loop');
  assert.equal(ark.db.prepare('SELECT count(*) n FROM ark_archive_outbox').get()!.n,2);
 }catch(error){if(existsSync(join(root,'shared-query.stderr')))console.error(readFileSync(join(root,'shared-query.stderr'),'utf8'));throw error;}finally{
  probe?.kill('SIGTERM');await service?.stop();receiver.closeAllConnections();await new Promise<void>(r=>receiver.close(()=>r()));ark.close();rmSync(root,{recursive:true,force:true});
 }
});
