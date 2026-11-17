/** T5 evidence producer: real loopback HTTP, persistent outbox, real wall clock.
 * Transport fault/recovery is controlled separately; this cannot sign full T5.
 */
import assert from 'node:assert/strict';
import {appendFileSync,existsSync,mkdirSync,readFileSync,realpathSync,statfsSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {serve} from '@hono/node-server';
import {SignJWT} from 'jose';

const root=resolve(process.argv[2]??''),smoke=process.argv[3]==='smoke';
assert(root.includes('/p003-t5-')&&!root.includes('/server/data'));
assert(!existsSync(root),'new isolated directory required');
mkdirSync(root,{recursive:true,mode:0o700});assert.equal(realpathSync(root),root);
const devices=smoke?3:50,intervalMs=smoke?6000:50000,durationMs=smoke?7000:3660000;
const started=Date.now(),startedMono=performance.now(),config={synthetic:true,smoke,devices,intervalMs,durationMs,started_at_ms:started,
 scope:'REAL_HTTP_AND_PERSISTENT_OUTBOX_ONLY; transport evidence required separately'};
writeFileSync(join(root,'config.json'),JSON.stringify(config,null,2),{mode:0o600});
process.env.DEVICES_DB_PATH=join(root,'devices.db');
const [{ArkStore},{createArkRoutes}]=await Promise.all([import('../src/ark/store.js'),import('../src/ark/routes.js')]);
const ids=Array.from({length:devices},(_,i)=>({sn:'BJP003999999'+String(i+1).padStart(8,'0'),account_id:'t5-outage-'+i,epoch:1}));
const secret=randomBytes(32).toString('hex'),free=()=>{const s=statfsSync(root);return Number(s.bavail)*Number(s.bsize);};
const store=new ArkStore(join(root,'ark.db'),undefined,()=>({enabled:true,limitBytes:8*1024**3,reserveBytes:4.5*1024**3,freeBytes:free()}));
for(const id of ids)store.authorize(id,started-1000);
const app=createArkRoutes({store:()=>store,runtime:()=>({identity:(sn:string)=>ids.find(i=>i.sn===sn)??null}as any),
 secret:()=>secret,ceiling:()=>ids.map(i=>i.sn),acceptsCredential:()=>true,isAdmin:()=>false});
const server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:0});if(!server.listening)await once(server,'listening');
const url='http://127.0.0.1:'+(server.address()as any).port+'/state';
const tokens=await Promise.all(ids.map(i=>new SignJWT({kind:'p003-device'}).setSubject(i.sn).setProtectedHeader({alg:'HS256'}).setIssuedAt().setExpirationTime('3h').sign(new TextEncoder().encode(secret))));
const sample=JSON.parse(readFileSync(new URL('../../../docs/ark-brain-20261031/snapshot-v1.example.json',import.meta.url),'utf8'));
const spool=resolve(process.env.T5_OUTAGE_SPOOL??join(root,'spool'));
assert(spool===join(root,'spool')||spool==='/opt/p003/archive-t2-20261116/spool','only explicitly isolated gateway spool allowed');
let accepted=0,rounds=0;
async function exportCycle(){
 const began=Date.now(),p=spawn('python3',['scripts/storage-ark-export.py','--db',join(root,'ark.db'),'--root',spool],{stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);
 let killTimer:ReturnType<typeof setTimeout>|undefined;
 const timer=setTimeout(()=>{p.kill('SIGTERM');killTimer=setTimeout(()=>p.kill('SIGKILL'),5000);},30000);
 try{const [exit]=await once(p,'close');appendFileSync(join(root,'export.jsonl'),JSON.stringify({at_ms:began,done_ms:Date.now(),exit,stdout,stderr})+'\n');assert.equal(exit,0,'export failed; preserve pending records');}
 finally{clearTimeout(timer);clearTimeout(killTimer);}
}
try{
 for(let round=0;performance.now()-startedMono<durationMs;round++){
  const due=startedMono+round*intervalMs;
  if(performance.now()<due)await new Promise(r=>setTimeout(r,due-performance.now()));
  if(performance.now()-startedMono>=durationMs)break;
  assert(free()>=5*1024**3,'5GiB isolation guard');
  for(const [actor]of ids.entries()){
   const now=Date.now(),snapshot={...sample,snapshot_id:`outage-${started}-${actor}-${round}`,boot_id:`outage-${started}`,boot_started_at_ms:started-1,captured_at_ms:now,sequence:round+1,
    logical_day:new Date(now+8*3600000).toISOString().slice(0,10),source_mode:'normal',wallets:{family_coin:round+actor,stardust:null},inventory:{'M-CARD-001':actor%4}};
   const sent=performance.now(),r=await fetch(url,{method:'POST',headers:{authorization:'Bearer '+tokens[actor],'content-type':'application/json'},body:JSON.stringify(snapshot),signal:AbortSignal.timeout(5000)}),body=await r.json();
   appendFileSync(join(root,'http.jsonl'),JSON.stringify({at_ms:now,actor,round,snapshot_id:snapshot.snapshot_id,status:r.status,ms:performance.now()-sent,body})+'\n');
   assert.equal(r.status,200);assert.equal(body.status,'accepted');accepted++;
  }
  rounds++;await exportCycle();
  const stats=store.db.prepare('SELECT * FROM ark_archive_stats').get();
  appendFileSync(join(root,'progress.jsonl'),JSON.stringify({at_ms:Date.now(),rounds,accepted,free_bytes:free(),stats})+'\n');
 }
 // Stop producing; no synthetic ACK or manual outbox deletion is permitted.
 const rows=store.db.prepare('SELECT state,COUNT(*) n,SUM(record_count) records FROM ark_archive_batch GROUP BY state').all();
 const result={...config,finished_at_ms:Date.now(),elapsed_ms:performance.now()-startedMono,wall_elapsed_ms:Date.now()-started,rounds,accepted,batches:rows,
  pending:store.db.prepare('SELECT * FROM ark_archive_stats').get(),full_t5_pass:false,transport_recovery_pass:false};
 assert.equal(accepted,rounds*devices);assert(rounds>0);
 for(const [actor,id]of ids.entries()){assert.equal(store.current(id)?.snapshot.wallets.family_coin,rounds-1+actor);assert.equal(store.current(id)?.snapshot.wallets.stardust,null);}
 writeFileSync(join(root,'PRODUCER-RESULT.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 if(!smoke){
  const deadline=performance.now()+2*3600000;
  while(Number(store.db.prepare('SELECT pending_records FROM ark_archive_stats').get()!.pending_records)>0){
   assert(performance.now()<deadline,'isolated recovery supervision deadline; keep outbox for retry');
   assert(free()>=5*1024**3,'5GiB isolation guard');
   await exportCycle();
   const stats=store.db.prepare('SELECT * FROM ark_archive_stats').get();
   appendFileSync(join(root,'drain.jsonl'),JSON.stringify({at_ms:Date.now(),stats})+'\n');
   if(Number(stats!.pending_records)>0)await new Promise(r=>setTimeout(r,30000));
  }
  const completed=store.db.prepare("SELECT SUM(record_count) records,COUNT(*) batches FROM ark_archive_batch WHERE state='complete'").get();
  assert.equal(Number(completed!.records),accepted);
  writeFileSync(join(root,'RECOVERY-RESULT.json'),JSON.stringify({accepted,completed,finished_at_ms:Date.now(),source_pending:0,
   scope:'SOURCE_ACK_MAPPING_CLOSED; independently verify NAS payloads and actual transport outage',full_t5_pass:false},null,2));
 }
}finally{
 server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));store.close();
}
